// Port of vendor/bun/src/format/html/js.rs: JavaScript and TypeScript in HTML: Prettier's `textToDoc` for the parsers of `language-js`.
//
// The code is parsed by itself, and written by the formatter for JavaScript to the document that the HTML is written to, so that where its
// lines are broken depends on where it is.
//
// How it differs from the Rust: the parser of JavaScript is global (the HIR), so "parse with the callback `then`" is "parse, and the file is
// the global one until the next parse". `Formatter.beginEmbedded` lends the document to the JS formatter, and `f.options` / `f.context` are set
// to those of the code for as long as it writes.
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { FORMAT_OK } from "../errors.ts";
import {
  FLAVOR_OXFMT,
  FormatOptions,
  HTML_ROOT_JS_EXPRESSION,
  HTML_ROOT_NG_ACTION,
  HTML_ROOT_NG_BINDING,
  HTML_ROOT_NG_DIRECTIVE,
  HTML_ROOT_PROGRAM,
  HTML_ROOT_VUE_EXPRESSION,
  InHtml,
  QUOTE_SINGLE,
} from "../options.ts";
import { Formatter } from "../ir/formatter.ts";
import { FormatContext } from "../ir/context.ts";
import { COMMA } from "../ir/tokens.ts";
import { token } from "../ir/element.ts";
import { collectComments } from "../js/comments.ts";
import { JsFormatContext, cxOf } from "../js/context.ts";
import { AN_ARRAY_EXPRESSION, AN_OBJECT_EXPRESSION, AN_STRING_LITERAL, AN_TEMPLATE_LITERAL, anTag, exprAsAstNodes } from "../js/ast_nodes.ts";
import { fmtExpr, fmtParam, fmtTypeParam } from "../js/format.ts";
import { writeHashbang, fmtStatements } from "../js/print/program.ts";
import { DANGLING_NONE, formatDanglingCommentsRange, formatTrailingCommentsRange } from "../js/trivia.ts";
import { jsState } from "../js/state.ts";
import { noCursor } from "../cursor.ts";
import { parseFile } from "../../sema/parser/parser/run.ts";
import { lx, names } from "../../sema/parser/parser/mod.ts";
import {
  EXPR_ASSIGN,
  STMT_EMPTY,
  STMT_EXPR,
  STMT_FN,
  STMT_TYPE_ALIAS,
  aliasTypeParamsLen,
  aliasTypeParamsStart,
  exprOuterSpan,
  exprSpan,
  exprTag,
  fileBegin,
  fileBodyLen,
  fileBodyStart,
  fileHasParseErrors,
  funcParamsLen,
  funcParamsStart,
  funcThisParam,
  hir,
  listAt,
  SP,
  stmtExprExpr,
  stmtFnFn,
  stmtTag,
  stmtTypeAliasAlias,
} from "../../lint/ast/index.ts";
import { Printer } from "./pstate.ts";
import { StringMapper, writeMapped } from "./map_strings.ts";
import { writeString } from "./writer.ts";

// The parsers of Prettier for programs.
/** `babel`: JavaScript with JSX. */
export const SYN_BABEL: number = 0;
/** `babel-ts`: TypeScript, with JSX if that can be. */
export const SYN_BABEL_TS: number = 1;
/** `typescript`, for a file whose name does not say whether it has JSX. */
export const SYN_TYPESCRIPT: number = 2;
/** TypeScript without JSX, and nothing else: what oxfmt takes the scripts of a Vue file for. */
export const SYN_TS: number = 3;
/** TypeScript with JSX, and nothing else: the same if one of them says `lang="tsx"`. */
export const SYN_TSX: number = 4;

/** `sourceType` */
export const SOURCE_SCRIPT: number = 0;
export const SOURCE_MODULE: number = 1;
/** A module, or else a script. */
export const SOURCE_UNKNOWN: number = 2;

