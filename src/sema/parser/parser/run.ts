// The entry point of the parser: `parser::run` (mod.rs) + `source_file` (`parseSourceFileWorker`) + the file-level choices of
// `summarize.rs::file_read_as` that the formatter's driver depends on (what a path is, the second parse when `await` was read as a
// name, the dialect of `Dialect::babel(is_script)`).
//
//     const refusal = parseFile(src, len, path, isScript);   // 0: the text is parsed; else R_*, see lx.refusedAt
//
// The tables are `hir` (src/sema/hir.ts); the atoms are `names` (mod.ts). A parsed file is valid until the next parse on the thread.
// The parser that recovers from errors (summarize.rs's second attempt) is not ported: a refusal is the end (TODO(recover)).
import {
  FK_DECLARATION,
  FK_JSON,
  FK_TS,
  FK_TSX,
  EXPR_IMPORT_META,
  STMT_EXPORT_ASSIGN,
  STMT_EXPORT_DEFAULT,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_IMPORT,
  STMT_IMPORT_EQUALS,
  STMT_CLASS,
  STMT_ENUM,
  STMT_FN,
  STMT_INTERFACE,
  STMT_MODULE,
  STMT_TYPE_ALIAS,
  STMT_VAR,
  FLAG_EXPORT,
  DK_GRAMMAR,
  DK_PARSE,
  IET_REQUIRE,
  RARE_ODD_PRIVATE_NAME,
  hir,
} from "../../hir.ts";
import { beginFile, finishHir, modifiersToFlags, pushDiagnosticArgs } from "../../hir_util.ts";
import { reportSyntaxOfTypescript } from "../../ecmascript.ts";
import { processPragmasIntoFields } from "../pragmas.ts";
import { DIALECT_ECMASCRIPT, DIALECT_SCRIPT, R_REPORTED, R_TOO_LARGE, dialectBabel } from "../lib.ts";
import { T_EOF } from "../token.ts";
import { radixText } from "../lexer.ts";
import {
  LK_SOURCE_ELEMENTS,
  beginParse,
  hasFailed,
  lx,
  names,
  next,
  p,
  refuse,
  s,
  takeErrorsOfScanner,
  takeIds,
} from "./mod.ts";
import { isAtElement, topLevelStatement } from "./recover.ts";
import { statement } from "./stmt.ts";
import { jsonText } from "./json.ts";
import { takeStrayDecorators } from "./recover.ts";
import { srcText } from "./mod.ts";

/** `isAnExternalModuleIndicatorNode` */
function isAnExternalModuleIndicator(id: number): boolean {
  const hir$ = hir;
  if (id < 0 || id >= hir$.nStmts) return false;
  const a = hir$.stmtA[id] | 0;
  let flags = 0;
  switch (hir$.stmtTag[id] | 0) {
    case STMT_VAR:
      flags = modifiersToFlags(hir$.stmtModStart[id] | 0, hir$.stmtModLen[id] | 0);
      break;
    case STMT_FN:
      flags = hir$.fnFlags[a] | 0;
      break;
    case STMT_CLASS:
      flags = hir$.classFlags[a] | 0;
      break;
    case STMT_INTERFACE:
      flags = hir$.interfaceFlags[a] | 0;
      break;
    case STMT_TYPE_ALIAS:
      flags = hir$.aliasFlags[a] | 0;
      break;
    case STMT_ENUM:
      flags = hir$.enumFlags[a] | 0;
      break;
    case STMT_MODULE:
      flags = hir$.moduleFlags[a] | 0;
      break;
    // `import a = b.c` aliases an existing entity. It does not make the file a module.
    case STMT_IMPORT_EQUALS:
      if ((hir$.importEqualsTargetKind[a] | 0) === IET_REQUIRE) return true;
      flags = hir$.importEqualsFlags[a] | 0;
      break;
    case STMT_IMPORT:
    case STMT_EXPORT_NAMED:
    case STMT_EXPORT_STAR:
    case STMT_EXPORT_DEFAULT:
    case STMT_EXPORT_ASSIGN:
      return true;
    default:
      return false;
  }
  return (flags & FLAG_EXPORT) !== 0;
}

