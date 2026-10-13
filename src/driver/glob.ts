// Glob patterns: a matcher for Bun's glob dialect (as `bun_glob` reads the patterns that the driver builds) and the
// conversions of vendor/bun/src/lint/glob.rs (picomatch / minimatch -> Bun's dialect).
//
// Dialect: `*` `?` `[..]` `**` (a whole segment) `{a,b}` `{1..3}` and the extglobs `@(a|b)` `?(..)` `*(..)` `+(..)` `!(..)`.
// A `\x` is the literal `x`. Dot files are matched by `*`; only the `.` and `..` segments never are.
// A pattern is matched against the whole `/`-separated path.

const T_LIT = 0;
const T_ANY1 = 1;
const T_STAR = 2;
const T_CLASS = 3;
const T_EXT = 4;

class Tok {
  kind: number;
  lit: string;
  // T_CLASS
  negated: boolean;
  ranges: number[]; // pairs lo, hi
  // T_EXT: the operator char code ('@', '?', '*', '+', '!') and the indices, in the pool of the segment, of the token lists
  // of its alternatives. (Not the lists themselves: a class that holds its own kind is not safe to share between threads.)
  op: number;
  altIdx: number[];
  constructor(kind: number) {
    this.kind = kind;
    this.lit = "";
    this.negated = false;
    this.ranges = [];
    this.op = 0;
    this.altIdx = [];
  }
}

class Seg {
  isGlobstar: boolean;
  toks: Tok[];
  // The token lists of the alternatives of the extglobs in `toks`.
  pool: Tok[][];
  // The segment is a plain literal: `lit` is its text.
  isLiteral: boolean;
  lit: string;
  constructor() {
    this.isGlobstar = false;
    this.toks = [];
    this.pool = [];
    this.isLiteral = false;
    this.lit = "";
  }
}

// Index after the `]` of the class that starts at `at`, or -1 if it is not closed.
export function classEnd(p: string, at: number): number {
  const n = p.length;
  let i = at + 1;
  if (i < n && (p.charCodeAt(i) === 33 || p.charCodeAt(i) === 94)) i = i + 1;
  if (i < n && p.charCodeAt(i) === 93) i = i + 1;
  while (i < n) {
    const c = p.charCodeAt(i);
    if (c === 92) {
      i = i + 2;
      continue;
    }
    if (c === 91 && i + 1 < n && p.charCodeAt(i + 1) === 58) {
      const close = p.indexOf(":]", i + 2);
      if (close >= 0) {
        i = close + 2;
        continue;
      }
    }
    if (c === 93) return i + 1;
    i = i + 1;
  }
  return -1;
}

// `{1..3}`, `{a..c}`, `{1..9..2}`: the text between the braces.
export function isSequence(inner: string): boolean {
  const parts = inner.split("..");
  if (parts.length < 2 || parts.length > 3) return false;
  const a = parts[0];
  const b = parts[1];
  const isNum = (s: string): boolean => /^-?[0-9]+$/.test(s);
  const isAlpha = (s: string): boolean => /^[A-Za-z]$/.test(s);
  if (parts.length === 3 && !isNum(parts[2])) return false;
  if (isNum(a) && isNum(b)) return true;
  if (isAlpha(a) && isAlpha(b)) return true;
  return false;
}