/** What `formatAttributeValue` puts around the document. */
/** `group(doc)` */
export const HUG_ALWAYS: number = 0;
/** `printExpand(doc)` */
export const HUG_NEVER: number = 1;
/** `shouldHugJsExpression` */
export const HUG_EXPRESSION: number = 2;
/** Nothing: it is `textToDoc` that is called. */
export const HUG_BARE: number = 3;

/** What `printHtmlBinding` prints of a program that is one declaration. */
/** `__isVueBindings`: the parameters of `function _(..) {}`. */
export const BINDING_PARAMETERS: number = 0;
/** `__isVueForBindingLeft`: the same, in parentheses if there is more than one. */
export const BINDING_FOR_LEFT: number = 1;
/** `__isEmbeddedTypescriptGenericParameters`: the type parameters of `type T<..> = any`. */
export const BINDING_TYPE_PARAMETERS: number = 2;

// What code is.
const PIECE_SCRIPT = 0;
const PIECE_BINDING = 1;
const PIECE_OTHER = 2;

// What is written of the file.
const W_STATEMENTS = 0;
const W_EXPRESSION = 1;
const W_PROGRAM_IN_ATTRIBUTE = 2;
const W_BINDING = 3;

const EXPRESSION_JSX = "\0.jsx";
const EXPRESSION_TS = "\0.ts";

const TK_OPEN_PAREN = token("(");
const TK_CLOSE_PAREN = token(")");

/** Prettier's `isProbablyJsx`: `/(?:^[^"'`]*<\/|^[^/]{2}.*\/>)/m` */
export function isProbablyJsx(b: Uint8Array, s: number, e: number): boolean {
  // `</` with the start of a line before it and no quote in between.
  let hasClose = false;
  for (let i = s; i + 1 < e; i++) {
    if ((b[i] | 0) === 60 && (b[i + 1] | 0) === 47) {
      hasClose = true;
      break;
    }
  }
  if (hasClose) {
    let isBehindQuote = false;
    for (let i = s; i < e; i++) {
      const c = b[i] | 0;
      if (c === 10) isBehindQuote = false;
      else if (c === 60) {
        if (!isBehindQuote && i + 1 < e && (b[i + 1] | 0) === 47) return true;
      } else if (c === 34 || c === 39 || c === 96) {
        isBehindQuote = true;
      }
    }
  }
  let ls = s;
  for (;;) {
    let le = ls;
    while (le < e && (b[le] | 0) !== 10) le = le + 1;
    if (le - ls >= 4 && (b[ls] | 0) !== 47 && (b[ls + 1] | 0) !== 47) {
      for (let i = ls + 2; i + 1 < le; i++) {
        if ((b[i] | 0) === 47 && (b[i + 1] | 0) === 62) return true;
      }
    }
    if (le >= e) break;
    ls = le + 1;
  }
  return false;
}

/** The options for code that is in HTML that is formatted with `options`. */
export function optionsInHtml(options: FormatOptions, inHtml: InHtml): FormatOptions {
  const o = options.copy();
  // In an attribute, double quotes would have to be written as entities.
  if (inHtml.isInAttribute) o.quoteStyle = QUOTE_SINGLE;
  const ih = inHtml.copy();
  ih.quoteStyle = options.quoteStyle;
  o.inHtml = ih;
  o.parser = "";
  o.filepath = "";
  o.rangeStart = -1;
  o.rangeEnd = -1;
  o.cursorOffset = -1;
  o.insertPragma = false;
  o.requirePragma = false;
  o.checkIgnorePragma = false;
  o.isInMarkdown = false;
  o.isMdxJsx = false;
  o.isMdxEsSyntax = false;
  o.sortImports = -1;
  o.jsdoc = null;
  return o;
}

