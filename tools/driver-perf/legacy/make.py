#!/usr/bin/env python3
"""Builds /tmp/legacy-tree: the driver as it was before the pipeline (walk with rounds of scan workers, sort by size, then
format with Job/Report), with identity formatters and FMT_FAKE_WORK. Build: (cd /tmp/legacy-tree && scriptc build src/main.ts -o /tmp/fmt-legacy)."""
import os, shutil, subprocess, sys
root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
out = "/tmp/legacy-tree"
subprocess.run(["node", root + "/tools/driver-perf/stubify.ts", out], check=True, stdout=subprocess.DEVNULL)
shutil.copy(root + "/tools/driver-perf/legacy/worker.ts", out + "/src/driver/worker.ts")
for f in ("pipe.ts", "pool.ts"):
    os.remove(out + "/src/driver/" + f)
p = out + "/src/driver/run.ts"
s = open(p).read()
s = s.replace('import * as w from "./worker.ts";\nimport * as pipe from "./pipe.ts";\nimport { Pool } from "./pool.ts";\n',
              'import { Worker } from "node:worker_threads";\nimport { publish } from "@scriptc/threads";\nimport * as w from "./worker.ts";\nimport { Job, Report } from "./worker.ts";\nimport type { WorkerInit } from "./worker.ts";\n')
# the pipelined expand goes: always the plain one
a = s.index("    const detail = isOxfmt")
b = s.index("    try {\n      if (isOxfmt) expanded = expandAsOxfmt")
s = s[:a] + s[b:]
a = s.index("      else if (pool !== null) {")
b = s.index("      } else expanded = await files.expand(")
s = s[:a] + "      else {\n        expanded = await files.expand(" + s[b + len("      } else expanded = await files.expand("):]
s = s.replace("(t: Target): void => this.prepare(configs, ignored, t), null, null);", "(t: Target): void => this.prepare(configs, ignored, t), null, null);\n      }", 1)
s = s.replace("  pool: Pool | null = null;\n  tooMany = false;\n", "")
# offer() uses Pool
a = s.index("  // Gives the pool a file")
b = s.index("  // The options of a file: its `setId`")
s = s[:a] + s[b:]
a = s.index('    tick("sort");')
b = s.index("    if (options.compareTo !== null) {\n      compare.print")
legacy = '''    // order: size descending
    const order: number[] = [];
    for (let i = 0; i < work.length; i++) if (workSet[i] >= 0) order.push(i);
    order.sort((a, b) => (expanded[work[b]].target as Target).size - (expanded[work[a]].target as Target).size);
    tick("sort");
    const jobPaths: string[] = [];
    const jobSets: number[] = [];
    const jobIndex: number[] = [];
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      jobPaths.push((expanded[work[i]].target as Target).path);
      jobSets.push(workSet[i]);
      jobIndex.push(work[i]);
    }
    const formatStart = performance.now();
    const writes = !onlyLooks && only === null ? true : !onlyLooks;
    const reports = await this.runWorkers(threads, jobPaths, jobSets, optionSets, writes, options.compareTo === null ? "" : options.compareTo, options.dumpTo === null ? "" : options.dumpTo);
    const formatting = performance.now() - formatStart;
    tick("workers");
    // fold the reports into `done`
    const compare = new CompareStats();
    for (let r = 0; r < reports.length; r++) {
      const rep = reports[r];
      for (let k = 0; k < rep.idx.length; k++) {
        const wi = rep.idx[k];
        const ex = jobIndex[wi];
        const d = done[ex];
        const code = rep.code[k];
        d.tookMs = rep.took[k];
        if (code === w.D_UNCHANGED) d.kind = DN_UNCHANGED;
        else if (code === w.D_DIFFERENT) {
          if (!onlyLooks && only !== null && only.isPartlyStaged((expanded[ex].target as Target).path)) d.kind = DN_PARTLY_STAGED;
          else d.kind = DN_DIFFERENT;
        } else if (code === w.D_FAILED) {
          d.kind = DN_FAILED;
          d.message = rep.message[k];
        } else if (code === w.D_COMPARE) {
          compare.add((expanded[ex].target as Target).path, rep.line[k], rep.message[k]);
          d.kind = DN_UNCHANGED;
        } else {
          d.kind = DN_REFUSED;
          if (code === w.D_REFUSED) {
            d.failure = F_SYNTAX;
            d.problem = new Problem(rep.message[k], rep.line[k], rep.column[k], rep.lineText[k]);
          } else if (code === w.D_UNREAD) {
            d.failure = F_UNREAD;
            d.problem = new Problem(rep.message[k], rep.line[k], rep.column[k], rep.lineText[k]);
          } else if (code === w.D_CHANGED) {
            d.failure = F_CHANGED;
            d.message = rep.message[k];
          } else d.failure = F_BUG;
        }
      }
    }
'''
s = s[:a] + legacy + s[b:]
tail = '''
  runWorkers(threads: number, jobPaths: string[], jobSets: number[], optionSets: OptionSet[], writes: boolean, compareTo: string, dumpTo: string): Promise<Report[]> {
    const reports: Report[] = [];
    const n = jobPaths.length;
    if (n === 0) return Promise.resolve(reports);
    const nthreads = Math.max(1, Math.min(threads, n));
    const job = publish(new Job(jobPaths, jobSets, optionSets, writes, 1, compareTo, this.cwd + "/", dumpTo));
    const ctrl = new SharedArrayBuffer(64);
    const cwd = this.cwd;
    return new Promise<Report[]>((resolve) => {
      let finished = 0;
      for (let i = 0; i < nthreads; i++) {
        const worker = (spawnWorker as (data: WorkerInit) => Worker)({ kind: 0, job: job, scan: null, ctrl: ctrl, id: i, cwd: cwd });
        worker.on("message", (m: WorkerMessage) => {
          const r = new Report();
          r.idx = m.idx;
          r.code = m.code;
          r.message = m.message;
          r.line = m.line;
          r.column = m.column;
          r.lineText = m.lineText;
          r.took = m.took;
          r.bytes = m.bytes;
          r.files = m.files;
          r.ms = m.ms;
          reports.push(r);
          finished = finished + 1;
          if (finished === nthreads) resolve(reports);
        });
      }
    });
  }
}

export let spawnWorker: ((data: WorkerInit) => Worker) | null = null;

export function setSpawnWorker(f: (data: WorkerInit) => Worker): void {
  spawnWorker = f;
}

export interface WorkerMessage {
  idx: number[];
  code: number[];
  message: string[];
  line: number[];
  column: number[];
  lineText: string[];
  took: number[];
  bytes: number;
  files: number;
  ms: number;
}
'''
# the Run class ends at the "}\n\nclass ByteBufHolder"
i = s.index("}\n\nclass ByteBufHolder")
s = s[:i] + tail.lstrip("\n").replace("\n  runWorkers", "\n  // Runs the workers\n  runWorkers", 1) + "\n" + s[i + 2:]
open(p, "w").write(s)
m = out + "/src/main.ts"
t = open(m).read()
t = t.replace('import { setSpawnWorker } from "./driver/pool.ts";', 'import { setSpawnWorker } from "./driver/run.ts";')
t = t.replace('{ kind: 1, scan: scan, ctrl: ctrl, bufs: null, id: 0, cwd: "", writes: false, detail: false, chunk: 1, compareTo: "", compareRoot: "", dumpTo: "" }', '{ kind: 1, job: null, scan: scan, ctrl: ctrl, id: 0, cwd: "" }')
open(m, "w").write(t)
print("legacy tree at", out)
