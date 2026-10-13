#!/usr/bin/env python3
"""Time Profiler trace -> per thread: busy ms and the hottest leaf functions.

    xcrun xctrace record --template 'Time Profiler' --output /tmp/p.trace --launch -- ./bin/fmt --check ...
    python3 tools/driver-perf/xctrace-threads.py /tmp/p.trace [top-n] [min-ms]
"""
import collections
import re
import subprocess
import sys

trace = sys.argv[1]
top = int(sys.argv[2]) if len(sys.argv) > 2 else 8
xml = subprocess.run(
    ["xcrun", "xctrace", "export", "--input", trace, "--xpath", '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'],
    capture_output=True, text=True).stdout
frames = {}
fnames = {}
threads = {}
per_thread = collections.defaultdict(collections.Counter)
near = collections.defaultdict(collections.Counter)
bt_frames = {}
total = collections.Counter()
first = {}
for row in re.finditer(r"<row>(.*?)</row>", xml, re.S):
    r = row.group(1)
    m = re.search(r'<thread id="(\d+)" fmt="([^"]*)"', r)
    if m:
        threads[m.group(1)] = m.group(2)
        tid = m.group(1)
    else:
        m = re.search(r'<thread ref="(\d+)"', r)
        tid = m.group(1) if m else "?"
    t = re.search(r'<sample-time id="\d+" fmt="[^"]*">(\d+)<', r)
    if t:
        ts = int(t.group(1)) / 1e6
        first.setdefault(tid, ts)
    for fm in re.finditer(r'<frame id="(\d+)" name="([^"]*)"', r):
        fnames[fm.group(1)] = fm.group(2)
    fr = re.search(r'<tagged-backtrace id="(\d+)">(?:<frame id="(\d+)"|<frame ref="(\d+)")', r)
    if fr:
        name = fnames.get(fr.group(2) or fr.group(3), "?")
        frames[fr.group(1)] = name
    else:
        fr = re.search(r'<tagged-backtrace ref="(\d+)"/>', r)
        name = frames.get(fr.group(1), "?") if fr else "?"
    # the nearest compiled-TypeScript frame of the stack (inclusive attribution of the leaf)
    bt = re.search(r'<tagged-backtrace id="(\d+)">(.*?)</tagged-backtrace>', r, re.S)
    if bt:
        names = []
        for fm in re.finditer(r'<frame (?:id="(\d+)" name="([^"]*)"|ref="(\d+)")', bt.group(2)):
            names.append(fm.group(2) if fm.group(1) else fnames.get(fm.group(3), "?"))
        bt_frames[bt.group(1)] = names
    else:
        rf = re.search(r'<tagged-backtrace ref="(\d+)"/>', r)
        names = bt_frames.get(rf.group(1), []) if rf else []
    owner = next((n for n in names if n.startswith("sc_")), "(none)")
    near[tid][owner] += 1
    per_thread[tid][name] += 1
    total[tid] += 1
for tid, n in total.most_common():
    label = threads.get(tid, tid)
    label = re.sub(r"\(fmt.*", "", label).strip()
    print(f"{label[:40]:40} {n:5d} ms busy")
    for name, c in per_thread[tid].most_common(top):
        print(f"      {c:5d}  {name[:90]}")
    print("      -- by nearest compiled function:")
    for name, c in near[tid].most_common(top):
        print(f"      {c:5d}  {name[:90]}")
