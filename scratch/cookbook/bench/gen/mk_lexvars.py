import sys
tmpl = r'''
function lexFree_NAME(src: Uint8Array, out: Int32Array): number {
  const n = DECLN;
  let pos DECLP = 0;
  let nt DECLP = 0;
  while (pos < n) {
    const c = IDX(pos);
    const k = CT[c];
    if (k === 1) { INC(pos); continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      INC(pos);
      while (pos < n && IDC[IDX(pos)] === 1) INC(pos);
      kind = 1;
    } else if (k === 3) {
      INC(pos);
      while (pos < n && (IDC[IDX(pos)] === 1 || IDX(pos) === 46)) INC(pos);
      kind = 2;
    } else if (k === 4) {
      INC(pos);
      while (pos < n && IDX(pos) !== c) { if (IDX(pos) === 92) INC(pos); INC(pos); }
      INC(pos);
      kind = 3;
    } else if (k === 5 && pos + 1 < n && IDX(pos + 1) === 47) {
      while (pos < n && IDX(pos) !== 10) INC(pos);
      kind = 4;
    } else if (k === 5 && pos + 1 < n && IDX(pos + 1) === 42) {
      pos = ADD2(pos);
      while (pos + 1 < n && !(IDX(pos) === 42 && IDX(pos + 1) === 47)) INC(pos);
      pos = ADD2(pos);
      kind = 4;
    } else {
      INC(pos);
      kind = 5;
    }
    const o = nt * 3;
    if (o + 2 < out.length) { out[o] = start; out[o + 1] = pos; out[o + 2] = kind; }
    INC(nt);
  }
  return nt;
}
'''
import re
def mk(name, declN, declP, inc, idx, add2):
    s = tmpl.replace("NAME", name).replace("DECLN", declN).replace("DECLP", declP)
    s = re.sub(r'INC\((\w+)\)', lambda m: inc.replace("$", m.group(1)), s)
    s = re.sub(r'ADD2\((\w+)\)', lambda m: add2.replace("$", m.group(1)), s)
    s = re.sub(r'IDX\(([^()]*)\)', lambda m: idx.replace("$", m.group(1)), s)
    return s
out = ['import type { Int32 } from "@scriptc/types";']
out.append(mk("plain", "src.length", "", "$++", "src[$]", "$ + 2"))
out.append(mk("or0", "src.length | 0", "", "$ = ($ + 1) | 0", "src[$]", "($ + 2) | 0"))
out.append(mk("idxor0", "src.length", "", "$++", "src[$ | 0]", "$ + 2"))
out.append(mk("int32", "src.length | 0", ": Int32", "$ = ($ + 1) | 0", "src[$]", "($ + 2) | 0"))
open("gen/lexvars.ts","w").write("\n".join(out))
