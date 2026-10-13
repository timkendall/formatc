// Port of vendor/bun/src/sema/parser/pragmas.rs: the pragmas in the comments before the first token: `/// <reference ... />`,
// `// @ts-check` and `// @ts-nocheck`, `/* @jsx h */` and similar. Results go into `hir` (checkDirective, references,
// jsx pragmas, diagnostics).
import { CD_IGNORE, DK_PARSE, FK_TSX, REF_LIB, REF_PATH, REF_TYPES, RM_IMPORT, RM_NONE, RM_REQUIRE, hir } from "../hir.ts";
import type { Names } from "./names.ts";
import type { I32Vec } from "../vec.ts";

void CD_IGNORE;

function skipBlanks(t: Uint8Array, pos0: number, end: number): number {
  let pos = pos0;
  while (pos < end && ((t[pos] | 0) === 32 || (t[pos] | 0) === 9)) pos = (pos + 1) | 0;
  return pos;
}
function skipNonBlanks(t: Uint8Array, pos0: number, end: number): number {
  let pos = pos0;
  while (pos < end) {
    const c = t[pos] | 0;
    if (c === 32 || c === 9 || c === 13 || c === 10) break;
    pos = (pos + 1) | 0;
  }
  return pos;
}
/** End of the line of `pos` within `[pos, end)`: a line break (\n, \r, U+2028/2029) or `end`. */
function lineEndPos(t: Uint8Array, pos: number, end: number): number {
  for (let at = pos; at < end; at++) {
    const c = t[at] | 0;
    if (c === 10 || c === 13) return at;
    if (c === 0xe2 && (t[at + 1] | 0) === 0x80 && ((t[at + 2] | 0) === 0xa8 || (t[at + 2] | 0) === 0xa9)) return at;
  }
  return end;
}
/** `extractName`: the run of ASCII letters and `-` at `pos`; returns its end. */
function nameEnd(t: Uint8Array, pos: number, end: number): number {
  let p = pos;
  while (p < end) {
    const c = t[p] | 0;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) p = (p + 1) | 0;
    else break;
  }
  return p;
}
/** Case-insensitive comparison of t[start, end) with the lowercase ASCII `lit`. */
function eqIgnoreCase(t: Uint8Array, start: number, end: number, lit: string): boolean {
  if (end - start !== lit.length) return false;
  for (let i = 0; i < lit.length; i++) {
    let c = t[start + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== lit.charCodeAt(i)) return false;
  }
  return true;
}
function eqExact(t: Uint8Array, start: number, end: number, lit: string): boolean {
  if (end - start !== lit.length) return false;
  for (let i = 0; i < lit.length; i++) {
    if ((t[start + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

const ARG_NAMES: string[] = ["types", "lib", "path", "resolution-mode", "no-default-lib"];
// scratch: argument ranges (from, to) per name, -1 = absent
const argFrom = new Int32Array(5);
const argTo = new Int32Array(5);

/**
 * `getCommentPragmas` and `processPragmasIntoFields`. `leading`: rows (start, end) of the comments before the first token (the
 * lexer's `leadingComments`). Returns false if TypeScript reports an error about one of them (with `recovers` the error is among
 * the diagnostics of the file instead, and this returns true).
 */
export function processPragmasIntoFields(text: Uint8Array, leading: I32Vec, recovers: boolean, names: Names): boolean {
  const n = leading.len;
  for (let i = 0; i < n; i += 2) {
    const start = leading.data[i] | 0;
    const end = leading.data[i + 1] | 0;
    if (end - start < 2) continue;
    const c0 = text[start] | 0;
    const c1 = text[start + 1] | 0;
    if (c0 === 47 && c1 === 47) {
      if (!singleLinePragma(text, start, end, recovers, names)) return false;
    } else if (c0 === 47 && c1 === 42 && hir.kind === FK_TSX) {
      // Only read for files that can contain JSX.
      multiLinePragmas(text, start, end, names);
    }
  }
  return true;
}

/** `extractPragmas` for the `//` comment `text[commentPos, end)`, followed by `processPragmasIntoFields`. */
function singleLinePragma(t: Uint8Array, commentPos: number, end: number, recovers: boolean, names: Names): boolean {
  let pos = (commentPos + 2) | 0;
  const tripleSlash = (t[pos] | 0) === 47 && pos < end;
  if (tripleSlash) pos = (pos + 1) | 0;
  pos = skipBlanks(t, pos, end);
  if (pos < end && (t[pos] | 0) === 64) {
    // "_last_ of either nocheck or check in a file is the "winner""
    const ne = nameEnd(t, (pos + 1) | 0, end);
    if (eqIgnoreCase(t, (pos + 1) | 0, ne, "ts-check")) hir.checkDirective = 1;
    else if (eqIgnoreCase(t, (pos + 1) | 0, ne, "ts-nocheck")) hir.checkDirective = 0;
    return true;
  }
  if (!tripleSlash || pos >= end || (t[pos] | 0) !== 60) return true;
  const rn = nameEnd(t, (pos + 1) | 0, end);
  if (!eqIgnoreCase(t, (pos + 1) | 0, rn, "reference")) return true;
  pos = (pos + 10) | 0; // "<reference"
  for (let k = 0; k < 5; k++) {
    argFrom[k] = -1;
    argTo[k] = -1;
  }
  while (true) {
    pos = skipBlanks(t, pos, end);
    const ne = nameEnd(t, pos, end);
    if (ne === pos) break;
    const nameStart = pos;
    pos = skipBlanks(t, ne, end);
    if (pos >= end || (t[pos] | 0) !== 61) break;
    pos = skipBlanks(t, (pos + 1) | 0, end);
    // extract_quoted_string
    const quote = pos < end ? t[pos] | 0 : 0;
    if (quote !== 39 && quote !== 34) break;
    let close = (pos + 1) | 0;
    while (close < end && (t[close] | 0) !== quote) close = (close + 1) | 0;
    if (close >= end) break;
    for (let k = 0; k < 5; k++) {
      if (eqIgnoreCase(t, nameStart, ne, ARG_NAMES[k])) {
        // The last of two arguments with the same name wins.
        argFrom[k] = (pos + 1) | 0;
        argTo[k] = close;
      }
    }
    pos = (close + 1) | 0;
  }
  // types, lib, path, resolution-mode, no-default-lib
  if (argFrom[4] >= 0 && eqExact(t, argFrom[4], argTo[4], "true")) return true;
  let kind = -1;
  let from = 0;
  let to = 0;
  if (argFrom[0] >= 0) {
    kind = REF_TYPES;
    from = argFrom[0];
    to = argTo[0];
  } else if (argFrom[1] >= 0) {
    kind = REF_LIB;
    from = argFrom[1];
    to = argTo[1];
  } else if (argFrom[2] >= 0) {
    kind = REF_PATH;
    from = argFrom[2];
    to = argTo[2];
  } else {
    if (recovers) hir.pushDiagnostics(DK_PARSE, commentPos, end, 1084, -1);
    return recovers;
  }
  // `parseResolutionMode`
  let mode = RM_NONE;
  if (kind === REF_TYPES && argFrom[3] >= 0) {
    if (eqExact(t, argFrom[3], argTo[3], "import")) mode = RM_IMPORT;
    else if (eqExact(t, argFrom[3], argTo[3], "require")) mode = RM_REQUIRE;
    else if (!recovers) return false;
    else {
      hir.pushDiagnostics(DK_PARSE, argFrom[3], argTo[3], 1453, -1);
      mode = RM_NONE;
    }
  }
  const atom = names.atomOfBytes(t, from, to);
  hir.pushReferences(kind, atom, from, mode);
  return true;
}

/** `extractPragmas` for the `/* *​/` comment `text[start, end)`. The last of two identical pragmas wins (`GetPragmaFromSourceFile`). */
function multiLinePragmas(t: Uint8Array, start: number, end0: number, names: Names): void {
  let end = end0;
  if (end - start >= 2 && (t[end - 2] | 0) === 42 && (t[end - 1] | 0) === 47) end = (end - 2) | 0;
  let pos = (start + 2) | 0;
  while (true) {
    // skipTo '@'
    let at = pos;
    while (at < end && (t[at] | 0) !== 64) at = (at + 1) | 0;
    if (at >= end) break;
    pos = at;
    // "the '@' must be immediately followed by a non-whitespace pragma name, and the remainder of the line is consumed as that
    // pragma's arguments"
    const nameEnd_ = skipNonBlanks(t, (pos + 1) | 0, end);
    if (nameEnd_ === pos + 1) {
      pos = (pos + 1) | 0;
      continue;
    }
    const argStart = skipBlanks(t, nameEnd_, end);
    const argEnd = skipNonBlanks(t, argStart, end);
    const hasArg = argEnd > argStart;
    const ns = (pos + 1) | 0;
    if (hasArg && eqIgnoreCase(t, ns, nameEnd_, "jsx")) hir.jsxFactory = names.atomOfBytes(t, argStart, argEnd);
    else if (hasArg && eqIgnoreCase(t, ns, nameEnd_, "jsxfrag")) hir.jsxFragmentFactory = names.atomOfBytes(t, argStart, argEnd);
    else if (hasArg && eqIgnoreCase(t, ns, nameEnd_, "jsximportsource")) hir.jsxImportSource = names.atomOfBytes(t, argStart, argEnd);
    else if (hasArg && eqIgnoreCase(t, ns, nameEnd_, "jsxruntime")) {
      // `GetJSXImplicitImportBase`
      if (eqExact(t, argStart, argEnd, "classic")) hir.jsxClassic = 1;
      else if (eqExact(t, argStart, argEnd, "automatic")) hir.jsxClassic = 0;
      else hir.jsxClassic = -1;
    }
    pos = lineEndPos(t, pos, end);
  }
}
