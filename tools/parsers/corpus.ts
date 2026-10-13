// Corpus loaders for the differential tests of the YAML and TOML parsers. Run with bun (the oracle is `Bun.YAML` /
// `Bun.TOML` / `bun fmt`).
import { readFileSync } from "node:fs";

export const ROOT = new URL("../../", import.meta.url).pathname;

export type Case = { name: string; bytes: Buffer };

// The files of bench/vscode with one of the extensions (the list /tmp/vscode-files.txt has relative paths, one per
// line, possibly with spaces).
export function vscodeFiles(exts: string[]): Case[] {
  const list = readFileSync("/tmp/vscode-files.txt", "latin1").split("\n").filter(l => l.length > 0);
  const out: Case[] = [];
  for (const rel of list) {
    if (!exts.some(e => rel.endsWith(e))) continue;
    out.push({ name: "vscode/" + rel, bytes: readFileSync(ROOT + "bench/vscode/" + rel) });
  }
  return out;
}

// /tmp/prettier-bundle.txt: `=== /<path> <length>\n`, the bytes, `\n`, one after the other.
export function prettierFiles(prefix: string, skip: (path: string) => boolean): Case[] {
  const bytes = readFileSync("/tmp/prettier-bundle.txt");
  const out: Case[] = [];
  for (let at = 0; at < bytes.length; ) {
    const end = bytes.indexOf(10, at);
    const header = bytes.toString("utf8", at + 4, end); // after "=== "
    const space = header.lastIndexOf(" ");
    const path = header.slice(0, space);
    const length = Number(header.slice(space + 1));
    if (path.startsWith(prefix) && !skip(path)) out.push({ name: "prettier" + path, bytes: Buffer.from(bytes.subarray(end + 1, end + 1 + length)) });
    at = end + 1 + length + 1;
  }
  return out;
}

// A small deterministic generator (xorshift32), so that a failing case can be reproduced by its seed.
export class Rng {
  s: number;
  constructor(seed: number) {
    this.s = seed | 0 || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return x >>> 0;
  }
  below(n: number): number {
    return this.next() % n;
  }
  pick<T>(a: T[]): T {
    return a[this.below(a.length)];
  }
}
