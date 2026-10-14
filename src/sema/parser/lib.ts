// Port of vendor/bun/src/sema/parser/lib.rs: the types the front-end is configured and reported with.
// (The module layout of the Rust crate: lexer, names, parser/*, pragmas, summarize are separate files; `parse` itself is
// the parser porters' `parser/mod.ts::run`.)
import type { Names } from "./names.ts";
import type { Lexer } from "./lexer.ts";
import { R_SYNTAX, R_REPORTED, R_TOO_LARGE, R_TOO_DEEP, R_NOT_UTF8, R_UNTERMINATED, R_UNEXPECTED_CHARACTER, R_CONFLICT_MARKER, R_INVALID_ESCAPE, R_ESCAPED_KEYWORD, R_UNUSUAL_NUMBER, R_UNUSUAL_REGEX, R_UNUSUAL_PRIVATE_NAME, R_JSX, R_JSON, R_AWAIT_IN_SCRIPT, R_DECORATORS, R_UNSUPPORTED, R_COUNT, DIALECT_TYPESCRIPT_5, DIALECT_ECMASCRIPT, DIALECT_BABEL, DIALECT_SCRIPT, DIALECT_FLOW, DIALECT_OXC, DIALECT_OXC_NAMES } from "./lib.consts.ts";
export { R_SYNTAX, R_REPORTED, R_TOO_LARGE, R_TOO_DEEP, R_NOT_UTF8, R_UNTERMINATED, R_UNEXPECTED_CHARACTER, R_CONFLICT_MARKER, R_INVALID_ESCAPE, R_ESCAPED_KEYWORD, R_UNUSUAL_NUMBER, R_UNUSUAL_REGEX, R_UNUSUAL_PRIVATE_NAME, R_JSX, R_JSON, R_AWAIT_IN_SCRIPT, R_DECORATORS, R_UNSUPPORTED, R_COUNT, DIALECT_TYPESCRIPT_5, DIALECT_ECMASCRIPT, DIALECT_BABEL, DIALECT_SCRIPT, DIALECT_FLOW, DIALECT_OXC, DIALECT_OXC_NAMES } from "./lib.consts.ts";

// ───────────────────────────── Refusal ─────────────────────────────
// Why a text is not parsed. 0 = no refusal. Rust `Refusal::X` is `R_X` here; numbers are Rust's discriminant + 1.
// `Lexer.refusal` holds one of these; `refuse(why)` sets it once (the first refusal wins) and from then on every token is
// the end of the file, so the parser unwinds without testing anything.


const REFUSAL_NAMES = [
  "None", "Syntax", "Reported", "TooLarge", "TooDeep", "NotUtf8", "Unterminated", "UnexpectedCharacter", "ConflictMarker",
  "InvalidEscape", "EscapedKeyword", "UnusualNumber", "UnusualRegex", "UnusualPrivateName", "Jsx", "Json", "AwaitInScript",
  "Decorators", "Unsupported",
];
/** Debug: the Rust name of a refusal. */
export function refusalName(r: number): string {
  return r >= 0 && r < REFUSAL_NAMES.length ? REFUSAL_NAMES[r] : "?";
}

/** `Refusal::is_of_scanner`: the scanner has met what is no token. */
export function refusalIsOfScanner(r: number): boolean {
  return r >= R_NOT_UTF8 && r <= R_UNUSUAL_PRIVATE_NAME;
}

// ───────────────────────────── Dialect ─────────────────────────────
// `bun_sema::resolve::Dialect` is a struct of bools; here one Int32 of bit flags. The formatter uses `dialectBabel(isScript)`
// (Prettier's `babel` / `babel-ts`), `dialectFlow` (`babel-flow`) and `dialectFlowParser` (`flow`).


/** `Dialect::typescript_estree(script)` */
export function dialectTypescriptEstree(script: boolean): number {
  return DIALECT_TYPESCRIPT_5 | (script ? DIALECT_SCRIPT : 0);
}
/** `Dialect::espree(script)` */
export function dialectEspree(script: boolean): number {
  return DIALECT_ECMASCRIPT | dialectTypescriptEstree(script);
}
/** `Dialect::babel(script)` */
export function dialectBabel(script: boolean): number {
  return DIALECT_BABEL | dialectEspree(script);
}
/** `Dialect::flow(script)` */
export function dialectFlow(script: boolean): number {
  return DIALECT_FLOW | dialectBabel(script);
}
/** `Dialect::flow_parser(script)` */
export function dialectFlowParser(script: boolean): number {
  return dialectFlow(script) & ~DIALECT_BABEL;
}

// ───────────────────────────── Options ─────────────────────────────

/** How a text is read (`lib.rs::Options`). One instance per parse; all fields are plain data. */
export class Options {
  /** `.d.ts` and the like. */
  isDeclarationFile: boolean = false;
  /** JSX is part of the grammar, and `<T>e` is not. */
  isJsx: boolean = false;
  /** `.js`, `.jsx`, `.mjs`, `.cjs` */
  isJavascript: boolean = false;
  /** `.json`: `parseJSONText`. */
  isJson: boolean = false;
  /** The top level is not an await context. */
  awaitIsAName: boolean = false;
  /** For oxc, in a file whose name does not say what it is. */
  isModuleOrScript: boolean = false;
  /** Goes on after a syntax error as TypeScript's parser does, and reports it (diagnostics). The formatter does not. */
  recovers: boolean = false;
  /** JSDoc tags are read as TypeScript's parser reads them (checker feature; not ported: always false). */
  readsJsdoc: boolean = false;
  /** `Dialect` bit flags (DIALECT_*). */
  dialect: number = 0;
}

/** Options for a file name, as the formatter's driver chooses them (`.ts/.mts/.cts/.tsx` vs `.js/.jsx/.mjs/.cjs`). */
export function optionsForPath(path: string, isScript: boolean, dialectFlags: number): Options {
  const o = new Options();
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  o.isDeclarationFile = path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts");
  o.isJavascript = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
  o.isJsx = ext === ".tsx" || ext === ".jsx" || ext === ".js" || ext === ".mjs" || ext === ".cjs";
  o.isJson = ext === ".json";
  o.dialect = dialectFlags | (isScript ? DIALECT_SCRIPT : 0);
  return o;
}

// ───────────────────────────── Scratch / Parsed ─────────────────────────────

/**
 * What a thread keeps from one file to the next: the atom tables and the capacity of every list (`lib.rs::Scratch`).
 * Under scriptc and node, module state is per thread, so a thread has ONE of these (`scratch` below) and the HIR tables
 * (hir.ts `hir`); nothing is reallocated per file.
 *
 * The parser porters add the parser stacks and the `Declared` scopes here as plain fields of their own module (they do
 * not need to live in this class).
 */
export class Scratch {
  names: Names | null = null;
  lexer: Lexer | null = null;
  /** `html_opens` of the text that was parsed last: where the first `<!--` read as a `<` was, and the first that is on its line (-1 = none). */
  htmlOpensFirst: number = -1;
  htmlOpensFirstOnItsLine: number = -1;
  /** The text that was parsed last has an `await` at its top level and each of them can be a name. */
  hasOnlyAmbiguousAwaits: boolean = false;
  /** `Refused`: why (R_*) the last parse stopped (0 = it did not), where, and the end of the last token scanned. */
  refusal: number = 0;
  refusedAt: number = 0;
  refusedAfter: number = 0;
  /** `Parsed::has_top_level_await` */
  hasTopLevelAwait: boolean = false;
}
