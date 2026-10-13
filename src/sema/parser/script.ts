// The parse-and-refuse part of `format()` for JavaScript and TypeScript (vendor/bun/src/lint/driver/fmt/mod.rs: `kinds`, `How::language_and_dialect`,
// `with_file`, and the refusal at the head of `print`), for whoever formats a script:
//
//     const status = parseScript(src, len, path, name, isFlow, goesToBabel, typesTolerated);
//     // PS_OK: the file is in `hir`, formatted next. PS_SYNTAX: `scriptError.message` at `scriptError.at` (-1: about the whole file).
//
// `path`: what the parser sees. `name`: what decides the language (`options.filepath` or `path`). `isFlow`: the file is parsed as Flow
// (`goes_to_flow` of a `babel` file, or `--parser flow|babel-flow`); `goesToBabel`: `bun_format::flow::goes_to_babel` (babel-flow rather
// than flow). `typesTolerated`: the parser is `flow`, `babel-flow`, `typescript` or `babel-ts` (`TypesInJavaScript::Tolerated`).
import { dialectBabel, dialectFlow, dialectFlowParser } from "./lib.ts";
import { READ_PARSED, READ_TOO_DEEP, readFile } from "./summarize.ts";
import { refusal, refusalOfPrettier } from "./syntax/mod.ts";
import { names } from "./parser/mod.ts";
import { fileBegin } from "../../lint/ast/index.ts";
import { hir } from "../hir.ts";

export const PS_OK: number = 0;
export const PS_SYNTAX: number = 1;

export class ScriptError {
  message: string = "";
  /** A byte offset in the text of the file; -1: it is about the whole file. */
  at: number = -1;
}
export const scriptError: ScriptError = new ScriptError();

export const NESTED_TOO_DEEPLY = "The code is nested too deeply";

/**
 * The text that `parseScript` parsed: the text it was given, or (for `babel-flow`) the text that `uncommented` made of it. Offsets in
 * `scriptError.at` and in the file in `hir` are offsets in it. Only the first `len` bytes count.
 */
export class ScriptText {
  src: Uint8Array = new Uint8Array(0);
  len: number = 0;
}
export const scriptText: ScriptText = new ScriptText();

// ───────────────────────────── comment types (bun_format::flow) ─────────────────────────────

/** `bun_format::flow::goes_to_babel`: `babel-flow` rather than `flow` reads the file. `parser`: `options.parser` ("" for none), `name`: `options.filepath` or the path. */
export function goesToBabel(parser: string, name: string): boolean {
  return parser !== "flow" && !name.toLowerCase().endsWith(".js.flow");
}

function startsWithAt(src: Uint8Array, limit: number, at: number, word: string): boolean {
  const n = word.length;
  if (at + n > limit) return false;
  for (let i = 0; i < n; i++) if ((src[(at + i) | 0] | 0) !== word.charCodeAt(i)) return false;
  return true;
}

/** `bun_format::flow::may_have_comment_types`: whether the text has something that looks like a comment for which `uncommented` is there. */
export function mayHaveCommentTypes(src: Uint8Array, len: number): boolean {
  let i = 0;
  while (i + 1 < len) {
    if ((src[i] | 0) !== 47 || (src[(i + 1) | 0] | 0) !== 42) {
      i = (i + 1) | 0;
      continue;
    }
    let k = (i + 2) | 0;
    while (k < len && ((src[k] | 0) === 32 || (src[k] | 0) === 9)) k = (k + 1) | 0;
    if (k < len && (src[k] | 0) === 58) return true;
    if (startsWithAt(src, len, k, "flow-include")) return true;
    i = (i + 2) | 0;
  }
  return false;
}