function pathsOf(syntax: number, b: Uint8Array, s: number, e: number): string[] {
  switch (syntax) {
    case SYN_BABEL:
      return PATHS_JSX;
    case SYN_BABEL_TS:
      return PATHS_TSX_TS;
    case SYN_TYPESCRIPT:
      return isProbablyJsx(b, s, e) ? PATHS_TSX_TS : PATHS_TS_TSX;
    case SYN_TS:
      return PATHS_TS;
    default:
      return PATHS_TSX;
  }
}
const PATHS_JSX: string[] = ["dummy.jsx"];
const PATHS_TSX_TS: string[] = ["dummy.tsx", "dummy.ts"];
const PATHS_TS_TSX: string[] = ["dummy.ts", "dummy.tsx"];
const PATHS_TS: string[] = ["dummy.ts"];
const PATHS_TSX: string[] = ["dummy.tsx"];
const PATHS_EXPRESSION_JSX: string[] = [EXPRESSION_JSX];
const PATHS_EXPRESSION_TS: string[] = [EXPRESSION_TS];

function isTypeScriptPath(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".mts") || path.endsWith(".cts");
}

/** What a write needs to know (the Rust closure). */
class Job {
  mode: number = W_STATEMENTS;
  hug: number = HUG_BARE;
  root: number = 0;
  binding: number = 0;
  isTypescript: boolean = false;
  /** Angular: the code is `shown`: the text the formatter reads (null: the file's text). */
  shown: Uint8Array | null = null;
  ignored: Uint8Array | null = null;
  ignoredS: number = 0;
  ignoredE: number = 0;
  /** Angular: what follows the expression. */
  rest: AngularRest | null = null;
}

/** What `write_rest` writes (Angular). */
export class AngularRest {
  write(f: Formatter): void {
    void f;
  }
}

const job = new Job();

class ContextPool {
  list: JsFormatContext[] = [];
  depth: number = 0;
}
const contexts = new ContextPool();

function contextAt(depth: number, options: FormatOptions): JsFormatContext {
  const contexts$ = contexts;
  const noCursor$ = noCursor;
  while (contexts$.list.length <= depth) contexts$.list.push(new JsFormatContext(options, noCursor$));
  return contexts$.list[depth];
}

/**
 * Parses `code` (`b[s, e)`) as the file at each of `paths`, until it is one without errors, and writes it with the job `job`. Returns what the
 * write returns, and false if the code cannot be parsed: nothing has been written then.
 */
function withFile(
  p: Printer,
  src: Uint8Array,
  paths: string[],
  sourceType: number,
  inHtml: InHtml,
  piece: number,
  flavor: number,
): boolean {
  const f = p.w.f;
  const hostOptions = p.o.format;
  const options = optionsInHtml(hostOptions, inHtml);
  // To Prettier the name of the file is still that of the HTML, so `<T,>() => {}` keeps its comma: it is not `.ts`. oxfmt prints a script
  // like a file of its own.
  if (!((piece === PIECE_SCRIPT || piece === PIECE_BINDING) && flavor === FLAVOR_OXFMT)) options.filepath = hostOptions.filepath;
  // (The plugin that sorts classes is not ported.)
  options.tailwind = -1;
  if (piece === PIECE_BINDING) options.flavor = flavor;
  if (piece === PIECE_SCRIPT) {
    options.flavor = flavor;
    options.jsdoc = hostOptions.jsdoc;
  }
  const kinds = sourceType === SOURCE_SCRIPT ? KINDS_SCRIPT : sourceType === SOURCE_MODULE ? KINDS_MODULE : KINDS_UNKNOWN;
  const names$ = names;
  const hir$ = hir;
  const contexts$ = contexts;
  const noCursor$ = noCursor;
  const job$ = job;
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi];
    for (let ki = 0; ki < kinds.length; ki++) {
      const isScript = kinds[ki] === 1;
      if (parseFile(src, src.length, path, isScript) !== 0) continue;
      fileBegin(names$, isTypeScriptPath(path), !isScript);
      if (fileHasParseErrors()) continue;
      // TODO(port) for js-core: `refused_by_prettier_with(file, TypesInJavaScript::Refused)`.
      const text = hir$.text.subarray(0, hir$.sourceLen | 0);
      const depth = contexts$.depth;
      const cx = contextAt(depth, options);
      cx.reset(options, text, noCursor$);
      // (An expression of Angular has no comments: `JsFormatContext::new(file, options, &[])`.)
      if (job$.mode === W_ANGULAR) {
        cx.comments.begin(cx.src);
        cx.comments.n = 0;
      }
      else collectComments(cx.comments, text, options.flavor, cx.hasTreeOfBabel);
      // Only in what is known to be a script are `<!--` and `-->` comments to Babel.
      if (sourceType !== SOURCE_SCRIPT) {
        let isHtmlLike = false;
        const cm = cx.comments;
        for (let c = 0; c < cm.n; c++) {
          const at = cm.spanStart[c] | 0;
          const ch = at < text.length ? text[at] | 0 : 0;
          if (ch === 60 || ch === 45) {
            isHtmlLike = true;
            break;
          }
        }
        if (isHtmlLike) continue;
      }
      contexts$.depth = depth + 1;
      const isExpressionFile = path.charCodeAt(0) === 0;
      const written = writeJs(f, cx, options, text, isExpressionFile);
      contexts$.depth = depth;
      return written;
    }
  }
  return false;
}