function expandSequence(inner: string): string[] | null {
  const parts = inner.split("..");
  const a = parts[0];
  const b = parts[1];
  let step = 1;
  if (parts.length === 3) step = Math.abs(parseInt(parts[2], 10));
  if (step === 0 || step !== step) return null;
  const out: string[] = [];
  if (/^-?[0-9]+$/.test(a)) {
    const lo = parseInt(a, 10);
    const hi = parseInt(b, 10);
    // fill-range pads to the longest end if either has a leading zero
    const pad = (a.length > 1 && (a.charCodeAt(0) === 48 || a.startsWith("-0"))) || (b.length > 1 && (b.charCodeAt(0) === 48 || b.startsWith("-0")));
    const width = Math.max(a.length, b.length);
    if (Math.abs(hi - lo) / step > 10000) return null;
    const fmt = (v: number): string => {
      let s = String(Math.abs(v));
      if (pad) {
        const w = width - (v < 0 ? 1 : 0);
        while (s.length < w) s = "0" + s;
      }
      return v < 0 ? "-" + s : s;
    };
    if (lo <= hi) {
      for (let v = lo; v <= hi; v += step) out.push(fmt(v));
    } else {
      for (let v = lo; v >= hi; v -= step) out.push(fmt(v));
    }
    return out;
  }
  const lo = a.charCodeAt(0);
  const hi = b.charCodeAt(0);
  if (lo <= hi) {
    for (let v = lo; v <= hi; v += step) out.push(String.fromCharCode(v));
  } else {
    for (let v = lo; v >= hi; v -= step) out.push(String.fromCharCode(v));
  }
  return out;
}

// Expands the braces of `p`: `a{b,c}d` -> `abd`, `acd`. A group without a comma that is no sequence stays as it is.
export function expandBraces(p: string): string[] {
  const n = p.length;
  // find the first `{` that is not escaped / in a class and has a matching `}`
  let i = 0;
  while (i < n) {
    const c = p.charCodeAt(i);
    if (c === 92) {
      i = i + 2;
      continue;
    }
    if (c === 91) {
      const e = classEnd(p, i);
      if (e < 0) {
        i = i + 1;
      } else {
        i = e;
      }
      continue;
    }
    if (c === 123) {
      // matching close and top-level commas
      let depth = 1;
      let j = i + 1;
      const commas: number[] = [];
      while (j < n && depth > 0) {
        const d = p.charCodeAt(j);
        if (d === 92) {
          j = j + 2;
          continue;
        }
        if (d === 91) {
          const e = classEnd(p, j);
          if (e < 0) {
            j = j + 1;
          } else {
            j = e;
          }
          continue;
        }
        if (d === 123) depth = depth + 1;
        else if (d === 125) {
          depth = depth - 1;
          if (depth === 0) break;
        } else if (d === 44 && depth === 1) commas.push(j);
        j = j + 1;
      }
      if (depth !== 0) {
        i = i + 1;
        continue; // unbalanced: literal
      }
      const before = p.substring(0, i);
      const after = p.substring(j + 1);
      const inner = p.substring(i + 1, j);
      let items: string[] | null = null;
      if (commas.length > 0) {
        items = [];
        let start = i + 1;
        for (let k = 0; k < commas.length; k++) {
          items.push(p.substring(start, commas[k]));
          start = commas[k] + 1;
        }
        items.push(p.substring(start, j));
      } else if (isSequence(inner)) {
        items = expandSequence(inner);
      }
      if (items === null) items = [inner];
      const out: string[] = [];
      const tails = expandBraces(after);
      for (let k = 0; k < items.length; k++) {
        const heads = expandBraces(before + items[k]);
        for (let h = 0; h < heads.length; h++) {
          for (let t = 0; t < tails.length; t++) {
            out.push(heads[h] + tails[t]);
            if (out.length > 20000) return out;
          }
        }
      }
      return out;
    }
    i = i + 1;
  }
  return [p];
}

function parseClass(p: string, at: number, end: number, tok: Tok): void {
  // p[at] === '[', p[end-1] === ']'
  let i = at + 1;
  const inner = end - 1;
  if (p.charCodeAt(i) === 33 || p.charCodeAt(i) === 94) {
    tok.negated = true;
    i = i + 1;
  }
  let first = true;
  while (i < inner) {
    let c = p.charCodeAt(i);
    if (c === 91 && i + 1 < inner && p.charCodeAt(i + 1) === 58) {
      const close = p.indexOf(":]", i + 2);
      if (close >= 0 && close < inner) {
        const name = p.substring(i + 2, close);
        addPosix(tok, name);
        i = close + 2;
        first = false;
        continue;
      }
    }
    if (c === 92 && i + 1 < inner) {
      i = i + 1;
      c = p.charCodeAt(i);
    }
    // range?
    if (i + 2 < inner && p.charCodeAt(i + 1) === 45) {
      let hi = p.charCodeAt(i + 2);
      let adv = 3;
      if (hi === 92 && i + 3 < inner) {
        hi = p.charCodeAt(i + 3);
        adv = 4;
      }
      tok.ranges.push(c);
      tok.ranges.push(hi);
      i = i + adv;
    } else {
      tok.ranges.push(c);
      tok.ranges.push(c);
      i = i + 1;
    }
    first = false;
  }
  if (first) {
    // empty class: matches nothing
  }
}