function isAsciiBlank(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

/** The length of the line that starts at `at` (up to `limit`), if there are only blanks on it, with its line break: -1 if not. */
function blankLine(src: Uint8Array, limit: number, at: number): number {
  let k = at;
  while (k < limit && ((src[k] | 0) === 32 || (src[k] | 0) === 9)) k = (k + 1) | 0;
  if (k >= limit) return -1;
  const c = src[k] | 0;
  if (c === 13 && k + 1 < limit && (src[(k + 1) | 0] | 0) === 10) return (k - at + 2) | 0;
  if (c === 13 || c === 10) return (k - at + 1) | 0;
  return -1;
}

let uncommentedLen = 0;

/**
 * `bun_format::flow::uncommented`: Babel's plugin `flowComments`, which `babel-flow` has and `flow` has not: what is in `/*:: *\/`,
 * `/*flow-include *\/` and `/*: *\/` is code, and Prettier prints it as such. The comments are those of the file in `hir`, which was
 * parsed from `src[0, len)` (also a file that was given up has those that the lexer got past). Returns the text that has to be parsed
 * and formatted in its place, with its length in `uncommentedLen`; null if no comment is such.
 */
function uncommented(src: Uint8Array, len: number): Uint8Array | null {
  const cs = hir.comments;
  const n = cs.len >> 1;
  let out: Uint8Array | null = null;
  let outLen = 0;
  let copied = 0;
  for (let ci = 0; ci < n; ci++) {
    const start = cs.data[ci * 2] | 0;
    const end = cs.data[ci * 2 + 1] | 0;
    if (end - start < 4 || end > len) continue;
    if ((src[start] | 0) !== 47 || (src[(start + 1) | 0] | 0) !== 42 || (src[(end - 2) | 0] | 0) !== 42 || (src[(end - 1) | 0] | 0) !== 47) continue;
    const innerEnd = (end - 2) | 0;
    let codeStart = (start + 2) | 0;
    while (codeStart < innerEnd && ((src[codeStart] | 0) === 32 || (src[codeStart] | 0) === 9)) codeStart = (codeStart + 1) | 0;
    if (codeStart < innerEnd && (src[codeStart] | 0) === 58) {
      if (codeStart + 1 < innerEnd && (src[(codeStart + 1) | 0] | 0) === 58) codeStart = (codeStart + 2) | 0;
    } else if (startsWithAt(src, innerEnd, codeStart, "flow-include")) {
      codeStart = (codeStart + 12) | 0;
    } else {
      continue;
    }
    const codeEnd = innerEnd;
    if (out === null) out = new Uint8Array(len + 16);
    // The text before the comment.
    out.set(src.subarray(copied, start), outLen);
    outLen = (outLen + (start - copied)) | 0;
    // A `/*::` that is alone on its line leaves no line behind.
    let t = outLen;
    while (t > 0 && isAsciiBlank(out[(t - 1) | 0] | 0)) t = (t - 1) | 0;
    let isAtStartOfLine = t === 0;
    for (let k = t; !isAtStartOfLine && k < outLen; k++) {
      const c = out[k] | 0;
      if (c === 10 || c === 13) isAtStartOfLine = true;
    }
    const first = blankLine(src, codeEnd, codeStart);
    if (first >= 0 && isAtStartOfLine) codeStart = (codeStart + first) | 0;
    if (codeStart < codeEnd) {
      out.set(src.subarray(codeStart, codeEnd), outLen);
      outLen = (outLen + (codeEnd - codeStart)) | 0;
    }
    copied = end;
    // For Prettier no empty line follows what ends before a `*/`.
    const line = blankLine(src, len, copied);
    if (line < 0) continue;
    // A `*/` that starts its line leaves no line behind.
    let tt = codeEnd;
    while (tt > codeStart && isAsciiBlank(src[(tt - 1) | 0] | 0)) tt = (tt - 1) | 0;
    let startsLine = false;
    for (let k = tt; k < codeEnd; k++) {
      const c = src[k] | 0;
      if (c === 10 || c === 13) startsLine = true;
    }
    if (!startsLine) {
      out.set(src.subarray(copied, (copied + line) | 0), outLen);
      outLen = (outLen + line) | 0;
    }
    copied = (copied + line) | 0;
    for (;;) {
      const more = blankLine(src, len, copied);
      if (more < 0) break;
      copied = (copied + more) | 0;
    }
  }
  if (out === null) return null;
  if (copied < len) {
    out.set(src.subarray(copied, len), outLen);
    outLen = (outLen + (len - copied)) | 0;
  }
  uncommentedLen = outLen;
  return out;
}

/** `kinds(path)`: 1 = a module only, 2 = a script only, 3 = a module, and a script if that is refused. */
function kinds(path: string): number {
  if (path.endsWith(".mjs") || path.endsWith(".mts")) return 1;
  if (path.endsWith(".cjs") || path.endsWith(".cts")) return 2;
  return 3;
}

/** `fileBegin` of the handle layer, for a file without errors (the checks of the refusal read it). Always true. */
function readFileBegins(path: string, isScript: boolean): boolean {
  if (hir.hasErrors || hir.hasParseDiagnostics) return true;
  const isTypescript = path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".mts") || path.endsWith(".cts");
  fileBegin(names, isTypescript, !isScript);
  return true;
}