const KINDS_SCRIPT: number[] = [1];
const KINDS_MODULE: number[] = [0];
const KINDS_UNKNOWN: number[] = [0, 1];

/** `f.write_embedded(context, source, |f| write(file, f))`. */
function writeJs(f: Formatter, cx: JsFormatContext, options: FormatOptions, source: Uint8Array, isExpressionFile: boolean): boolean {
  const outerContext: FormatContext = f.context;
  const outerOptions = f.options;
  const outerFlavor = f.flavor;
  const outerTabWidth = f.tabWidth;
  const jsState$ = jsState;
  const outerRoot = jsState$.expressionRootFile;
  // The job is read before anything is written: a template of JavaScript in the code may format HTML again.
  const job$ = job;
  const mode = job$.mode;
  const hug = job$.hug;
  const root = job$.root;
  const binding = job$.binding;
  const isTypescript = job$.isTypescript;
  const shown = job$.shown;
  const ignored = job$.ignored;
  const ignoredS = job$.ignoredS;
  const ignoredE = job$.ignoredE;
  const rest = job$.rest;
  f.beginEmbedded(shown === null ? source : shown, -1);
  f.context = cx;
  f.options = options;
  f.flavor = options.flavor;
  f.tabWidth = options.flavor === FLAVOR_OXFMT ? options.indentWidth : 0;
  jsState$.expressionRootFile = isExpressionFile;
  let result = false;
  switch (mode) {
    case W_STATEMENTS:
      writeStatements(f);
      result = true;
      break;
    case W_PROGRAM_IN_ATTRIBUTE: {
      const should = hugOfOtherKinds(hug);
      hugBegin(f, should);
      writeStatements(f);
      hugEnd(f, should);
      result = true;
      break;
    }
    case W_EXPRESSION:
    case W_ANGULAR: {
      const e = expressionOfFile();
      if (e < 0 || (mode === W_ANGULAR && fileHasParseErrors())) break;
      const should = hugOfExpression(hug, e, root);
      // Only in an `NGChainedExpression` is an assignment without parentheses.
      const needsParentheses = mode === W_ANGULAR && exprTag(e) === EXPR_ASSIGN && root !== HTML_ROOT_NG_ACTION;
      hugBegin(f, should);
      if (mode === W_EXPRESSION) {
        fmtExpr(e, f);
        const cm = cxOf(f).comments;
        cm.unprinted();
        formatTrailingCommentsRange(cm.from, cm.to, f);
      } else {
        if (ignored !== null) {
          writeString(f, ignored, ignoredS, ignoredE);
        } else {
          if (needsParentheses) f.token(TK_OPEN_PAREN);
          fmtExpr(e, f);
          if (needsParentheses) f.token(TK_CLOSE_PAREN);
        }
        if (rest !== null) rest.write(f);
      }
      hugEnd(f, should);
      result = true;
      break;
    }
    case W_BINDING:
      result = writeBindingFile(f, binding, isTypescript);
      break;
    default:
      break;
  }
  jsState$.expressionRootFile = outerRoot;
  f.context = outerContext;
  f.options = outerOptions;
  f.flavor = outerFlavor;
  f.tabWidth = outerTabWidth;
  if (cx.ranOutOfStack) outerContext.ranOutOfStack = true;
  f.endEmbedded();
  return result;
}

