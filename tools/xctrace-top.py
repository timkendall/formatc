#!/usr/bin/env python3
"""Top functions and hottest instructions of a compiled scriptc binary, from Instruments' Time Profiler (macOS).

    xcrun xctrace record --template 'Time Profiler' --output /tmp/prof.trace --launch -- ./binary args...
    python3 tools/xctrace-top.py /tmp/prof.trace ./binary [function-name-suffix ...]

Without function names it prints the 25 functions with the most samples (1 ms each). With names (e.g. `Printer_printFlat`)
it prints their hottest addresses, which `objdump -d --no-show-raw-insn ./binary --start-address=0x... --stop-address=0x...`
shows (the stall is usually attributed to the instruction after the slow one).
"""
import collections
import re
import subprocess
import sys

trace, binary = sys.argv[1], sys.argv[2]
names = sys.argv[3:]
xml = subprocess.run(
    ["xcrun", "xctrace", "export", "--input", trace, "--xpath", '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'],
    capture_output=True, text=True).stdout
# Frames are defined once (`<frame id=.. name=.. addr=..>`) and referenced after (`<frame ref=..>`), also as the leaf of a
# later backtrace, so resolve references; counting only inline definitions drops ~20% of samples and most of the hottest
# leaves (`_tlv_get_addr` showed 0.2% instead of 13%).
frame_of = {m.group(1): (m.group(2), int(m.group(3), 16))
            for m in re.finditer(r'<frame id="(\d+)" name="([^"]*)" addr="(0x[0-9a-f]+)"', xml)}
stacks = {}
for m in re.finditer(r'<tagged-backtrace id="(\d+)">(.*?)</tagged-backtrace>', xml, re.S):
    stacks[m.group(1)] = [frame_of[i] for i in re.findall(r'<frame (?:id|ref)="(\d+)"', m.group(2)) if i in frame_of]
by_function = collections.Counter()
by_address = collections.Counter()
callers = collections.Counter()
for row in re.finditer(r"<row>(.*?)</row>", xml, re.S):
    m = re.search(r'<tagged-backtrace (?:id|ref)="(\d+)"', row.group(1))
    stack = stacks.get(m.group(1)) if m else None
    if stack:
        by_function[stack[0][0]] += 1
        by_address[stack[0]] += 1
        if stack[0][0] == "_tlv_get_addr" and len(stack) > 1:
            callers[stack[1][0]] += 1
m = re.search(r'name="%s"[^>]*load-addr="(0x[0-9a-f]+)"' % re.escape(binary.split("/")[-1]), xml)
load = int(m.group(1), 16) if m else 0
total = sum(by_function.values())
print(f"{total} samples")
if not names:
    for name, count in by_function.most_common(int(__import__("os").environ.get("TOPN", "25"))):
        print(f"{count:6d} {100 * count / total:5.1f}%  {name}")
    print("callers of _tlv_get_addr (thread-local globals in worker mode):")
    for name, count in callers.most_common(int(__import__("os").environ.get("TOPN", "25"))):
        print(f"{count:6d} {100 * count / total:5.1f}%  {name}")
for suffix in names:
    hot = sorted(((a, c) for (n, a), c in by_address.items() if n.endswith(suffix)), key=lambda t: -t[1])
    print(suffix, sum(c for _, c in hot), "samples")
    for a, c in hot[:15]:
        print(f"   {hex(a - load + 0x100000000)}  {c}")
