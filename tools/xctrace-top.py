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
frames = {}
for m in re.finditer(r'<tagged-backtrace id="(\d+)">(?:<frame id="\d+" name="([^"]*)" addr="(0x[0-9a-f]+)">)', xml):
    frames[m.group(1)] = (m.group(2), int(m.group(3), 16))
by_function = collections.Counter()
by_address = collections.Counter()
for row in re.finditer(r"<row>(.*?)</row>", xml, re.S):
    r = row.group(1)
    m = re.search(r'<tagged-backtrace id="(\d+)">', r) or re.search(r'<tagged-backtrace ref="(\d+)"/>', r)
    frame = frames.get(m.group(1)) if m else None
    if frame:
        by_function[frame[0]] += 1
        by_address[frame] += 1
m = re.search(r'name="%s"[^>]*load-addr="(0x[0-9a-f]+)"' % re.escape(binary.split("/")[-1]), xml)
load = int(m.group(1), 16) if m else 0
total = sum(by_function.values())
print(f"{total} samples")
if not names:
    for name, count in by_function.most_common(25):
        print(f"{count:6d} {100 * count / total:5.1f}%  {name}")
for suffix in names:
    hot = sorted(((a, c) for (n, a), c in by_address.items() if n.endswith(suffix)), key=lambda t: -t[1])
    print(suffix, sum(c for _, c in hot), "samples")
    for a, c in hot[:15]:
        print(f"   {hex(a - load + 0x100000000)}  {c}")
