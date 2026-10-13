// Port of vendor/bun/src/sema/parser/summarize.rs, for the readers the formatter has: Prettier's `babel` / `babel-ts` (`Dialect::babel`) and,
// when the file goes to Flow, `babel-flow` / `flow` (`Dialect::flow`, `Dialect::flow_parser`). oxc's dialect (oxfmt) is not ported.
//
// A file is read by the parser that refuses a text at its first error (`parseSource` with `recovers = false`). What that refuses is read again
// by the parser that recovers from errors as TypeScript's does (`recovers = true`), which reports what TypeScript reports. The first error of
// the file is the message of the refusal.
//
//     const status = readFile(src, len, path, dialect, isScript);   // READ_PARSED / READ_GIVEN_UP / READ_TOO_DEEP
//
// The tables are `hir` (src/sema/hir.ts): after READ_PARSED the file is the parser's (with `hir.diagnostics` if it had errors and the
// recovering parser went through it); after READ_GIVEN_UP / READ_TOO_DEEP it is the file of `summarize.rs` that has only the error.
import {
  EXPR_IMPORT_META,
  FK_TSX,
  DK_PARSE,
  hir,
} from "../hir.ts";
import { isDeclarationFileName, parseSource, scriptKindOfPath } from "./parser/run.ts";
import { lx, p } from "./parser/mod.ts";
import {
  DIALECT_ECMASCRIPT,
  DIALECT_FLOW,
  DIALECT_OXC,
  DIALECT_SCRIPT,
  DIALECT_BABEL,
  R_REPORTED,
  R_SYNTAX,
  R_TOO_DEEP,
  refusalIsOfScanner,
} from "./lib.ts";

/** `Summary` of a read: the parser has a file (maybe with the diagnostics of the recovering parser). */
export const READ_PARSED: number = 0;
/** Both parsers have given up: the file has only the first error. */
export const READ_GIVEN_UP: number = 1;
/** There was no stack for it. */
export const READ_TOO_DEEP: number = 2;

function endsWithIgnoreCase(path: string, suffix: string): boolean {
  const n = path.length;
  const m = suffix.length;
  if (n < m) return false;
  for (let i = 0; i < m; i++) {
    let c = path.charCodeAt(n - m + i);
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== suffix.charCodeAt(i)) return false;
  }
  return true;
}

function endsWithExact(path: string, suffix: string): boolean {
  return path.endsWith(suffix);
}

function hasImportMeta(): boolean {
  const n = hir.nExprs;
  for (let i = 0; i < n; i++) if ((hir.exprTag[i] | 0) === EXPR_IMPORT_META) return true;
  return false;
}

// The options of the read in progress (`Reading` + `Options` of summarize.rs).
let rdIsDeclarationFile = false;
let rdIsJsx = false;
let rdIsJavascript = false;
let rdIsJson = false;
let rdAwaitIsAName = false;
let rdEveryFileIsAModule = false;
let rdDialect = 0;
let rdPath = "";

/** One run of the parser: `crate::parse`, with the second reading when an `await` was read at the top level of what is no module. */
function attempt(src: Uint8Array, len: number, recovers: boolean): number {
  let r = parseSource(src, len, rdIsDeclarationFile, rdIsJsx, rdIsJavascript, rdIsJson, rdAwaitIsAName, false, rdDialect, recovers);
  if (r !== 0) return r;
  // `parseSourceFileWorker`: only a file with an `ExternalModuleIndicator` has an [Await] context at its top level.
  const parseAgain =
    p.hasTopLevelAwait &&
    !rdEveryFileIsAModule &&
    !hir.hasModuleSyntax &&
    ((rdDialect & DIALECT_SCRIPT) !== 0 ||
      !(endsWithExact(rdPath, ".mts") || endsWithExact(rdPath, ".cts") || endsWithExact(rdPath, ".mjs") || endsWithExact(rdPath, ".cjs"))) &&
    !hasImportMeta();
  if (parseAgain) {
    r = parseSource(src, len, rdIsDeclarationFile, rdIsJsx, rdIsJavascript, rdIsJson, true, false, rdDialect, recovers);
  }
  return r;
}

/** Where the error is in a text that both parsers have refused: the one for `why` at `at`, after the token that ends at `after`, the one that recovers at `ofRecovery`. */
function placeOfRefusal(src: Uint8Array, len: number, why: number, at: number, after: number, ofRecovery: number): number {
  // What is no token, behind the blanks after the last one.
  if (refusalIsOfScanner(why)) {
    let i = after;
    while (i < len) {
      const c = src[i] | 0;
      if (c === 32 || c === 9 || c === 10 || c === 13) i = (i + 1) | 0;
      else break;
    }
    return i;
  }
  // What TypeScript only reports is noticed when all of it is read.
  if (why === R_REPORTED) return ofRecovery;
  return at;
}