/** `parseSourceFileWorker` */
function sourceFile(): void {
  const hir$ = hir;
  const p$ = p;
  hir$.kind = p$.isJson ? FK_JSON : p$.isDeclarationFile ? FK_DECLARATION : p$.isJsx ? FK_TSX : FK_TS;
  hir$.isJs = p$.isJavascript && !p$.isJson;
  hir$.isFlow = p$.isFlow;
  next();
  const s$ = s;
  const base = s$.ids.len;
  p$.lists = 1 << LK_SOURCE_ELEMENTS;
  if (p$.isJson) {
    const value = jsonText();
    hir$.hasModuleSyntax = true;
    s$.ids.push(value);
  }
  const lx$ = lx;
  while (lx$.token !== T_EOF && isAtElement(LK_SOURCE_ELEMENTS)) {
    const stmt = p$.recovers ? topLevelStatement() : statement();
    takeStrayDecorators(0);
    if (isAnExternalModuleIndicator(stmt)) hir$.hasModuleSyntax = true;
    // TODO(jsdoc): `statement_jsdoc`, `list_reparsed`
    s$.ids.push(stmt);
  }
  hir$.bodyStart = takeIds(base);
  hir$.bodyLen = p$.outLen | 0;
  // TODO(oxc): `module_statements`, `statements_in_ambient_context`
  takeErrorsOfScanner();
  // TODO(checker): `forget_specifiers_of_misplaced_declarations` (1141 is of the type checker).
  if (p$.unclaimedNullableTypes > 0) refuse(R_REPORTED);
  if (p$.isEcmascript && !p$.isFlow && !hasFailed()) reportSyntaxOfTypescript();
  if (p$.recovers && hasParseDiagnostic()) hir$.hasParseDiagnostics = true;
  sortRows2(hir$.importAttributes, hir$.importAttributesLen);
}

function hasParseDiagnostic(): boolean {
  const hir$ = hir;
  const n = hir$.diagnosticsLen;
  for (let i = 0; i < n; i += 5) if ((hir$.diagnostics[i] | 0) === DK_PARSE) return true;
  return false;
}

/** Sorts the rows of 2 (insertion sort: nearly sorted) by their first value, stably. */
function sortRows2(a: Int32Array, len: number): void {
  for (let i = 2; i < len; i += 2) {
    const k = a[i] | 0;
    if ((a[i - 2] | 0) <= k) continue;
    const v = a[i + 1] | 0;
    let j = i - 2;
    while (j >= 0 && (a[j] | 0) > k) {
      a[j + 2] = a[j] | 0;
      a[j + 3] = a[j + 1] | 0;
      j = j - 2;
    }
    a[j + 2] = k;
    a[j + 3] = v;
  }
}

/** `Lexer::flagged` as diagnostics (`report_what_the_scanner_flagged`). */
function reportWhatTheScannerFlagged(): void {
  const f = lx.flagged;
  const hir$ = hir;
  for (let i = 0; i < f.len; i += 3) {
    const code = f.data[i] | 0;
    const start = f.data[i + 1] | 0;
    const end = f.data[i + 2] | 0;
    if (code === 1487 || code === 1488 || code === 1121) {
      // The argument of the message: `\1` is `\x01`, `\8` is itself, `010` is `0o10`.
      const written = srcText(start, end);
      let argument = "";
      if (code === 1487) argument = "\\x" + twoDigits(radixText(octalOf(written, 1), 16));
      else if (code === 1488) argument = written;
      else if (written.charCodeAt(0) === 45) argument = "-0o" + radixText(octalOf(written, 1), 8);
      else argument = "0o" + radixText(octalOf(written, 0), 8);
      pushDiagnosticArgs(DK_GRAMMAR, start, end, code, argument === "" ? [] : [argument]);
    } else hir$.pushDiagnostics(DK_GRAMMAR, start, end, code, -1);
  }
  f.len = 0;
}

/** Two characters at least, padded with `0`. */
function twoDigits(s: string): string {
  return s.length < 2 ? "0" + s : s;
}

/** `u64::from_str_radix(&written[from..], 8)`, or 0. */
function octalOf(written: string, from: number): number {
  let v = 0;
  const n = written.length;
  if (from >= n) return 0;
  for (let i = from; i < n; i++) {
    const c = written.charCodeAt(i) - 48;
    if (c < 0 || c > 7) return 0;
    v = v * 8 + c;
  }
  return v;
}

/**
 * `parser::run`: parses `src[0, len)` as the options say. Returns 0, or the refusal (R_*; `lx.refusedAt` / `lx.refusedAfter`).
 * `dialect`: DIALECT_* bits.
 */