const W_ANGULAR = 4;

/** What Prettier makes of a `Program`, without the line break at the end. */
function writeStatements(f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const start = fileBodyStart();
  const len = fileBodyLen();
  // Nothing that a comment could belong to. Without a statement at all the comments keep the empty lines between them, as in `write_program`,
  // which counts on being at the start of a line.
  let isAllEmpty = true;
  for (let i = 0; i < len; i++) {
    if (stmtTag(listAt(start, i)) !== STMT_EMPTY) {
      isAllEmpty = false;
      break;
    }
  }
  const noneUnprinted = cm.unprinted() === 0;
  writeHashbang(isAllEmpty && noneUnprinted, f);
  if (isAllEmpty && (len > 0 || f.options.inHtml.isInAttribute)) {
    cm.unprinted();
    formatDanglingCommentsRange(cm.from, cm.to, DANGLING_NONE, f);
    return;
  }
  fmtStatements(start, len, f);
  cm.unprinted();
  let from = cm.from;
  const to = cm.to;
  // The empty lines before the first thing in a script go.
  if (from < to) {
    const text = cx.src.text;
    const firstStart = cm.spanStart[from] | 0;
    let blank = true;
    for (let i = 0; i < firstStart && i < text.length; i++) {
      const c = text[i] | 0;
      if (!(c === 32 || c === 9 || c === 10 || c === 12 || c === 13)) {
        blank = false;
        break;
      }
    }
    if (blank) {
      formatDanglingCommentsRange(from, from + 1, DANGLING_NONE, f);
      from = from + 1;
    }
  }
  formatTrailingCommentsRange(from, to, f);
}

/** `textToDoc(code, { parser })` for a program. `flavor`: whose output it is. Returns whether it has been written. */
export function writeProgram(p: Printer, b: Uint8Array, s: number, e: number, syntax: number, sourceType: number, inHtml: InHtml, flavor: number): boolean {
  const job$ = job;
  job$.mode = W_STATEMENTS;
  job$.shown = null;
  job$.ignored = null;
  job$.rest = null;
  const start = p.w.beginForeign();
  const r = withFile(p, b.subarray(s, e), pathsOf(syntax, b, s, e), sourceType, inHtml, PIECE_SCRIPT, flavor);
  p.w.endForeign(start);
  return r;
}

// ───────────────────────────── formatAttributeValue ─────────────────────────────

/** `shouldHugJsExpression`, for the node in the root. */
function shouldHugJsExpression(e: number, root: number): boolean {
  const tag = anTag(exprAsAstNodes(e));
  if (tag === AN_OBJECT_EXPRESSION || tag === AN_ARRAY_EXPRESSION) return true;
  if (tag === AN_TEMPLATE_LITERAL || tag === AN_STRING_LITERAL) {
    return root === HTML_ROOT_VUE_EXPRESSION || root === HTML_ROOT_NG_BINDING || root === HTML_ROOT_NG_DIRECTIVE;
  }
  return false;
}

/** The same for a root that `shouldHugJsExpression` says no to: -1 (not hugged: `Bare`), 1 `group`, 0 `printExpand`. */
export function hugOfOtherKinds(hug: number): number {
  if (hug === HUG_ALWAYS) return 1;
  if (hug === HUG_NEVER || hug === HUG_EXPRESSION) return 0;
  return -1;
}