function addPosix(tok: Tok, name: string): void {
  const r = tok.ranges;
  if (name === "alpha") { r.push(65, 90, 97, 122); }
  else if (name === "digit") { r.push(48, 57); }
  else if (name === "alnum") { r.push(48, 57, 65, 90, 97, 122); }
  else if (name === "upper") { r.push(65, 90); }
  else if (name === "lower") { r.push(97, 122); }
  else if (name === "space") { r.push(32, 32, 9, 13); }
  else if (name === "punct") { r.push(33, 47, 58, 64, 91, 96, 123, 126); }
  else if (name === "xdigit") { r.push(48, 57, 65, 70, 97, 102); }
  else if (name === "word") { r.push(48, 57, 65, 90, 97, 122, 95, 95); }
}

// Parses one segment (no `/` outside classes / groups) into tokens.
function addAlternative(p: string, s: number, e: number, pool: Tok[][]): number {
  const at = pool.length;
  pool.push([]);
  const toks = parseTokens(p, s, e, pool);
  pool[at] = toks;
  return at;
}

function flushLit(toks: Tok[], lit: string): string {
  if (lit.length > 0) {
    const t = new Tok(T_LIT);
    t.lit = lit;
    toks.push(t);
  }
  return "";
}

function parseTokens(p: string, start: number, end: number, pool: Tok[][]): Tok[] {
  const toks: Tok[] = [];
  let lit = "";
  let i = start;
  while (i < end) {
    const c = p.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < end) {
        lit = lit + p.charAt(i + 1);
        i = i + 2;
      } else {
        lit = lit + "\\";
        i = i + 1;
      }
      continue;
    }
    if (c === 91) {
      const e = classEnd(p, i);
      if (e >= 0 && e <= end) {
        lit = flushLit(toks, lit);
        const t = new Tok(T_CLASS);
        parseClass(p, i, e, t);
        toks.push(t);
        i = e;
        continue;
      }
      lit = lit + "[";
      i = i + 1;
      continue;
    }
    if ((c === 64 || c === 63 || c === 42 || c === 43 || c === 33) && i + 1 < end && p.charCodeAt(i + 1) === 40) {
      // extglob group
      const close = groupEnd(p, i + 1, end);
      if (close >= 0) {
        lit = flushLit(toks, lit);
        const t = new Tok(T_EXT);
        t.op = c;
        // split alternatives on top-level `|`
        let depth = 0;
        let s = i + 2;
        let k = i + 2;
        while (k < close) {
          const d = p.charCodeAt(k);
          if (d === 92) {
            k = k + 2;
            continue;
          }
          if (d === 91) {
            const e = classEnd(p, k);
            if (e >= 0 && e <= close) {
              k = e;
              continue;
            }
          }
          if (d === 40) depth = depth + 1;
          else if (d === 41) depth = depth - 1;
          else if (d === 124 && depth === 0) {
            t.altIdx.push(addAlternative(p, s, k, pool));
            s = k + 1;
          }
          k = k + 1;
        }
        t.altIdx.push(addAlternative(p, s, close, pool));
        toks.push(t);
        i = close + 1;
        continue;
      }
    }
    if (c === 42) {
      lit = flushLit(toks, lit);
      i = i + 1;
      while (i < end && p.charCodeAt(i) === 42 && !(i + 1 < end && p.charCodeAt(i + 1) === 40)) i = i + 1;
      toks.push(new Tok(T_STAR));
      continue;
    }
    if (c === 63) {
      lit = flushLit(toks, lit);
      toks.push(new Tok(T_ANY1));
      i = i + 1;
      continue;
    }
    lit = lit + p.charAt(i);
    i = i + 1;
  }
  flushLit(toks, lit);
  return toks;
}

