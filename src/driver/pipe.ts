// What the files have in common between the main process and the child processes (child.ts): the status of a file as the
// main process keeps it, and the text of an option set. Port of nothing: the Rust version shares memory between threads.
import { Resolved } from "./options.ts";

export const ST_NONE = 0;
export const ST_UNCHANGED = 1;
export const ST_DIFFERENT = 2;
// anything else: the report of the worker has the details
export const ST_OTHER = 3;

// ---- the text of an option set ----

function esc(s: string): string {
  if (s.indexOf("%") < 0 && s.indexOf("\u0001") < 0 && s.indexOf("\u0002") < 0) return s;
  return s.split("%").join("%25").split("\u0001").join("%01").split("\u0002").join("%02");
}

function unesc(s: string): string {
  if (s.indexOf("%") < 0) return s;
  return s.split("%01").join("\u0001").split("%02").join("\u0002").split("%25").join("%");
}

// `verifies` + the flags + "\u0001name\u0002value" for each option.
export function encodeSet(r: Resolved, verifies: boolean): string {
  let t = verifies ? "v" : "-";
  t += r.omitsFinalNewline ? "n" : "-";
  t += r.toml ? "t" : "-";
  t += r.isOxfmt ? "o" : "-";
  for (let i = 0; i < r.names.length; i++) t += "\u0001" + esc(r.names[i]) + "\u0002" + esc(r.values[i]);
  // The options about sorting imports (`Resolved.sortNames`): their names start with U+0004.
  for (let i = 0; i < r.sortNames.length; i++) t += "\u0001\u0004" + esc(r.sortNames[i]) + "\u0002" + esc(r.sortValues[i]);
  return t;
}

export let decodedVerifies = false;

export function decodeSet(t: string): Resolved {
  decodedVerifies = t.charCodeAt(0) === 118;
  const r = new Resolved();
  r.omitsFinalNewline = t.charCodeAt(1) === 110;
  r.toml = t.charCodeAt(2) === 116;
  r.isOxfmt = t.charCodeAt(3) === 111;
  const parts = t.split("\u0001");
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const at = p.indexOf("\u0002");
    if (p.charCodeAt(0) === 4) {
      r.sortNames.push(unesc(p.substring(1, at)));
      r.sortValues.push(unesc(p.substring(at + 1)));
    } else r.set(unesc(p.substring(0, at)), unesc(p.substring(at + 1)));
  }
  r.finish();
  return r;
}