/** Whether `formatAttributeValue` hugs a root with `e` in it: -1 it is not called. */
function hugOfExpression(hug: number, e: number, root: number): number {
  if (hug === HUG_EXPRESSION) return shouldHugJsExpression(e, root) ? 1 : 0;
  return hugOfOtherKinds(hug);
}

/** Writes `content` the way `formatAttributeValue` returns it: the start. `should`: -1 as it is, 1 group, 0 indented. */
export function hugBegin(f: Formatter, should: number): void {
  if (should === 1) f.startGroup();
  else if (should === 0) {
    f.startIndent();
    f.softLineBreak();
  }
}

export function hugEnd(f: Formatter, should: number): void {
  if (should === 1) f.endGroup();
  else if (should === 0) {
    f.endIndent();
    f.softLineBreak();
  }
}

/** The expression that the file is made of, if its text is `(`, an expression, a line break and `)`; else -1. */
function expressionOfFile(): number {
  if (fileBodyLen() !== 1) return -1;
  const stmt = listAt(fileBodyStart(), 0);
  if (stmtTag(stmt) !== STMT_EXPR) return -1;
  const e = stmtExprExpr(stmt);
  exprSpan(e);
  const start = SP[0] | 0;
  exprOuterSpan(e);
  const outerStart = SP[0] | 0;
  const outerEnd = SP[1] | 0;
  return start > 0 && outerStart === 0 && outerEnd === (hir.sourceLen | 0) ? e : -1;
}

/** What no name can be, or can be only in some places. */
const RESERVED_WORDS: Set<string> = new Set<string>([
  "arguments", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "eval", "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public", "return", "static", "super", "switch", "this", "throw",
  "true", "try", "typeof", "var", "void", "while", "with", "yield",
]);

function isNameStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
}
function isNamePart(c: number): boolean {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

/** Whether `b[s, e)` is a name. */
function isName(b: Uint8Array, s: number, e: number): boolean {
  if (s >= e || !isNameStart(b[s] | 0)) return false;
  for (let i = s + 1; i < e; i++) {
    if (!isNamePart(b[i] | 0)) return false;
  }
  return true;
}

/**
 * Most expressions in templates are `a`, `a.b.c` or `!a`. Those are written here, as `printMemberExpression` has them, without being parsed.
 * Returns whether `code` is one.
 */
function writePath(f: Formatter, b: Uint8Array, s0: number, e0: number, hug: number): boolean {
  let s = s0;
  let e = e0;
  while (s < e && isAsciiWsByte(b[s] | 0)) s = s + 1;
  while (e > s && isAsciiWsByte(b[e - 1] | 0)) e = e - 1;
  let pathS = s;
  while (pathS < e && (b[pathS] | 0) === 33) pathS = pathS + 1;
  // The names, split at `.`.
  let firstE = pathS;
  while (firstE < e && (b[firstE] | 0) !== 46) firstE = firstE + 1;
  if (!isName(b, pathS, firstE)) return false;
  let first = "";
  if (firstE - pathS <= 10) {
    for (let i = pathS; i < firstE; i++) first += String.fromCharCode(b[i] | 0);
  }
  const isThis = first === "this";
  if (RESERVED_WORDS.has(first) && !isThis) return false;
  // The rest.
  let count = 0;
  let at = firstE;
  while (at < e) {
    // at is a `.`
    let ne = at + 1;
    while (ne < e && (b[ne] | 0) !== 46) ne = ne + 1;
    if (!isName(b, at + 1, ne)) return false;
    count = count + 1;
    at = ne;
  }
  const should = hugOfOtherKinds(hug);
  hugBegin(f, should);
  // Up to the end of the first name.
  let end = firstE;
  f.textBytes(b, s, end);
  while (end < e) {
    let ne = end + 1;
    while (ne < e && (b[ne] | 0) !== 46) ne = ne + 1;
    f.lineSuffixBoundary();
    if (count === 1 && !isThis) {
      f.textBytes(b, end, ne);
    } else {
      f.startGroup();
      f.startIndent();
      f.softLineBreak();
      f.textBytes(b, end, ne);
      f.endIndent();
      f.endGroup();
    }
    end = ne;
  }
  hugEnd(f, should);
  return true;
}

function isAsciiWsByte(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

/** `formatAttributeValue(code, textToDoc, { parser })` for the parsers that take an expression. Returns whether it has been written. */
export function writeExpression(p: Printer, b: Uint8Array, s: number, e: number, isTypescript: boolean, inHtml: InHtml, hug: number): boolean {
  const f = p.w.f;
  const start = p.w.beginForeign();
  let r: boolean;
  const job$ = job;
  if (writePath(f, b, s, e, hug)) {
    r = true;
  } else {
    const wrapped = new Uint8Array(e - s + 3);
    wrapped[0] = 40;
    wrapped.set(b.subarray(s, e), 1);
    wrapped[e - s + 1] = 10;
    wrapped[e - s + 2] = 41;
    job$.mode = W_EXPRESSION;
    job$.hug = hug;
    job$.root = inHtml.root;
    job$.shown = null;
    job$.ignored = null;
    job$.rest = null;
    r = withFile(p, wrapped, isTypescript ? PATHS_EXPRESSION_TS : PATHS_EXPRESSION_JSX, SOURCE_MODULE, inHtml, PIECE_OTHER, 0);
  }
  p.w.endForeign(start);
  return r;
}

/** An expression of Angular: `code` is `(`, the expression as TypeScript, a line break and `)`. */
export function writeAngularExpressionCode(
  p: Printer,
  code: Uint8Array,
  shown: Uint8Array | null,
  ignored: Uint8Array | null,
  inHtml: InHtml,
  hug: number,
  rest: AngularRest | null,
): boolean {
  const start = p.w.beginForeign();
  // The plugin that sorts classes does not take over the parsers of Angular.
  const job$ = job;
  job$.mode = W_ANGULAR;
  job$.hug = hug;
  job$.root = inHtml.root;
  job$.shown = shown;
  job$.ignored = ignored;
  job$.ignoredS = 0;
  job$.ignoredE = ignored === null ? 0 : ignored.length;
  job$.rest = rest;
  const r = withFile(p, code, PATHS_EXPRESSION_TS, SOURCE_SCRIPT_FALSE, inHtml, PIECE_OTHER, 0);
  p.w.endForeign(start);
  return r;
}

/** `parse.call(EXPRESSION_TS, code, false, ..)`: not a script, one try, and the module/script kind is the first (module). */
const SOURCE_SCRIPT_FALSE = SOURCE_MODULE;

/** The same for a program. For `shouldHugJsExpression` the root is a `File`, which is not hugged. */
export function writeProgramInAttribute(p: Printer, b: Uint8Array, s: number, e: number, syntax: number, inHtml: InHtml, hug: number): boolean {
  const start = p.w.beginForeign();
  const job$ = job;
  job$.mode = W_PROGRAM_IN_ATTRIBUTE;
  job$.hug = hug;
  job$.shown = null;
  job$.ignored = null;
  job$.rest = null;
  const r = withFile(p, b.subarray(s, e), pathsOf(syntax, b, s, e), SOURCE_UNKNOWN, inHtml, PIECE_OTHER, 0);
  p.w.endForeign(start);
  return r;
}

/** `group(printHtmlBinding(..))`, for `before`, `code` and `after` put together. `flavor`: whose output it is. */
export function writeBinding(p: Printer, b: Uint8Array, s: number, e: number, isTypescript: boolean, inHtml: InHtml, binding: number, flavor: number): boolean {
  const before = binding === BINDING_TYPE_PARAMETERS ? "type T<" : "function _(";
  const after = binding === BINDING_TYPE_PARAMETERS ? "> = any" : ") {}";
  const program = new ByteBuf(e - s + 24);
  program.appendAscii(before);
  program.append(b, s, e);
  program.appendAscii(after);
  const bytes = program.view();
  const start = p.w.beginForeign();
  const job$ = job;
  job$.mode = W_BINDING;
  job$.binding = binding;
  job$.isTypescript = isTypescript;
  job$.shown = null;
  job$.ignored = null;
  job$.rest = null;
  const r = withFile(
    p,
    bytes,
    pathsOf(isTypescript ? SYN_BABEL_TS : SYN_BABEL, bytes, 0, bytes.length),
    SOURCE_UNKNOWN,
    inHtml,
    PIECE_BINDING,
    flavor,
  );
  p.w.endForeign(start);
  return r;
}

function writeBindingFile(f: Formatter, binding: number, isTypescript: boolean): boolean {
  if (fileBodyLen() < 1) return false;
  const statement = listAt(fileBodyStart(), 0);
  const tag = stmtTag(statement);
  if (binding === BINDING_TYPE_PARAMETERS && tag === STMT_TYPE_ALIAS) {
    const alias = stmtTypeAliasAlias(statement);
    const start = aliasTypeParamsStart(alias);
    const len = aliasTypeParamsLen(alias);
    // The root is a `File`, which `shouldHugJsExpression` has nothing to say about.
    hugBegin(f, 0);
    for (let i = 0; i < len; i++) {
      if (i > 0) {
        f.token(COMMA);
        f.softLineBreakOrSpace();
      }
      fmtTypeParam(listAt(start, i), f);
    }
    hugEnd(f, 0);
    return true;
  }
  if (binding !== BINDING_TYPE_PARAMETERS && tag === STMT_FN) {
    const func = stmtFnFn(statement);
    const thisParam = funcThisParam(func);
    // Only TypeScript has it.
    if (thisParam >= 0 && !isTypescript) return false;
    const start = funcParamsStart(func);
    const len = funcParamsLen(func);
    const count = len + (thisParam >= 0 ? 1 : 0);
    const needsParentheses = binding === BINDING_FOR_LEFT && count !== 1;
    f.startGroup();
    if (needsParentheses) {
      f.token(TK_OPEN_PAREN);
      f.startIndent();
      f.softLineBreak();
      f.startGroup();
    }
    let index = 0;
    if (thisParam >= 0) {
      fmtParam(thisParam, f);
      index = 1;
    }
    for (let i = 0; i < len; i++) {
      if (index > 0) {
        f.token(COMMA);
        f.softLineBreakOrSpace();
      }
      index = index + 1;
      fmtParam(listAt(start, i), f);
    }
    if (needsParentheses) {
      f.endGroup();
      f.endIndent();
      f.softLineBreak();
      f.token(TK_CLOSE_PAREN);
    }
    f.endGroup();
    return true;
  }
  return false;
}

// ───────────────────────────── `"` in the value of an attribute ─────────────────────────────

/** `(doc) => (typeof doc === "string" ? doc.replaceAll('"', "&quot;") : doc)` */
class QuoteEntities extends StringMapper {
  changes(buf: Uint8Array, s: number, e: number): boolean {
    for (let i = s; i < e; i++) {
      if ((buf[i] | 0) === 34) return true;
    }
    return false;
  }

  write(buf: Uint8Array, s: number, e: number, isOneString: boolean, f: Formatter): void {
    const replaced = new ByteBuf(e - s + 16);
    for (let i = s; i < e; i++) {
      const c = buf[i] | 0;
      if (c === 34) replaced.appendAscii("&quot;");
      else replaced.push(c);
    }
    if (isOneString) writeString(f, replaced.data, 0, replaced.len);
    else f.textBytes(replaced.data, 0, replaced.len);
  }
}

const quoteEntities = new QuoteEntities();

/** Writes `content`, which has been captured, as the value of an attribute between double quotes. */
export function writeWithQuoteEntities(f: Formatter, content: number): void {
  writeMapped(f, content, quoteEntities);
}

void FORMAT_OK;
void HTML_ROOT_JS_EXPRESSION;
void HTML_ROOT_PROGRAM;
void I32Vec;
void lx;
void exprSpan;