/** `error_before_refusal`: the first Parse diagnostic of the file the parser has left, which starts before the end of the text. -1: none. */
function errorBeforeRefusal(len: number): number {
  const n = hir.diagnosticsLen;
  for (let i = 0; i < n; i += 5) {
    if ((hir.diagnostics[i] | 0) === DK_PARSE && (hir.diagnostics[i + 1] | 0) < len) return i;
  }
  return -1;
}

/**
 * `file_read_as` for a dialect that is not oxc's. `src[0, len)` is the text of the file at `path`; `dialect`: DIALECT_* bits;
 * `isScript` is `dialect.script` (the bit is in `dialect`). Returns READ_PARSED, READ_GIVEN_UP or READ_TOO_DEEP.
 */
export function readFile(src: Uint8Array, len: number, path: string, dialect: number): number {
  const byName = scriptKindOfPath(path);
  // `ScriptKind::from_file_name`, or what the language options say of a name that tells nothing: JavaScript for Espree.
  const kind = byName !== 0 ? byName : endsWithIgnoreCase(path, ".json") ? 0 : 1;
  const isJs = kind === 1 || kind === 2;
  const isJson = byName === 0 && endsWithIgnoreCase(path, ".json");
  const isEcmascript = (dialect & DIALECT_ECMASCRIPT) !== 0 && isJs;
  const isScriptDialect = (dialect & DIALECT_SCRIPT) !== 0;
  rdPath = path;
  rdDialect = dialect;
  rdIsDeclarationFile = byName !== 0 && isDeclarationFileName(path);
  rdIsJsx = isJs || isJson || kind === 4;
  rdIsJavascript = isJs || isJson;
  rdIsJson = isJson;
  rdEveryFileIsAModule = !isScriptDialect;
  // `flow-parser` reads it as a name outside an async function, in a module too.
  const isFlow = (dialect & DIALECT_FLOW) !== 0 && isJs;
  rdAwaitIsAName =
    isJson || (isEcmascript && isScriptDialect) || (isEcmascript && (dialect & DIALECT_FLOW) !== 0 && (dialect & DIALECT_BABEL) === 0);
  void DIALECT_OXC;
  let r = attempt(src, len, false);
  if (r === 0) return READ_PARSED;
  const refusedWhy = r;
  const refusedAt = lx.refusedAt | 0;
  const refusedAfter = lx.refusedAfter | 0;
  let at = refusedAt;
  // No parser recovers from an error in Flow.
  if (!isFlow) {
    r = attempt(src, len, true);
    if (r !== 0) {
      at = placeOfRefusal(src, len, refusedWhy, refusedAt, refusedAfter, lx.refusedAt | 0);
    } else {
      // TypeScript's parser takes `var;`, `class {}` and `catch (a = 1)`, and leaves them to its checker. For acorn and Babel they are
      // no JavaScript, and the parser that refuses a text knows what is.
      const isAnError = refusedWhy === R_SYNTAX || refusedWhy === R_REPORTED;
      if (!(isEcmascript && isAnError && hir.diagnosticsLen === 0)) return READ_PARSED;
    }
  }
  // The file is not looked at any further: its first error is all that is said about it.
  const tooDeep = refusedWhy === R_TOO_DEEP;
  const row = errorBeforeRefusal(len);
  let code = 1128;
  let start = at;
  let end = 0;
  let args: string[] | null = null;
  if (row >= 0) {
    start = hir.diagnostics[row + 1] | 0;
    end = hir.diagnostics[row + 2] | 0;
    code = hir.diagnostics[row + 3] | 0;
    const id = hir.diagnostics[row + 4] | 0;
    if (id >= 0) args = hir.diagArgs[id];
  }
  hir.resetKeepingComments();
  hir.kind = FK_TSX;
  hir.isJs = isJs && !isJson;
  hir.isFlow = isFlow;
  hir.hasErrors = true;
  hir.sourceLen = len;
  if (tooDeep) {
    hir.ranOutOfStack = true;
    return READ_TOO_DEEP;
  }
  hir.hasParseDiagnostics = true;
  hir.errorPos = start;
  let argsId = -1;
  if (args !== null && args.length > 0) {
    argsId = hir.diagArgs.length;
    hir.diagArgs.push(args);
  }
  hir.pushDiagnostics(DK_PARSE, start, end, code, argsId);
  return READ_GIVEN_UP;
}