// Index of the `)` that closes the `(` at `open`, or -1.
function groupEnd(p: string, open: number, end: number): number {
  let depth = 0;
  let i = open;
  while (i < end) {
    const c = p.charCodeAt(i);
    if (c === 92) {
      i = i + 2;
      continue;
    }
    if (c === 91) {
      const e = classEnd(p, i);
      if (e >= 0 && e <= end) {
        i = e;
        continue;
      }
    }
    if (c === 40) depth = depth + 1;
    else if (c === 41) {
      depth = depth - 1;
      if (depth === 0) return i;
    }
    i = i + 1;
  }
  return -1;
}

// Splits a brace-free pattern into segments at top-level `/`.
function makeSeg(p: string, s: number, e: number): Seg {
  const seg = new Seg();
  const text = p.substring(s, e);
  if (text === "**") {
    seg.isGlobstar = true;
  } else {
    seg.toks = parseTokens(p, s, e, seg.pool);
    if (seg.toks.length === 0) {
      seg.isLiteral = true;
      seg.lit = "";
    } else if (seg.toks.length === 1 && seg.toks[0].kind === T_LIT) {
      seg.isLiteral = true;
      seg.lit = seg.toks[0].lit;
    }
  }
  return seg;
}

function parseSegments(p: string): Seg[] {
  const segs: Seg[] = [];
  const n = p.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = p.charCodeAt(i);
    if (c === 92) {
      i = i + 2;
      continue;
    }
    if (c === 91) {
      const e = classEnd(p, i);
      if (e >= 0) {
        i = e;
        continue;
      }
    }
    if (c === 40 && i > 0) {
      const prev = p.charCodeAt(i - 1);
      if (prev === 64 || prev === 63 || prev === 42 || prev === 43 || prev === 33) {
        const close = groupEnd(p, i, n);
        if (close >= 0) {
          i = close + 1;
          continue;
        }
      }
    }
    if (c === 47) {
      segs.push(makeSeg(p, start, i));
      start = i + 1;
    }
    i = i + 1;
  }
  segs.push(makeSeg(p, start, n));
  return segs;
}

// ---- matching of one segment ----

function classMatches(t: Tok, c: number): boolean {
  let hit = false;
  const r = t.ranges;
  for (let i = 0; i < r.length; i += 2) {
    if (c >= r[i] && c <= r[i + 1]) {
      hit = true;
      break;
    }
  }
  return hit !== t.negated;
}

// Does `toks[ti..]` match s[si..end) exactly?
function matchToks(toks: Tok[], ti: number, s: string, si: number, end: number, pool: Tok[][]): boolean {
  while (ti < toks.length) {
    const t = toks[ti];
    const k = t.kind;
    if (k === T_LIT) {
      const lit = t.lit;
      const n = lit.length;
      if (si + n > end) return false;
      if (!s.startsWith(lit, si)) return false;
      si = si + n;
      ti = ti + 1;
    } else if (k === T_ANY1) {
      if (si >= end) return false;
      si = si + 1;
      ti = ti + 1;
    } else if (k === T_CLASS) {
      if (si >= end) return false;
      if (!classMatches(t, s.charCodeAt(si))) return false;
      si = si + 1;
      ti = ti + 1;
    } else if (k === T_STAR) {
      if (ti + 1 === toks.length) return true;
      const next = toks[ti + 1];
      if (next.kind === T_LIT) {
        // jump to occurrences of the literal
        const lit = next.lit;
        let from = si;
        while (true) {
          const at = s.indexOf(lit, from);
          if (at < 0 || at + lit.length > end) return false;
          if (matchToks(toks, ti + 2, s, at + lit.length, end, pool)) return true;
          from = at + 1;
        }
      }
      for (let j = si; j <= end; j++) {
        if (matchToks(toks, ti + 1, s, j, end, pool)) return true;
      }
      return false;
    } else {
      // extglob
      const ends = groupEnds(t, s, si, end, pool);
      for (let e = 0; e < ends.length; e++) {
        if (matchToks(toks, ti + 1, s, ends[e], end, pool)) return true;
      }
      return false;
    }
  }
  return si === end;
}