/** The kinds of `kinds(name)` as bits: 1 = a module is tried, 2 = a script is tried. A module goes first. */
export function scriptKinds(name: string): number {
  return kinds(name);
}

/**
 * `babel` hands a file of Flow to `babel-flow`, which reads what is in `/*:: *\/` and `/*: *\/` as code: the file is parsed as it is first,
 * to find the comments. Sets `scriptText` to the text that the attempts parse (`src` itself if there is nothing to take out of comments).
 * Call it once, before `parseAttempt`.
 */
export function prepareScriptText(src: Uint8Array, len: number, path: string, isFlow: boolean, goesToBabel: boolean): void {
  let text = src;
  let textLen = len;
  if (isFlow && goesToBabel && mayHaveCommentTypes(src, len)) {
    readFile(src, len, path, dialectFlow(false));
    const u = uncommented(src, len);
    if (u !== null) {
      text = u;
      textLen = uncommentedLen;
    }
  }
  scriptText.src = text;
  scriptText.len = textLen;
}

/**
 * One attempt of `parseScript`: `scriptText` as a module (`isScript` false) or as a script, and the refusal of Prettier (`print` of the
 * driver). PS_OK: the file is in `hir`, bound (`fileBegin` has been called: do not call it again), ready to be formatted. PS_SYNTAX: the
 * error is `scriptError` (`at`: an offset in `scriptText`, -1: about the whole file).
 */
export function parseAttempt(isScript: boolean, path: string, isFlow: boolean, goesToBabel: boolean, typesTolerated: boolean): number {
  const dialect = isFlow ? (goesToBabel ? dialectFlow(isScript) : dialectFlowParser(isScript)) : dialectBabel(isScript);
  const src = scriptText.src;
  const len = scriptText.len | 0;
  const status = readFile(src, len, path, dialect);
  if (status === READ_TOO_DEEP) {
    scriptError.message = NESTED_TOO_DEEPLY;
    scriptError.at = -1;
    return PS_SYNTAX;
  }
  if (readFileBegins(path, isScript) && refusalOfPrettier(src, len, path, typesTolerated, isScript)) {
    scriptError.message = refusal.message;
    scriptError.at = refusal.at;
    return PS_SYNTAX;
  }
  void READ_PARSED;
  return PS_OK;
}

/**
 * `with_file` of the driver for the whole of `kinds(name)`: PS_OK, with the first attempt that is accepted in `hir`, or PS_SYNTAX with the
 * first error that counts (the first attempt's) in `scriptError`.
 */
export function parseScript(
  src: Uint8Array,
  len: number,
  path: string,
  name: string,
  isFlow: boolean,
  goesToBabel: boolean,
  typesTolerated: boolean,
): number {
  prepareScriptText(src, len, path, isFlow, goesToBabel);
  const ks = kinds(name);
  let first = false;
  let firstMessage = "";
  let firstAt = -1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const isScript = attempt === 1;
    if (isScript ? (ks & 2) === 0 : (ks & 1) === 0) continue;
    if (parseAttempt(isScript, path, isFlow, goesToBabel, typesTolerated) === PS_OK) return PS_OK;
    if (!first) {
      first = true;
      firstMessage = scriptError.message;
      firstAt = scriptError.at;
    }
  }
  scriptError.message = firstMessage;
  scriptError.at = firstAt;
  return PS_SYNTAX;
}
