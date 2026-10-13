// Paths of the driver: absolute, `/`-separated, as strings (port of vendor/bun/src/lint/paths.rs, posix only).
// Only a root ends with a `/`.
import * as nodePath from "node:path";

export function isAbsolute(p: string): boolean {
  return p.length > 0 && p.charCodeAt(0) === 47;
}

// `path.resolve(base, p)`; `base` is absolute.
export function resolve(base: string, p: string): string {
  if (p.length > 0 && p.charCodeAt(0) === 47) {
    if (isNormal(p)) return p;
    return nodePath.posix.resolve(p);
  }
  return nodePath.posix.resolve(base, p);
}

// True for a path that `path.resolve` would return as it is.
function isNormal(p: string): boolean {
  const n = p.length;
  if (n === 1) return true;
  if (p.charCodeAt(n - 1) === 47) return false;
  let seg = 0; // chars in the current segment
  let dots = 0;
  for (let i = 1; i < n; i++) {
    const c = p.charCodeAt(i);
    if (c === 47) {
      if (seg === 0) return false;
      if (dots === seg && seg <= 2) return false;
      seg = 0;
      dots = 0;
    } else {
      seg = seg + 1;
      if (c === 46) dots = dots + 1;
    }
  }
  if (seg === 0) return false;
  if (dots === seg && seg <= 2) return false;
  return true;
}

// `dir/name`
export function join(dir: string, name: string): string {
  if (dir.length > 0 && dir.charCodeAt(dir.length - 1) === 47) return dir + name;
  return dir + "/" + name;
}

// What follows `dir/` in `p`, if `p` is inside `dir`. Both are resolved. `null` otherwise.
export function inside(dir: string, p: string): string | null {
  const n = dir.length;
  if (p.length < n) return null;
  if (!p.startsWith(dir)) return null;
  if (n > 0 && dir.charCodeAt(n - 1) === 47) return p.substring(n);
  if (p.length === n) return null;
  if (p.charCodeAt(n) !== 47) return null;
  return p.substring(n + 1);
}

export function isAtOrInside(outer: string, p: string): boolean {
  return outer === p || inside(outer, p) !== null;
}

// `path.relative(base, p)` of two resolved paths. Empty if they are the same.
export function relative(base: string, p: string): string {
  const rest = inside(base, p);
  if (rest !== null) return rest;
  if (base === p) return "";
  return nodePath.posix.relative(base, p);
}

// `path.dirname`. A root is its own directory.
export function dirname(p: string): string {
  const n = p.length;
  if (n === 0) return ".";
  let end = n;
  while (end > 1 && p.charCodeAt(end - 1) === 47) end = end - 1;
  let i = end - 1;
  while (i >= 0 && p.charCodeAt(i) !== 47) i = i - 1;
  if (i < 0) return ".";
  while (i > 0 && p.charCodeAt(i - 1) === 47) i = i - 1;
  if (i === 0) return "/";
  return p.substring(0, i);
}

// `path.basename`
export function basename(p: string): string {
  let end = p.length;
  while (end > 1 && p.charCodeAt(end - 1) === 47) end = end - 1;
  let i = end - 1;
  while (i >= 0 && p.charCodeAt(i) !== 47) i = i - 1;
  return p.substring(i + 1, end);
}

// `directory` and the directories it is in, up to the root, nearest first.
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  while (true) {
    out.push(cur);
    const parent = dirname(cur);
    if (parent.length >= cur.length) break;
    cur = parent;
  }
  return out;
}

// `/^\.\.(?:\/|$)/.test(relative)`
export function isExternal(rel: string): boolean {
  return rel === ".." || rel.startsWith("../");
}

export function lastIndexOfSlash(p: string): number {
  let i = p.length - 1;
  while (i >= 0 && p.charCodeAt(i) !== 47) i = i - 1;
  return i;
}