// The positions where one occurrence of the group `t` can end, when it starts at `from`.
function onceEnds(t: Tok, s: string, from: number, end: number, pool: Tok[][]): number[] {
  const out: number[] = [];
  for (let j = from; j <= end; j++) {
    for (let a = 0; a < t.altIdx.length; a++) {
      if (matchToks(pool[t.altIdx[a]], 0, s, from, j, pool)) {
        out.push(j);
        break;
      }
    }
  }
  return out;
}

function hasPosition(list: number[], v: number): boolean {
  for (let i = 0; i < list.length; i++) if (list[i] === v) return true;
  return false;
}

// All positions where the group `t` (starting at si) can end.
function groupEnds(t: Tok, s: string, si: number, end: number, pool: Tok[][]): number[] {
  const op = t.op;
  const result: number[] = [];
  if (op === 33) {
    // !(a|b): any j such that no alternative matches s[si..j) exactly
    for (let j = si; j <= end; j++) {
      let any = false;
      for (let a = 0; a < t.altIdx.length; a++) {
        if (matchToks(pool[t.altIdx[a]], 0, s, si, j, pool)) {
          any = true;
          break;
        }
      }
      if (!any) result.push(j);
    }
    return result;
  }
  if (op === 64) return onceEnds(t, s, si, end, pool);
  if (op === 63) {
    result.push(si);
    const o = onceEnds(t, s, si, end, pool);
    for (let i = 0; i < o.length; i++) if (o[i] !== si) result.push(o[i]);
    return result;
  }
  // `*(..)` and `+(..)`: repeat
  const queue: number[] = [];
  if (op === 42) {
    queue.push(si);
  } else {
    const o = onceEnds(t, s, si, end, pool);
    for (let i = 0; i < o.length; i++) if (!hasPosition(queue, o[i])) queue.push(o[i]);
  }
  let qi = 0;
  while (qi < queue.length) {
    const from = queue[qi];
    qi = qi + 1;
    const o = onceEnds(t, s, from, end, pool);
    for (let i = 0; i < o.length; i++) {
      if (o[i] > from && !hasPosition(queue, o[i])) queue.push(o[i]);
    }
  }
  return queue;
}

// ---- matching of a whole path ----

function matchSegs(segs: Seg[], k: number, path: string, pos: number): boolean {
  const nsegs = segs.length;
  while (true) {
    if (k === nsegs) return false;
    const seg = segs[k];
    if (seg.isGlobstar) {
      if (k === nsegs - 1) return pos < path.length;
      let p = pos;
      while (true) {
        if (matchSegs(segs, k + 1, path, p)) return true;
        const q = path.indexOf("/", p);
        if (q < 0) return false;
        p = q + 1;
      }
    }
    if (pos > path.length) return false;
    let end = path.indexOf("/", pos);
    if (end < 0) end = path.length;
    if (seg.isLiteral) {
      if (end - pos !== seg.lit.length) return false;
      if (!path.startsWith(seg.lit, pos)) return false;
    } else if (!matchToks(seg.toks, 0, path, pos, end, seg.pool)) {
      return false;
    }
    if (end === path.length) {
      k = k + 1;
      // remaining pattern must be exhausted
      return k === nsegs;
    }
    k = k + 1;
    pos = end + 1;
  }
}

function maySegs(segs: Seg[], k: number, dir: string, pos: number): boolean {
  const nsegs = segs.length;
  while (true) {
    if (pos > dir.length) return k < nsegs;
    if (k === nsegs) return false;
    const seg = segs[k];
    if (seg.isGlobstar) return true;
    let end = dir.indexOf("/", pos);
    if (end < 0) end = dir.length;
    if (seg.isLiteral) {
      if (end - pos !== seg.lit.length) return false;
      if (!dir.startsWith(seg.lit, pos)) return false;
    } else if (!matchToks(seg.toks, 0, dir, pos, end, seg.pool)) {
      return false;
    }
    if (end === dir.length) return k + 1 < nsegs;
    k = k + 1;
    pos = end + 1;
  }
}