export function parseSource(
  src: Uint8Array,
  len: number,
  isDeclarationFile: boolean,
  isJsx: boolean,
  isJavascript: boolean,
  isJson: boolean,
  awaitIsAName: boolean,
  isModuleOrScript: boolean,
  dialect: number,
  recovers: boolean,
): number {
  if (len >= 1 << 30) return R_TOO_LARGE;
  beginFile(src, len);
  const lx$ = lx;
  lx$.begin(src, len);
  beginParse(isDeclarationFile, isJsx, isJavascript, isJson, awaitIsAName, isModuleOrScript, dialect, recovers);
  sourceFile();
  reportWhatTheScannerFlagged();
  const hir$ = hir;
  if (lx$.privateNames.len > 0) hir$.rareSyntax = hir$.rareSyntax | RARE_ODD_PRIVATE_NAME;
  // (`note_odd_exports` is for oxc.)
  if (lx$.refusal !== 0) return lx$.refusal | 0;
  const errors = hir$.diagnosticsLen;
  if (!processPragmasIntoFields(src, lx$.leadingComments, recovers, names)) return R_REPORTED;
  if (hir$.diagnosticsLen > errors) hir$.hasParseDiagnostics = true;
  finishHir();
  return 0;
}

function endsWith(path: string, suffix: string): boolean {
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

/** `IsDeclarationFileName`: `.d.ts`, `.d.mts`, `.d.cts` or `.d.*.ts` (case-sensitive, as in Rust). */
export function isDeclarationFileName(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  if (base.endsWith(".d.ts") || base.endsWith(".d.mts") || base.endsWith(".d.cts")) return true;
  return base.indexOf(".d.") >= 0 && base.endsWith(".ts");
}

/** The kind of a file by its extension (`ScriptKind::from_file_name`): 0 none, 1 Js, 2 Jsx, 3 Ts, 4 Tsx. */
export function scriptKindOfPath(path: string): number {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return 0;
  const ext = path.slice(dot).toLowerCase();
  switch (ext) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return 1;
    case ".jsx":
      return 2;
    case ".ts":
    case ".cts":
    case ".mts":
      return 3;
    case ".tsx":
      return 4;
    default:
      return 0;
  }
}

/**
 * `file_read_as` (non-oxc, non-flow, without the recovering second parse): the file at `path` as `Dialect::babel(isScript)` reads it.
 * `everyFileIsAModule` is `!isScript` (the formatter's `LanguageOptions`). Returns 0 or the refusal (R_*).
 */
export function parseFile(src: Uint8Array, len: number, path: string, isScript: boolean): number {
  const dialect = dialectBabel(isScript);
  const byName = scriptKindOfPath(path);
  const isJs = byName === 1 || byName === 2;
  const isJson = byName === 0 && endsWith(path, ".json");
  const isEcmascript = (dialect & DIALECT_ECMASCRIPT) !== 0 && isJs;
  const everyFileIsAModule = isEcmascript ? (dialect & DIALECT_SCRIPT) === 0 : !isScript;
  const isDeclarationFile = byName !== 0 && isDeclarationFileName(path);
  const isJsx = isJs || isJson || byName === 4;
  const isJavascript = isJs || isJson;
  // `flow-parser` reads it as a name outside an async function, in a module too.
  const awaitIsAName = isJson || (isEcmascript && (dialect & DIALECT_SCRIPT) !== 0);
  let r = parseSource(src, len, isDeclarationFile, isJsx, isJavascript, isJson, awaitIsAName, false, dialect, false);
  if (r !== 0) return r;
  // `parseSourceFileWorker`: only a file with an `ExternalModuleIndicator` has an [Await] context at its top level.
  const parseAgain =
    p.hasTopLevelAwait &&
    !everyFileIsAModule &&
    !hir.hasModuleSyntax &&
    ((dialect & DIALECT_SCRIPT) !== 0 || !(endsWith(path, ".mts") || endsWith(path, ".cts") || endsWith(path, ".mjs") || endsWith(path, ".cjs"))) &&
    !hasImportMeta();
  if (parseAgain) {
    r = parseSource(src, len, isDeclarationFile, isJsx, isJavascript, isJson, true, false, dialect, false);
  }
  return r;
}

function hasImportMeta(): boolean {
  const hir$ = hir;
  const n = hir$.nExprs;
  for (let i = 0; i < n; i++) if ((hir$.exprTag[i] | 0) === EXPR_IMPORT_META) return true;
  return false;
}

