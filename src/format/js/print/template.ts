// Port of vendor/bun/src/format/js/print/template.rs: template literals. Prettier's `printTemplateLiteral`.
//
// The text is written as it is. What is in `${}` is formatted, but kept on one line unless it has a line break in the source.
//
// Also the JavaScript half of the templates that are written as another language (Prettier's `embed`): CSS (`css/embed.rs`), GraphQL
// (`graphql/embed.rs`), Markdown (`markdown/embed.rs`). The formatters of those languages are in `format/{css,graphql,markdown}/embed.ts`; what asks
// the handles of the JavaScript file is here. HTML (`html/in_js.rs`) is not ported: a template in HTML is written as it is.
//
// A template is `(isType, h)`: `isType` false, `h` the Expr of `` `a${b}c` ``; true, `h` the TypeNode of a template literal type.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { BACKTICK, RBRACE } from "../../ir/tokens.ts";
import { EMBEDDED_AUTO, FLAVOR_OXFMT } from "../../options.ts";
import { hasEmbedLabel as gqlHasEmbedLabel, writeTemplate as gqlWriteTemplate } from "../../graphql/embed.ts";
import { printEmbedCss } from "../../css/embed.ts";
import { writeMarkdownTemplate } from "../../markdown/embed.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../../text.ts";
import {
  EXPR_AS_CONST,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_INDEX,
  EXPR_JSX,
  EXPR_NON_NULL,
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  EXPR_CALL,
  EXPR_AS,
  EXPR_SATISFIES,
  KEY_IDENT,
  KEY,
  KEY_NAME,
  PROP_INIT,
  SP,
  callArgsLen,
  callArgsStart,
  callCallee,
  callTemplate,
  callTypeArgsLen,
  callTypeArgsStart,
  exprAsConstExpr,
  exprAsExpr,
  exprCallCall,
  exprCallee,
  exprDotName,
  exprDotObj,
  exprIdentName,
  exprIndexObj,
  exprIsParenthesized,
  exprNonNullExpr,
  exprOuterStart,
  exprSatisfiesExpr,
  exprSpan,
  exprEnd,
  exprStart,
  exprTag,
  exprTaggedTemplateCall,
  exprTemplateCooked,
  exprTemplateExprsLen,
  exprTemplateExprsStart,
  exprTemplateQuasiCount,
  exprTemplateQuasiSpan,
  exprTemplateRawSpan,
  hir,
  jsxAttrsLen,
  jsxAttrsStart,
  jsxTag,
  keyLoad,
  listAt,
  nameBuf,
  nameIs,
  nameLen,
  nameStart,
  nodeOfExpr,
  nodeOfProp,
  propKind,
  typeListAngleBrackets,
  typeSpan,
  typeTemplateCooked,
  typeTemplateQuasiCount,
  typeTemplateQuasiSpan,
  typeTemplateRawSpan,
  typeTemplateTypesLen,
  typeTemplateTypesStart,
} from "../../../lint/ast/index.ts";
import {
  AN_ARRAY_EXPRESSION,
  AN_BINARY_EXPRESSION,
  AN_CALL_EXPRESSION,
  AN_CONDITIONAL_EXPRESSION,
  AN_DECORATOR,
  AN_IDENTIFIER_REFERENCE,
  AN_JSX_ATTRIBUTE,
  AN_JSX_ELEMENT,
  AN_JSX_EXPRESSION_CONTAINER,
  AN_LOGICAL_EXPRESSION,
  AN_OBJECT_EXPRESSION,
  AN_OBJECT_PROPERTY,
  AN_PRIVATE_IN_EXPRESSION,
  AN_SEQUENCE_EXPRESSION,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_COMPUTED_MEMBER_EXPRESSION,
  AN_TAGGED_TEMPLATE_EXPRESSION,
  AN_TS_AS_EXPRESSION,
  AN_TS_SATISFIES_EXPRESSION,
  anId,
  anIsExpressionStatement,
  anParent,
  anStart,
  anTag,
  exprAsAstNodes,
  exprAsChainElement,
  exprAstParent,
  propAsAstNodes,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { WK_EXPR, fmtExpr, fmtType } from "../format.ts";
import { formatLeadingCommentsRange, formatTrailingCommentsRange } from "../trivia.ts";
import { isTestEachPattern } from "../utils/call_expression.ts";
import { fmtNodeWithoutTrailingComments } from "../utils/format_node_without_trailing_comments.ts";
import { typeArguments } from "./type_parameters.ts";
import { EachCell, EachTable, JsGqlTemplate } from "./template_types.ts";
import { PLACE_UNKNOWN, PLACE_START_OF_LINE, PLACE_AFTER } from "./template.consts.ts";
import { GRAPHQL_LANGUAGE } from "./template.consts.ts";

const T_DOLLAR_LBRACE = token("${");
const T_DOLLAR_BRACES = token("${}");
const T_EMPTY_TEMPLATE = token("``");
const T_PIPE = token("|");

// ───────────────────────────── the template, as an Expr or a TypeNode ─────────────────────────────

function quasiCountOf(isType: boolean, h: number): number {
  return isType ? typeTemplateQuasiCount(h) : exprTemplateQuasiCount(h);
}
/** The text of quasi `i` as it is written (into `SP`). */
function rawSpanOf(isType: boolean, h: number, i: number): void {
  if (isType) typeTemplateRawSpan(h, i);
  else exprTemplateRawSpan(h, i);
}
function quasiSpanOf(isType: boolean, h: number, i: number): void {
  if (isType) typeTemplateQuasiSpan(h, i);
  else exprTemplateQuasiSpan(h, i);
}
function substitutionCount(isType: boolean, h: number): number {
  return isType ? typeTemplateTypesLen(h) : exprTemplateExprsLen(h);
}
function substitutionAt(isType: boolean, h: number, i: number): number {
  return listAt(isType ? typeTemplateTypesStart(h) : exprTemplateExprsStart(h), i);
}

// ───────────────────────────── the entry ─────────────────────────────

/** Whether Prettier's `embed` can have anything to say about the template `e`. About most it has not. */
function canBeInAnotherLanguage(e: number, f: Formatter): boolean {
  const parent = exprAstParent(e);
  switch (anTag(parent)) {
    case AN_TAGGED_TEMPLATE_EXPRESSION:
    case AN_JSX_EXPRESSION_CONTAINER:
    case AN_OBJECT_PROPERTY:
    case AN_ARRAY_EXPRESSION:
      return true;
    case AN_CALL_EXPRESSION: {
      const callee = callCallee(exprCallCall(anId(parent)));
      if (callee >= 0 && exprTextIs(callee, "graphql")) return true;
      break;
    }
    default:
      break;
  }
  return isBehindComment(e, f);
}

/** The text of `e` is `lit` (ASCII). */
function exprTextIs(e: number, lit: string): boolean {
  exprSpan(e);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  if ((SP$.s1 | 0) - s !== lit.length) return false;
  const t = hir.text;
  for (let k = 0; k < lit.length; k++) if ((t[s + k] | 0) !== lit.charCodeAt(k)) return false;
  return true;
}

/** `` `a${b}c` `` */
export function writeTemplateLiteral(e: number, f: Formatter): void {
  if (!canBeInAnotherLanguage(e, f) || (!writeCssTemplate(e, f) && !writeGraphqlTemplate(e, f) && !writeMarkdownEmbed(e, f))) {
    // TODO(port): html/in_js.rs (HTML in a template: written as it is).
    writeTemplateLike(false, e, f);
  }
}

/**
 * `${e}` at `i` in a template that is written as the language in it. Prettier's `printEmbeddedTemplateExpressions`. `e`: the template.
 */
export function writeEmbeddedTemplateExpression(e: number, i: number, f: Formatter): void {
  if (i >= substitutionCount(false, e)) return;
  writeTemplateExpression(false, e, i, PLACE_UNKNOWN, 0, f);
}

/** For oxfmt every comment between a tag and its template leads the template. For Prettier one that ends its line trails the tag. */
function commentsBehindTagLeadTheTemplate(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `` tag`a${b}c` `` */
export function writeTaggedTemplateExpression(e: number, call: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const typeArgsStart = callTypeArgsStart(call);
  const typeArgsLen = callTypeArgsLen(call);
  let tagEnd: number;
  const SP$ = SP;
  if (typeListAngleBrackets(typeArgsStart, typeArgsLen)) tagEnd = SP$.s1 | 0;
  else {
    tagEnd = exprEnd(callCallee(call));
  }
  const leadsTemplate = commentsBehindTagLeadTheTemplate(f);
  const limited = leadsTemplate && !cx.isQuiet;
  const viewLimit = limited ? cm.limitCommentsUpTo(tagEnd) : 0;
  fmtExpr(callCallee(call), f);
  typeArguments(typeArgsStart, typeArgsLen, nodeOfExpr(e), f);
  if (limited) cm.restoreViewLimit(viewLimit);
  const quasi = callTemplate(call);
  if (quasi < 0) return;

  const quasiStart = exprStart(quasi);
  const n = cm.commentsBefore(quasiStart);
  const from = cm.from;
  if (n > 0) {
    if (cx.src.containsNewline(tagEnd, cm.spanStart[from] | 0)) f.softLineBreak();
    else f.space();
  }
  if (leadsTemplate) {
    formatLeadingCommentsRange(from, (from + n) | 0, f);
    f.lineSuffixBoundary();
  } else {
    f.lineSuffixBoundary();
    formatLeadingCommentsRange(from, (from + n) | 0, f);
  }

  if (exprTag(quasi) !== EXPR_TEMPLATE) return;
  // Without a header it is not a table.
  let isTable = false;
  if (isTestEachPattern(callCallee(call))) {
    exprTemplateRawSpan(quasi, 0);
    isTable = trimJsWhitespaceStart(f.source, SP$.s0 | 0, SP$.s1 | 0) < (SP$.s1 | 0);
  }
  if (isTable) writeEachTemplateTable(quasi, f);
  else writeTemplateLiteral(quasi, f);
}

/** `` `a${B}c` `` in a type */
export function writeTsTemplateLiteralType(ty: number, f: Formatter): void {
  writeTemplateLike(true, ty, f);
}

// ───────────────────────────── the text and the substitutions ─────────────────────────────


/** The indentation (in columns) of the last line of `text[a, b)`. If it is all on one line, `previous`. */
function indentionAfterLastNewLine(text: Uint8Array, a: number, b: number, tabWidth: number, previous: number): number {
  let newLine = -1;
  for (let i = b - 1; i >= a; i--) {
    const c = text[i] | 0;
    if (c === 10 || c === 13) {
      newLine = i;
      break;
    }
  }
  if (newLine < 0) return previous;
  let size = 0;
  const tw = tabWidth > 0 ? tabWidth : 1;
  for (let i = newLine + 1; i < b; i++) {
    const c = text[i] | 0;
    if (c === 9) size = size + tw - (size % tw);
    else if (c === 32) size = size + 1;
    else break;
  }
  return size;
}

const CRLF = new ByteBuf(256);

/** `write!(f, text(raw))` for `raw = f.source[a, b)`: `\r\n` and `\r` are `\n`. */
function writeRawText(a: number, b: number, f: Formatter): void {
  const src = f.source;
  let hasCr = false;
  for (let i = a; i < b; i++) {
    if ((src[i] | 0) === 13) {
      hasCr = true;
      break;
    }
  }
  if (!hasCr) {
    f.textSource(a, b);
    return;
  }
  const buf = f.textBuf();
  const at = buf.len;
  let i = a;
  while (i < b) {
    const c = src[i] | 0;
    if (c === 13) {
      buf.push(10);
      i = i + (i + 1 < b && (src[i + 1] | 0) === 10 ? 2 : 1);
    } else {
      buf.push(c);
      i = i + 1;
    }
  }
  f.endBuiltText(at);
}

/** `TemplateLike::fmt`: `` `a${b}c` `` */
function writeTemplateLike(isType: boolean, h: number, f: Formatter): void {
  f.lineSuffixBoundary();
  f.token(BACKTICK);
  const count = quasiCountOf(isType, h);
  const nSubstitutions = substitutionCount(isType, h);
  const tabWidth = f.options.indentWidth;
  const src = f.source;
  let indention = 0;
  const SP$ = SP;
  for (let i = 0; i < count; i++) {
    rawSpanOf(isType, h, i);
    const a = SP$.s0 | 0;
    const b = SP$.s1 | 0;
    writeRawText(a, b, f);
    // TODO(port): cursor.rs (`around_node_at`)
    indention = indentionAfterLastNewLine(src, a, b, tabWidth, indention);
    if (i < nSubstitutions) {
      const last = b > a ? src[b - 1] | 0 : 0;
      if (indention === 0 && (last === 10 || last === 13)) writeTemplateExpression(isType, h, i, PLACE_START_OF_LINE, 0, f);
      else writeTemplateExpression(isType, h, i, PLACE_AFTER, indention, f);
    }
  }
  f.token(BACKTICK);
}

/** `${e}` at `i`. `place`: `PLACE_*`; `cols`: the indentation of the line, for `PLACE_AFTER`. */
function writeTemplateExpression(isType: boolean, h: number, i: number, place: number, cols: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  // What is between the `${` and the `}`.
  quasiSpanOf(isType, h, i);
  const SP$ = SP;
  const interpolationStart = SP$.s1 | 0;
  quasiSpanOf(isType, h, i + 1);
  const interpolationEnd = SP$.s0 | 0;
  const item = substitutionAt(isType, h, i);

  let hasCommentInExpression = false;
  const slot = f.startCapture();
  if (!isType) {
    exprSpan(item);
    const es = SP$.s0 | 0;
    const ee = SP$.s1 | 0;
    hasCommentInExpression = !cx.isQuiet && (cm.hasCommentBefore(es) || cm.hasCommentInRange(ee, interpolationEnd));
    if (exprTag(item) === EXPR_JSX) fmtExpr(item, f);
    else fmtNodeWithoutTrailingComments(WK_EXPR, item, f);
    if (!cx.isQuiet) {
      const n = cm.commentsBefore(interpolationEnd);
      const from = cm.from;
      formatTrailingCommentsRange(from, (from + n) | 0, f);
    }
  } else fmtType(item, f);
  const element = f.endCapture(slot);
  if (element < 0) {
    f.token(T_DOLLAR_BRACES);
    return;
  }

  const src = f.source;
  let hasLineBreak = false;
  for (let k = interpolationStart; k < interpolationEnd; k++) {
    const c = src[k] | 0;
    if (c === 10 || c === 13) {
      hasLineBreak = true;
      break;
    }
  }
  const isFit = hasLineBreak || f.willBreak(element);

  // Whether the content is indented, for `Fit`.
  let indentContent = false;
  if (isFit && !isType) {
    // Prettier's `stripChainElementWrappers`
    let stripped = item;
    while (exprTag(stripped) === EXPR_NON_NULL) stripped = exprNonNullExpr(stripped);
    const st = exprTag(stripped);
    if (hasCommentInExpression || st === EXPR_DOT || st === EXPR_INDEX) indentContent = true;
    else {
      const t = anTag(exprAsAstNodes(item));
      indentContent =
        t === AN_CONDITIONAL_EXPRESSION ||
        t === AN_SEQUENCE_EXPRESSION ||
        t === AN_TS_AS_EXPRESSION ||
        t === AN_TS_SATISFIES_EXPRESSION ||
        t === AN_BINARY_EXPRESSION ||
        t === AN_LOGICAL_EXPRESSION ||
        t === AN_PRIVATE_IN_EXPRESSION ||
        t === AN_IDENTIFIER_REFERENCE;
    }
  }

  f.startGroup();
  f.token(T_DOLLAR_LBRACE);
  // `write_with_indention`: written indented like the line of the template that it starts on, whatever the template itself is indented by.
  let level = 0;
  let spaces = 0;
  let dedentToRoot = false;
  if (place === PLACE_START_OF_LINE) dedentToRoot = true;
  else if (place === PLACE_AFTER) {
    const iw = f.options.indentWidth > 0 ? f.options.indentWidth : 1;
    level = (cols / iw) | 0;
    spaces = cols % iw;
    dedentToRoot = level !== 0 || spaces !== 0;
  }
  if (dedentToRoot) {
    f.startDedentToRoot();
    if (spaces > 0) f.startAlign(spaces);
    for (let k = 0; k < level; k++) f.startIndent();
  }
  if (!isFit) {
    // One string, as it is for Prettier: a placeholder in it is going to be a document, which is in nothing of this.
    if (f.options.htmlTemplateDepth > 0) {
      const s1 = f.startCapture();
      const s2 = f.startCapture();
      f.writeInterned(element);
      f.endWithoutSoftLines(s2);
      const printedHandle = f.endCapture(s1);
      const printed = new ByteBuf(64);
      if (printedHandle >= 0 && f.printToText(printedHandle, printed)) f.textBytes(printed.data, 0, printed.len);
    } else {
      const s = f.startCapture();
      f.writeInterned(element);
      f.endWithoutSoftLines(s);
    }
  } else if (indentContent) {
    f.startSoftBlockIndent();
    f.writeInterned(element);
    f.endSoftBlockIndent();
  } else f.writeInterned(element);
  if (dedentToRoot) {
    for (let k = 0; k < level; k++) f.endIndent();
    if (spaces > 0) f.endAlign(spaces);
    f.endDedentToRoot();
  }
  f.lineSuffixBoundary();
  f.token(RBRACE);
  f.endGroup();
}

// ───────────────────────────── describe.each`..` ─────────────────────────────

/**
 * Prettier's `printJestEachTemplateLiteral`: the columns are aligned.
 *
 * ```js
 * describe.each`
 *   a    | b    | expected
 *   ${1} | ${1} | ${2}
 *   ${11} | ${1} | ${12}
 * `
 * ```
 */
const NO_BYTES = new Uint8Array(0);

function writeEachTemplateTable(e: number, f: Formatter): void {
  const table = new EachTable();
  const src = f.source;
  const flavor = f.options.flavor;
  void flavor;

  exprTemplateRawSpan(e, 0);
  const SP$ = SP;
  const hs = SP$.s0 | 0;
  let he = SP$.s1 | 0;
  if (he > hs && (src[he - 1] | 0) === 124) he = he - 1;
  let colStart = hs;
  for (let i = hs; i <= he; i++) {
    if (i === he || (src[i] | 0) === 124) {
      const a = trimJsWhitespaceStart(src, colStart, i);
      const b = a < i ? trimJsWhitespaceEnd(src, a, i) : a;
      const bytes = src.slice(a, b);
      table.entry(new EachCell(bytes, f.stringWidth(bytes, 0, bytes.length), false, false));
      colStart = i + 1;
    }
  }
  table.entry(new EachCell(NO_BYTES, 0, false, true));

  const count = exprTemplateQuasiCount(e);
  const nSubstitutions = exprTemplateExprsLen(e);
  const tabWidth = f.options.indentWidth;
  let indention = 0;
  for (let index = 0; index < nSubstitutions; index++) {
    // `TemplateLike::expressions(true)`
    exprTemplateRawSpan(e, index);
    const a = SP$.s0 | 0;
    const b = SP$.s1 | 0;
    indention = indentionAfterLastNewLine(src, a, b, tabWidth, indention);
    const shown = indention > tabWidth ? indention : tabWidth;
    const last = b > a ? src[b - 1] | 0 : 0;
    const s1 = f.startCapture();
    const s2 = f.startCapture();
    if (shown === 0 && (last === 10 || last === 13)) writeTemplateExpression(false, e, index, PLACE_START_OF_LINE, 0, f);
    else writeTemplateExpression(false, e, index, PLACE_AFTER, shown, f);
    f.endWithoutSoftLines(s2);
    const handle = f.endCapture(s1);
    const out = new ByteBuf(32);
    if (handle >= 0) f.printToText(handle, out);
    const bytes = out.data.slice(0, out.len);
    let willBreak = false;
    for (let k = 0; k < bytes.length; k++) {
      if ((bytes[k] | 0) === 10) {
        willBreak = true;
        break;
      }
    }
    table.entry(new EachCell(bytes, f.stringWidth(bytes, 0, bytes.length), willBreak, false));

    if (index + 1 < count) {
      exprTemplateRawSpan(e, index + 1);
      let hasBreak = false;
      for (let k = SP$.s0 | 0; k < (SP$.s1 | 0); k++) {
        const c = src[k] | 0;
        if (c === 10 || c === 13) {
          hasBreak = true;
          break;
        }
      }
      if (hasBreak) table.entry(new EachCell(NO_BYTES, 0, false, true));
    }
  }
  table.nextRow();

  f.lineSuffixBoundary();
  f.token(BACKTICK);
  f.startIndent();
  // table_content
  let currentColumn = 0;
  let currentRow = 0;
  f.hardLineBreak();
  const n = table.elements.length;
  for (let k = 0; k < n; k++) {
    const element = table.elements[k];
    const isLast = k + 1 === n;
    const isLastInRow = isLast || table.elements[k + 1].isBreak;
    if (!element.isBreak) {
      const isAligned = !isLastInRow && currentRow < table.rows.length && table.rows[currentRow] === false;
      const columnWidth = currentColumn < table.columnsWidth.length ? table.columnsWidth[currentColumn] : 0;
      const buf = f.textBuf();
      const at = buf.len;
      if (currentColumn !== 0 && (!isLastInRow || element.text.length > 0)) buf.push(32);
      buf.append(element.text, 0, element.text.length);
      if (isAligned && columnWidth > element.width) buf.fill(32, columnWidth - element.width);
      if (!isLastInRow) buf.push(32);
      f.endBuiltText(at);
      if (!isLastInRow) f.token(T_PIPE);
      currentColumn = currentColumn + 1;
    } else {
      currentColumn = 0;
      currentRow = currentRow + 1;
      if (!isLast) f.hardLineBreak();
    }
  }
  f.endIndent();
  f.hardLineBreak();
  f.token(BACKTICK);
}

// ───────────────────────────── is this template in another language? ─────────────────────────────

function isIdentifierNamed(e: number, name: string): boolean {
  return exprTag(e) === EXPR_IDENT && nameIs(exprIdentName(e), name);
}

/** The object of `e`, if it is a `MemberExpression` (not a private field): -1 otherwise. */
function memberObject(e: number): number {
  const t = anTag(exprAsChainElement(e));
  if (t === AN_STATIC_MEMBER_EXPRESSION) return exprDotObj(e);
  if (t === AN_COMPUTED_MEMBER_EXPRESSION) return exprIndexObj(e);
  return -1;
}

/** The callee of `e`, if it is a `CallExpression`: -1 otherwise. */
function callCalleeOf(e: number): number {
  return anTag(exprAsChainElement(e)) === AN_CALL_EXPRESSION ? exprCallee(e) : -1;
}

/** `Component.extend` */
function isStyledExtend(e: number): boolean {
  if (exprTag(e) !== EXPR_DOT || memberObject(e) < 0) return false;
  if (!nameIs(exprDotName(e), "extend")) return false;
  const obj = exprDotObj(e);
  if (exprTag(obj) !== EXPR_IDENT) return false;
  const c = hir.text[exprStart(obj)] | 0;
  return c >= 65 && c <= 90;
}

function isStyledObject(e: number): boolean {
  const object = memberObject(e);
  return (object >= 0 && isIdentifierNamed(object, "styled")) || isStyledExtend(e);
}

/** `isStyledComponents`, and the first half of `isStyledJsx`. `tag`: of the template. */
function isStyledTag(tag: number): boolean {
  // css``, css.global``, css.resolve``
  if (isIdentifierNamed(tag, "css")) return true;
  if (exprTag(tag) === EXPR_DOT && memberObject(tag) >= 0 && isIdentifierNamed(exprDotObj(tag), "css")) {
    const name = exprDotName(tag);
    if (nameIs(name, "global") || nameIs(name, "resolve")) return true;
  }
  // styled.foo``, Component.extend``
  if (isStyledObject(tag)) return true;
  const callee = callCalleeOf(tag);
  if (callee < 0) return false;
  // styled(Component)``
  if (isIdentifierNamed(callee, "styled")) return true;
  const object = memberObject(callee);
  if (object < 0) return false;
  // styled.foo.attrs({})``, Component.extend.attrs({})``, styled(Component).attrs({})``
  if (isStyledObject(object)) return true;
  const inner = callCalleeOf(object);
  return inner >= 0 && isIdentifierNamed(inner, "styled");
}

/** Whether the property `p` is named `name`. */
function propHasName(p: number, name: string): boolean {
  return keyLoad(nodeOfProp(p)) === KEY_IDENT && nameIs(KEY.s1 | 0, name);
}

/** Whether `property` (an `AstNodes`) is the property `name` of the object in `@Component({ .. })`. */
function isAngularComponentProperty(property: number, name: string): boolean {
  if (anTag(property) !== AN_OBJECT_PROPERTY) return false;
  const object = anParent(property);
  if (anTag(object) !== AN_OBJECT_EXPRESSION) return false;
  const call = anParent(object);
  if (anTag(call) !== AN_CALL_EXPRESSION) return false;
  const callee = exprCallee(anId(call));
  // The name last: nearly every property has been told apart by then.
  return (
    callee >= 0 &&
    callee !== anId(object) &&
    isIdentifierNamed(callee, "Component") &&
    anTag(anParent(call)) === AN_DECORATOR &&
    propKind(anId(property)) === PROP_INIT &&
    propHasName(anId(property), name)
  );
}

/** oxc's `get_tag_name`: the name that a tag starts with, `a` of `a.b(c)[d]`, whatever TypeScript has put around it. -1: none. */
function rootNameOfTag(tag0: number): number {
  let tag = tag0;
  while (true) {
    switch (exprTag(tag)) {
      case EXPR_IDENT:
        return tag;
      case EXPR_DOT:
        tag = exprDotObj(tag);
        break;
      case EXPR_INDEX:
        tag = exprIndexObj(tag);
        break;
      case EXPR_CALL:
        tag = callCallee(exprCallCall(tag));
        break;
      case EXPR_AS:
        tag = exprAsExpr(tag);
        break;
      case EXPR_SATISFIES:
        tag = exprSatisfiesExpr(tag);
        break;
      case EXPR_AS_CONST:
        tag = exprAsConstExpr(tag);
        break;
      case EXPR_NON_NULL:
        tag = exprNonNullExpr(tag);
        break;
      default:
        return -1;
    }
    if (tag < 0) return -1;
  }
}

function rootNameIs(tag: number, a: string, b: string): boolean {
  const root = rootNameOfTag(tag);
  if (root < 0) return false;
  const atom = exprIdentName(root);
  return nameIs(atom, a) || nameIs(atom, b);
}

/** Prettier's `isEmbedCss`. `e`: a template. */
function isEmbedCss(e: number, f: Formatter): boolean {
  const parent = exprAstParent(e);
  switch (anTag(parent)) {
    case AN_TAGGED_TEMPLATE_EXPRESSION: {
      const call = exprTaggedTemplateCall(anId(parent));
      const callee = callCallee(call);
      if (callee === e) return false;
      return f.options.flavor === FLAVOR_OXFMT ? rootNameIs(callee, "css", "styled") : isStyledTag(callee);
    }
    case AN_JSX_EXPRESSION_CONTAINER: {
      const up = anParent(parent);
      const ut = anTag(up);
      if (ut === AN_JSX_ELEMENT) {
        // <style jsx>{`div{color:red}`}</style>
        const element = anId(up);
        const tag = jsxTag(element);
        if (tag < 0 || !isIdentifierNamed(tag, "style")) return false;
        const s = jsxAttrsStart(element);
        const n = jsxAttrsLen(element);
        for (let i = 0; i < n; i++) if (propHasName(listAt(s, i), "jsx")) return true;
        return false;
      }
      // <div css={`color: red`} />
      if (ut === AN_JSX_ATTRIBUTE) return propHasName(anId(up), "css");
      return false;
    }
    default: {
      // `isAngularComponentStyles`: `@Component({ styles: [`..`] })`
      const property = anTag(parent) === AN_ARRAY_EXPRESSION ? anParent(parent) : parent;
      return isAngularComponentProperty(property, "styles");
    }
  }
}

/** The raw text of quasi `i` of the template expression `e` as `Uint8Array`s, for `printEmbedCss`. */
function quasisOf(e: number, f: Formatter): Uint8Array[] {
  const n = exprTemplateQuasiCount(e);
  const out: Uint8Array[] = [];
  const SP$ = SP;
  for (let i = 0; i < n; i++) {
    exprTemplateRawSpan(e, i);
    out.push(f.source.subarray(SP$.s0 | 0, SP$.s1 | 0));
  }
  return out;
}

function allCooked(e: number): boolean {
  const n = exprTemplateQuasiCount(e);
  for (let i = 0; i < n; i++) if (exprTemplateCooked(e, i) < 0) return false;
  return true;
}

function isBlankTemplate(e: number, f: Formatter): boolean {
  if (exprTemplateQuasiCount(e) !== 1) return false;
  exprTemplateRawSpan(e, 0);
  const SP$ = SP;
  return trimJsWhitespaceStart(f.source, SP$.s0 | 0, SP$.s1 | 0) >= (SP$.s1 | 0);
}

function isCssCandidate(e: number, f: Formatter): boolean {
  return f.options.embeddedLanguageFormatting === EMBEDDED_AUTO && allCooked(e) && isEmbedCss(e, f);
}

/** Prettier's `embed` for style sheets. Returns whether it has written the template `e`. */
function writeCssTemplate(e: number, f: Formatter): boolean {
  if (!isCssCandidate(e, f)) return false;
  if (isBlankTemplate(e, f)) {
    f.token(T_EMPTY_TEMPLATE);
    return true;
  }
  return printEmbedCss(quasisOf(e, f), f.options, f, (n: number): void => writeEmbeddedTemplateExpression(e, n, f));
}

// ───────────────────────────── GraphQL ─────────────────────────────

/** Whether all of `text[a, b)` is JavaScript white space. */
function isAllJsWhitespace(text: Uint8Array, a: number, b: number): boolean {
  return trimJsWhitespaceStart(text, a, b) >= b;
}

/**
 * Whether a block comment with exactly `language` in it, like ` GraphQL `, is right before `start`, with nothing but other comments between.
 * `isStatement`: a statement starts at `start`, and empty statements before it are nothing either.
 */
function followsLanguageComment(start: number, isStatement: boolean, language: string, f: Formatter): boolean {
  const cx = cxOf(f);
  const cm = cx.comments;
  const text = f.source;
  // The unprinted comments before `start` and the printed ones are one run of indices, `[0, to)`.
  const n = cm.commentsBefore(start);
  let index = (cm.from + n - 1) | 0;
  let position = start;
  let hasEmptyStatement = false;
  const SP$ = SP;
  while (index >= 0) {
    const comment = index;
    index = (index - 1) | 0;
    const spanEnd = cm.spanEnd[comment] | 0;
    if (spanEnd > position) return false;
    if (!isAllJsWhitespace(text, spanEnd, position)) {
      if (!isStatement) return false;
      // split(between, ';').all(is_all_js_whitespace)
      let from = spanEnd;
      for (let k = spanEnd; k <= position; k++) {
        if (k === position || (text[k] | 0) === 59) {
          if (!isAllJsWhitespace(text, from, k)) return false;
          from = k + 1;
        }
      }
      hasEmptyStatement = true;
    }
    position = cm.spanStart[comment] | 0;
    if (!cm.isBlock(comment)) continue;
    cm.contentSpan(comment);
    const cs = SP$.s0 | 0;
    const ce = SP$.s1 | 0;
    let same = ce - cs === language.length;
    for (let k = 0; same && k < language.length; k++) if ((text[cs + k] | 0) !== language.charCodeAt(k)) same = false;
    if (!same) continue;
    if (!hasEmptyStatement) return true;
    // Behind a statement on the same line, it trails that. So do the comments before it.
    let first = comment;
    while (index >= 0) {
      const previous = index;
      if (cm.precededByNewline(first) || !isAllJsWhitespace(text, cm.spanEnd[previous] | 0, cm.spanStart[first] | 0)) break;
      first = previous;
      index = (index - 1) | 0;
    }
    if (cm.precededByNewline(first)) return true;
    // trim_js_whitespace(source[..first.span.start]) is empty or ends with `{`
    const end = trimJsWhitespaceEnd(text, 0, cm.spanStart[first] | 0);
    const begin = trimJsWhitespaceStart(text, 0, end);
    return begin >= end || (text[end - 1] | 0) === 123;
  }
  return false;
}

/** Whether the comment leads `e`. A comment leads the outermost of the nodes that start behind it, and parentheses are not nodes. */
function isLedByLanguageComment(e: number, parent: number, language: string, f: Formatter): boolean {
  const outerStart = exprOuterStart(e);
  const start = exprStart(e);
  return (exprIsParenthesized(e) && followsLanguageComment(start, false, language, f)) || (anStart(parent) !== outerStart && followsLanguageComment(outerStart, false, language, f));
}

/** Whether a comment is before `e`, with nothing but white space, `(`, `;` and comments between. No other comment says what language the template `e` is in. */
function isBehindComment(e: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  const start = exprStart(e);
  const n = cm.commentsBefore(start);
  const nearest = n > 0 ? (cm.from + n - 1) | 0 : cm.lastPrinted();
  if (nearest < 0) return false;
  const end = cm.spanEnd[nearest] | 0;
  if (end > start) return true;
  const text = f.source;
  for (let k = end; k < start; k++) {
    const b = text[k] | 0;
    if (!(b === 40 || b === 59 || b >= 0x80 || b === 32 || b === 9 || b === 10 || b === 12 || b === 13)) return false;
  }
  return true;
}

/** Prettier's `hasLanguageComment`. `language`: what is between the `/*` and the `*&#47;`. */
function hasLanguageComment(e: number, parent: number, language: string, f: Formatter): boolean {
  if (!isBehindComment(e, f)) return false;
  if (isLedByLanguageComment(e, parent, language, f)) return true;
  if (anIsExpressionStatement(parent)) return followsLanguageComment(anStart(parent), true, language, f);
  if (anTag(parent) === AN_TS_AS_EXPRESSION) {
    const cast = anId(parent);
    return exprTag(cast) === EXPR_AS_CONST && isLedByLanguageComment(cast, anParent(parent), language, f);
  }
  return false;
}

/** Prettier's `isEmbedGraphQL`. `e`: a template. */
function isEmbedGraphql(e: number, f: Formatter): boolean {
  const parent = exprAstParent(e);
  let isMarked = false;
  const pt = anTag(parent);
  if (pt === AN_TAGGED_TEMPLATE_EXPRESSION) {
    const callee = callCallee(exprTaggedTemplateCall(anId(parent)));
    if (f.options.flavor === FLAVOR_OXFMT) isMarked = rootNameIs(callee, "gql", "graphql");
    else if (exprTag(callee) === EXPR_DOT) {
      isMarked =
        anTag(exprAsChainElement(callee)) === AN_STATIC_MEMBER_EXPRESSION &&
        isIdentifierNamed(exprDotObj(callee), "graphql") &&
        nameIs(exprDotName(callee), "experimental");
    } else {
      isMarked = isIdentifierNamed(callee, "gql") || isIdentifierNamed(callee, "graphql");
    }
  } else if (pt === AN_CALL_EXPRESSION) {
    const callee = exprCallee(anId(parent));
    isMarked = callee >= 0 && isIdentifierNamed(callee, "graphql");
  }
  return isMarked || hasLanguageComment(e, parent, GRAPHQL_LANGUAGE, f);
}

/** Writes the template `e` as GraphQL, if that is what Prettier takes it for. Returns whether it has. */
function writeGraphqlTemplate(e: number, f: Formatter): boolean {
  if (f.options.embeddedLanguageFormatting !== EMBEDDED_AUTO || !isEmbedGraphql(e, f)) return false;
  return gqlWriteTemplate(new JsGqlTemplate(e, writeEmbeddedTemplateExpression), f);
}

// ───────────────────────────── Markdown ─────────────────────────────

/** Prettier's `isEmbedMarkdown`, and what `embed` asks of every template. `e`: a template. */
function isMarkdownCandidate(e: number, f: Formatter): boolean {
  if (f.options.embeddedLanguageFormatting !== EMBEDDED_AUTO || exprTemplateQuasiCount(e) !== 1) return false;
  const parent = exprAstParent(e);
  if (anTag(parent) !== AN_TAGGED_TEMPLATE_EXPRESSION) return false;
  const callee = callCallee(exprTaggedTemplateCall(anId(parent)));
  if (exprTag(callee) !== EXPR_IDENT) return false;
  const name = exprIdentName(callee);
  if (!nameIs(name, "md") && !nameIs(name, "markdown")) return false;
  return exprTemplateCooked(e, 0) >= 0;
}

function writeMarkdownEmbed(e: number, f: Formatter): boolean {
  if (!isMarkdownCandidate(e, f)) return false;
  exprTemplateRawSpan(e, 0);
  const SP$ = SP;
  const a = SP$.s0 | 0;
  const b = SP$.s1 | 0;
  if (trimJsWhitespaceStart(f.source, a, b) >= b) {
    f.token(T_EMPTY_TEMPLATE);
    return true;
  }
  return writeMarkdownTemplate(f, f.source, a, b, f.options);
}

// ───────────────────────────── has_embed_label ─────────────────────────────

/** oxc's `embed_hug`: for oxfmt a template with the tag of a language is laid out in a call or behind `=>` like one that is written as that language. */
function tagAloneDecidesWhatIsAroundATemplate(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** The template literal of `e` if it is one, with or without a tag: -1 otherwise. */
function quasiOf(e: number): number {
  if (exprTag(e) === EXPR_TAGGED_TEMPLATE) {
    const q = callTemplate(exprTaggedTemplateCall(e));
    return q >= 0 && exprTag(q) === EXPR_TEMPLATE ? q : -1;
  }
  return exprTag(e) === EXPR_TEMPLATE ? e : -1;
}

/**
 * Whether the document of `e` has the label `embed` for a template that is written as CSS, GraphQL or Markdown (`css::embed::has_embed_label`,
 * `graphql::embed::has_embed_label`, `markdown::embed::has_embed_label`): it is a template that is written as the language in it, with or
 * without a tag. (HTML: `html::in_js::label` is not ported.)
 */
export function hasEmbedLabelCssGraphqlMarkdown(e: number, f: Formatter): boolean {
  const quasi = quasiOf(e);
  if (quasi < 0) return false;
  if (f.options.embeddedLanguageFormatting !== EMBEDDED_AUTO) return false;
  // CSS
  if (isCssCandidate(quasi, f) && (tagAloneDecidesWhatIsAroundATemplate(f) || (!isBlankTemplate(quasi, f) && printEmbedCss(quasisOf(quasi, f), f.options, null, null)))) return true;
  // GraphQL
  if (isEmbedGraphql(quasi, f) && gqlHasEmbedLabel(new JsGqlTemplate(quasi, writeEmbeddedTemplateExpression), f, tagAloneDecidesWhatIsAroundATemplate(f))) return true;
  // Markdown: the tag `md` or `markdown`, with a tag (not for a template alone)
  if (exprTag(e) === EXPR_TAGGED_TEMPLATE && isMarkdownCandidate(quasi, f) && !isBlankTemplate(quasi, f)) return true;
  return false;
}

void callArgsLen;
void callArgsStart;
void typeSpan;