export class Glob {
  alts: Seg[][];
  source: string;
  // For a pattern that is one literal path: the path.
  exact: string | null;
  constructor(pattern: string) {
    this.source = pattern;
    this.alts = [];
    this.exact = null;
    const expanded = expandBraces(pattern);
    for (let i = 0; i < expanded.length; i++) {
      this.alts.push(parseSegments(expanded[i]));
    }
    if (this.alts.length === 1) {
      const segs = this.alts[0];
      let allLit = true;
      for (let i = 0; i < segs.length; i++) if (!segs[i].isLiteral) allLit = false;
      if (allLit) {
        let s = "";
        for (let i = 0; i < segs.length; i++) s = s + (i > 0 ? "/" : "") + segs[i].lit;
        this.exact = s;
      }
    }
  }

  matches(path: string): boolean {
    if (this.exact !== null) return path === this.exact;
    for (let i = 0; i < this.alts.length; i++) {
      if (matchSegs(this.alts[i], 0, path, 0)) return true;
    }
    return false;
  }

  // Whether a path inside the directory `dir` could match.
  mayMatchInside(dir: string): boolean {
    if (this.exact !== null) return this.exact.startsWith(dir + "/");
    for (let i = 0; i < this.alts.length; i++) {
      if (maySegs(this.alts[i], 0, dir, 0)) return true;
    }
    return false;
  }
}

// ---- conversions of vendor/bun/src/lint/glob.rs ----

// Marks the braces of every `{a}` group that has no comma and is no sequence: those are literal for picomatch.
function literalBraces(p: string): boolean[] {
  const isLit: boolean[] = [];
  for (let i = 0; i < p.length; i++) isLit.push(false);
  const openAt: number[] = [];
  const openComma: boolean[] = [];
  let at = 0;
  while (at < p.length) {
    const c = p.charCodeAt(at);
    if (c === 92) {
      at = at + 1;
    } else if (c === 91) {
      const e = classEnd(p, at);
      if (e >= 0) at = e - 1;
    } else if (c === 123) {
      openAt.push(at);
      openComma.push(false);
    } else if (c === 44) {
      if (openComma.length > 0) openComma[openComma.length - 1] = true;
    } else if (c === 125) {
      if (openAt.length > 0) {
        const start = openAt.pop() as number;
        const comma = openComma.pop() as boolean;
        if (!comma && !isSequence(p.substring(start + 1, at))) {
          isLit[start] = true;
          isLit[at] = true;
        }
      }
    }
    at = at + 1;
  }
  return isLit;
}

function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// `common` of glob.rs: `{a}` keeps its braces, `\n` is the letter n.
function common(p: string, isMinimatch: boolean): string {
  const isLit = literalBraces(p);
  let out = "";
  let at = 0;
  while (at < p.length) {
    const c = p.charCodeAt(at);
    const before = at > 0 ? p.charCodeAt(at - 1) : -1;
    if (c === 92) {
      if (at + 1 < p.length) {
        const e = p.charCodeAt(at + 1);
        if (isAlnum(e)) out += p.charAt(at + 1);
        else out += "\\" + p.charAt(at + 1);
      } else {
        out += "\\";
      }
      at = at + 2;
      continue;
    }
    if (c === 91) {
      const e = classEnd(p, at);
      if (e >= 0) {
        out += p.substring(at, e);
        at = e;
        continue;
      }
      out += "[";
    } else if ((c === 123 || c === 125) && isLit[at]) {
      out += "\\" + p.charAt(at);
    } else if (c === 47 && isMinimatch && before === 47) {
      // a//b is a/b
    } else if (c === 42 && isMinimatch && (before === -1 || before === 47) && (at + 1 >= p.length || p.charCodeAt(at + 1) === 47)) {
      out += "?*";
    } else {
      out += p.charAt(at);
    }
    at = at + 1;
  }
  return out;
}

export function fromMinimatch(p: string): string {
  return common(p, true);
}

// `{1..3}` the way picomatch writes it: the class `[1-3]`. null unless the parts are letters, digits and `-`.
function picomatchRange(written: string): string | null {
  const parts = written.split("..");
  if (parts.length < 2) return null;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (s.length === 0) return null;
    for (let j = 0; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (!(isAlnum(c) || c === 45)) return null;
    }
  }
  const asWritten = parts.join("..");
  // sort the parts as bytes (sort_slice on byte strings)
  const sorted = parts.slice();
  sorted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const cls = sorted.join("-");
  // `b-a` is a syntax error in a regex class
  let at = 0;
  while (at < cls.length) {
    if (at + 2 < cls.length + 0 && cls.charCodeAt(at + 1) === 45 && at + 2 <= cls.length - 1) {
      if (cls.charCodeAt(at) > cls.charCodeAt(at + 2)) return asWritten;
      at = at + 3;
    } else {
      at = at + 1;
    }
  }
  return "[" + cls + "]";
}

export const MICROMATCH = 0;
export const FASTGLOB = 1;

function isPunct(c: number): boolean {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// `from_picomatch`: converts a picomatch pattern to Bun's dialect.
export function fromPicomatch(pattern: string, how: number): string {
  if (pattern.startsWith("./")) pattern = pattern.substring(2);
  let written = pattern;
  let isDeep = false;
  if (pattern.endsWith("/**")) {
    const before = pattern.substring(0, pattern.length - 3);
    if (before.length > 0 && before !== "*") {
      written = before;
      isDeep = true;
    }
  }
  let grouped = "";
  let at = 0;
  while (at < written.length) {
    const byte = written.charCodeAt(at);
    let len = 1;
    if (byte === 92) len = 2;
    else if (byte === 91) {
      const e = classEnd(written, at);
      len = e >= 0 ? e - at : 1;
    }
    if (byte === 123 && how === MICROMATCH) {
      // find the end of a plain group
      let close = -1;
      for (let k = at + 1; k < written.length; k++) {
        const d = written.charCodeAt(k);
        if (d === 123 || d === 125 || d === 44) {
          if (d === 125) close = k;
          break;
        }
      }
      if (close >= 0) {
        const range = picomatchRange(written.substring(at + 1, close));
        if (range !== null) {
          grouped += range;
          at = close + 1;
          continue;
        }
      }
    }
    if (byte === 91 && len > 2) {
      const inside = written.substring(at + 1, at + len - 1);
      if (!(how === FASTGLOB && inside.startsWith("!"))) {
        let isAlsoLiteral = true;
        for (let k = 0; k < inside.length; k++) {
          if ("-*+?.^${}(|)[]\\/".indexOf(inside.charAt(k)) >= 0) {
            isAlsoLiteral = false;
            break;
          }
        }
        if (isAlsoLiteral) {
          grouped += "@(\\[";
          for (let k = 0; k < inside.length; k++) {
            const c = inside.charCodeAt(k);
            if (isPunct(c)) grouped += "\\";
            grouped += inside.charAt(k);
          }
          grouped += "\\]|";
        }
        let bangs = 0;
        while (bangs < inside.length && inside.charCodeAt(bangs) === 33) bangs = bangs + 1;
        if (bangs === inside.length) grouped += "\\!";
        else grouped += "[" + inside.substring(bangs) + inside.substring(0, bangs) + "]";
        if (isAlsoLiteral) grouped += ")";
        at = at + len;
        continue;
      }
    }
    if (byte === 40) {
      const last = grouped.length > 0 ? grouped.charCodeAt(grouped.length - 1) : -1;
      if (!(last === 63 || last === 42 || last === 43 || last === 64 || last === 33) && written.indexOf(")", at) >= 0) {
        grouped += "@";
      }
    }
    grouped += written.substring(at, Math.min(at + len, written.length));
    at = at + len;
  }
  let out = common(grouped, false);
  if (isDeep) out += "{,/**}";
  return out;
}

// `glob_of_prettier`: a pattern of Prettier's `overrides` or command line.
export function globOfPrettier(pattern: string, how: number): Glob {
  return new Glob(fromPicomatch(pattern, how));
}
