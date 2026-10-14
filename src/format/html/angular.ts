// Port of vendor/bun/src/format/html/angular.rs: the expressions of Angular: Prettier's `language-html/embed/angular-*.js`, its parsers
// `__ng_*`, and what `language-js/print/angular.js` prints for the nodes that are no expressions of JavaScript.
//
// An expression is checked by a parser that accepts what Angular accepts, which makes TypeScript of it: `angular/parser.ts`. That is parsed and
// written by the formatter for JavaScript, which knows from `InHtml::root` that `a | b(c)` is a pipe.
import { ByteBuf } from "../../base/bytebuf.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  HTML_ROOT_NG_ACTION,
  HTML_ROOT_NG_BINDING,
  HTML_ROOT_NG_DIRECTIVE,
  HTML_ROOT_NG_INTERPOLATION,
  InHtml,
} from "../options.ts";
import { Formatter } from "../ir/formatter.ts";
import { token, twSingle } from "../ir/element.ts";
import {
  A_STRIDE,
  AF_NAME_E,
  AF_NAME_S,
  AF_NS_E,
  AF_NS_S,
  F_SPAN_E,
  F_SPAN_S,
  IS_INDENTATION_SENSITIVE,
  IS_WHITESPACE_SENSITIVE,
  has,
  nGet,
  nameEnd,
  nameStart,
  valEnd,
  valStart,
} from "./ast.ts";
import { eqLit } from "./data.ts";
import { Printer } from "./pstate.ts";
import { TK_SP } from "./printer.ts";
import { beginAttributeValue, beginExpand, endAttributeValue, endExpand } from "./embed.ts";
import { dedentString, htmlTrimPreserveIndentation, isAsciiWs, minIndentation, TRIM } from "./utilities.ts";
import { writeString } from "./writer.ts";
import {
  AngularRest,
  HUG_ALWAYS,
  HUG_BARE,
  HUG_EXPRESSION,
  hugOfOtherKinds,
  hugBegin,
  hugEnd,
  writeAngularExpressionCode,
} from "./js.ts";
import { AngularParser, ChainResult, NgExpression, commentStart } from "./angular/parser.ts";
import {
  PART_AS,
  PART_EXPRESSION,
  PART_KEY,
  PART_KEYED_EXPRESSION,
  PART_LET,
  Part,
  parseMicrosyntax,
} from "./angular/microsyntax.ts";

const TK_SEMI = token(";");
const TK_OPEN_PAREN = token("(");
const TK_CLOSE_PAREN = token(")");
const TK_EMPTY_PARENS = token("()");
const TK_AS = token(" as ");
const TK_COLON_SPACE = token(": ");
const TK_LET_ = token("let ");
const TK_EQ_ = token(" = ");
const TK_OPEN_INTERPOLATION = token("{{");
const TK_CLOSE_INTERPOLATION = token("}}");

/** The `//` comment at the end of an expression. */
class LineComment extends AngularRest {
  b: Uint8Array;
  /** From the `//`, without white space at the end. */
  s: number;
  e: number;
  /** How many line breaks are before it, of which the second ends an empty line. */
  linesBefore: number;

  /** `start`: where it starts in `code` (`b[cs, ce)`). */
  constructor(b: Uint8Array, cs: number, ce: number, start: number) {
    super();
    // `hasNewline(text, start, { backwards: true })`, `isPreviousLineEmpty(text, start)`
    let before = cs + start;
    let linesBefore = 0;
    while (linesBefore < 2) {
      let lineEnd = before;
      while (lineEnd > cs && ((b[lineEnd - 1] | 0) === 32 || (b[lineEnd - 1] | 0) === 9)) lineEnd = lineEnd - 1;
      if (lineEnd > cs && (b[lineEnd - 1] | 0) === 10) before = lineEnd - 1;
      else break;
      linesBefore = linesBefore + 1;
    }
    this.b = b;
    this.s = cs + start;
    this.e = trimJsWhitespaceEnd(b, cs + start, ce);
    this.linesBefore = linesBefore;
  }

  isPrettierIgnore(): boolean {
    const s = trimJsWhitespaceStart(this.b, this.s + 2, this.e);
    return eqLit(this.b, s, trimJsWhitespaceEnd(this.b, s, this.e), "prettier-ignore");
  }

  /** Prettier's `printTrailingComment`. */
  write(f: Formatter): void {
    f.startLineSuffix();
    if (this.linesBefore === 0) f.space();
    else if (this.linesBefore === 1) f.hardLineBreak();
    else f.emptyLine();
    writeString(f, this.b, this.s, this.e);
    f.endLineSuffix();
    f.expandParent();
  }
}

/** ` as ` and the key (`NGMicrosyntaxExpression` with an alias). */
class AliasRest extends AngularRest {
  alias: string;
  constructor(alias: string) {
    super();
    this.alias = alias;
  }
  write(f: Formatter): void {
    f.token(TK_AS);
    f.textStr(isPlainMicrosyntaxKey(this.alias) ? this.alias : JSON.stringify(this.alias));
  }
}

/** `/^[$_a-z][\w$]*(?:-[$_a-z][\w$])*$/i.test(name)` */
function isPlainMicrosyntaxKey(name: string): boolean {
  const isStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95;
  const isPart = (c: number): boolean => isStart(c) || (c >= 48 && c <= 57);
  if (name.length === 0 || !isStart(name.charCodeAt(0))) return false;
  let i = 1;
  while (i < name.length && isPart(name.charCodeAt(i))) i = i + 1;
  if ((name.length - i) % 3 !== 0) return false;
  while (i < name.length) {
    if (name.charCodeAt(i) !== 45 || !isStart(name.charCodeAt(i + 1)) || !isPart(name.charCodeAt(i + 2))) return false;
    i = i + 3;
  }
  return true;
}

/** `isNgForOf` */
function isNgForOf(part: Part, index: number): boolean {
  return index === 1 && part.kind === PART_KEYED_EXPRESSION && part.key === "of";
}

/** The `key.name` of a node in the body of an `NGMicrosyntax`. null: it has no `key`. */
function keyName(part: Part): string | null {
  if (part.kind === PART_KEY || part.kind === PART_EXPRESSION) return null;
  return part.key;
}

/** Whether there is nothing but what is white space to Angular in `b[s, e)`. */
function isBlankCode(b: Uint8Array, s: number, e: number): boolean {
  let i = s;
  while (i < e) {
    const c = b[i] | 0;
    if (c <= 32) i = i + 1;
    else if (c === 0xc2 && i + 1 < e && (b[i + 1] | 0) === 0xa0) i = i + 2;
    else return false;
  }
  return true;
}

/** `text.split(/\{\{(.+?)\}\}/s)`: ranges of `b[s, e)`: a text, and then, any number of times, what is between `{{` and `}}` and a text. */
function splitAtInterpolations(b: Uint8Array, s: number, e: number): number[] {
  const parts: number[] = [];
  let text = s;
  for (;;) {
    let start = -1;
    for (let i = text; i + 1 < e; i++) {
      if ((b[i] | 0) === 123 && (b[i + 1] | 0) === 123) {
        start = i;
        break;
      }
    }
    if (start < 0) break;
    let at = -1;
    for (let i = start + 3; i + 1 < e; i++) {
      if ((b[i] | 0) === 125 && (b[i + 1] | 0) === 125) {
        at = i;
        break;
      }
    }
    if (at < 0) break;
    parts.push(text, start, start + 2, at);
    text = at + 2;
  }
  parts.push(text, e);
  return parts;
}

/** The number of parts that `splitAtInterpolations` makes. */
function countParts(b: Uint8Array, s: number, e: number): number {
  const parts = splitAtInterpolations(b, s, e);
  // Pairs (text range, inner range) then the last text: 2 per interpolation + 1.
  return (parts.length - 2) / 2 + 1;
}

/** Writes what `write` writes the way `formatAttributeValue` returns it (`should` as in js.ts). */
function hugPrinterBegin(p: Printer, should: number): void {
  if (should === 0) beginExpand(p);
  else if (should === 1) p.w.startGroup();
}
function hugPrinterEnd(p: Printer, should: number): void {
  if (should === 0) endExpand(p, true);
  else if (should === 1) p.w.endGroup();
}

/** Writes `expression`, or `ignored` in its place, and what `rest` writes, the way `formatAttributeValue` returns it. */
function writeExpression(
  p: Printer,
  expression: NgExpression,
  ignored: Uint8Array | null,
  inHtml: InHtml,
  hug: number,
  rest: AngularRest | null,
): boolean {
  if (!expression.isPrinted) {
    return writeAngularExpressionCode(p, expression.code, expression.shown, ignored, inHtml, hug, rest);
  }
  // Nothing that `shouldHugJsExpression` hugs.
  const should = hugOfOtherKinds(hug);
  hugPrinterBegin(p, should);
  const start = p.w.beginForeign();
  const f = p.w.f;
  const text = ignored !== null ? ignored : expression.printed;
  writeString(f, text, 0, text.length);
  if (rest !== null) rest.write(f);
  p.w.endForeign(start);
  hugPrinterEnd(p, should);
  return true;
}

/** Writes an expression that is a part of what is written. */
function writePart(p: Printer, expression: NgExpression, inHtml: InHtml): boolean {
  return writeExpression(p, expression, null, inHtml, HUG_BARE, null);
}

/** `__ng_action`, `__ng_binding`, `__ng_interpolation` */
function writeChain(p: Printer, b: Uint8Array, s: number, e: number, inHtml: InHtml, hug: number): boolean {
  const isAction = inHtml.root === HTML_ROOT_NG_ACTION;
  const code = b.subarray(s, e);
  const cStart = commentStart(code, 0, code.length);
  const parser = new AngularParser(code, cStart < 0 ? code.length : cStart, isAction);
  const chain: ChainResult | null = parser.parseChain();
  if (chain === null) return false;
  const expressions = chain.expressions;
  const comment = cStart < 0 ? null : new LineComment(code, 0, code.length, cStart);
  // The comment is in the `NGEmptyExpression`, which does not print it.
  if (expressions.length === 0 && comment !== null) return false;
  let ignored: Uint8Array | null = null;
  if (comment !== null && comment.isPrettierIgnore()) ignored = code.subarray(chain.nodeStart, chain.nodeEnd);
  if (expressions.length === 1 && !isAction) {
    return writeExpression(p, expressions[0], ignored, inHtml, hug, comment);
  }
  // An `NGEmptyExpression` or an `NGChainedExpression`.
  const should = hugOfOtherKinds(hug);
  hugPrinterBegin(p, should);
  let isWritten = true;
  if (isAction) {
    if (ignored !== null) {
      const start = p.w.beginForeign();
      writeString(p.w.f, ignored, 0, ignored.length);
      p.w.endForeign(start);
    } else {
      p.w.startGroup();
      if (expressions.length === 0) p.w.token(TK_EMPTY_PARENS);
      for (let i = 0; i < expressions.length; i++) {
        const expression = expressions[i];
        if (i > 0) {
          p.w.token(TK_SEMI);
          p.w.line();
        }
        if (!expression.hasSideEffect) p.w.token(TK_OPEN_PAREN);
        isWritten = isWritten && writePart(p, expression, inHtml);
        if (!expression.hasSideEffect) p.w.token(TK_CLOSE_PAREN);
      }
      p.w.endGroup();
    }
    if (comment !== null) {
      const start = p.w.beginForeign();
      comment.write(p.w.f);
      p.w.endForeign(start);
    }
  }
  hugPrinterEnd(p, should);
  return isWritten;
}

/** An `NGMicrosyntaxKey`. */
function writeMicrosyntaxKey(p: Printer, name: string): void {
  p.w.flush();
  const out = p.w.beginBuilt();
  const at = out.len;
  out.appendAll(new TextEncoder().encode(isPlainMicrosyntaxKey(name) ? name : JSON.stringify(name)));
  p.w.endBuilt(at);
}

/** An `NGMicrosyntaxExpression`. */
function writeMicrosyntaxExpression(p: Printer, expression: NgExpression, alias: string | null, inHtml: InHtml): boolean {
  const isWritten = writePart(p, expression, inHtml);
  if (alias !== null) {
    p.w.token(TK_AS);
    writeMicrosyntaxKey(p, alias);
  }
  return isWritten;
}

/** `__ng_directive` */
function writeMicrosyntax(p: Printer, b: Uint8Array, s: number, e: number, inHtml: InHtml, hug: number): boolean {
  const code = b.subarray(s, e);
  const parser = new AngularParser(code, code.length, false);
  const body = parseMicrosyntax(parser);
  if (body === null) return false;
  if (body.length === 1 && body[0].kind === PART_EXPRESSION) {
    // To the formatter for JavaScript, the only expression of an `NGMicrosyntax` is what a binding is.
    const ih = inHtml.copy();
    ih.root = HTML_ROOT_NG_BINDING;
    const alias = body[0].alias;
    return writeExpression(p, body[0].expression as NgExpression, null, ih, hug, alias === null ? null : new AliasRest(alias));
  }
  // `isNgForOfTrack` reads the name of the key of the second node.
  if (body.length > 1 && keyName(body[1]) === null) {
    for (let i = 2; i < body.length; i++) {
      if (body[i].kind === PART_KEYED_EXPRESSION) return false;
    }
  }
  const should = hugOfOtherKinds(hug);
  hugPrinterBegin(p, should);
  let isWritten = true;
  const w = p.w;
  for (let index = 0; index < body.length; index++) {
    const part = body[index];
    if (isNgForOf(part, index)) w.token(TK_SP);
    else if (index > 0) {
      w.token(TK_SEMI);
      w.line();
    }
    switch (part.kind) {
      case PART_KEY:
        writeMicrosyntaxKey(p, part.key);
        break;
      case PART_EXPRESSION:
        isWritten = isWritten && writeMicrosyntaxExpression(p, part.expression as NgExpression, part.alias, inHtml);
        break;
      case PART_KEYED_EXPRESSION: {
        const key = part.key;
        const second = body.length > 1 ? keyName(body[1]) : null;
        const isSecondKey = (name: string): boolean => second === name;
        const shouldNotPrintColon =
          isNgForOf(part, index) ||
          (isSecondKey("of") && key === "track") ||
          (body[0].kind === PART_EXPRESSION &&
            (index === 1
              ? key === "then" || key === "else" || key === "as"
              : index === 2
                ? key === "track" || (key === "else" && body.length > 1 && body[1].kind === PART_KEYED_EXPRESSION && isSecondKey("then"))
                : false));
        writeMicrosyntaxKey(p, key);
        w.token(shouldNotPrintColon ? TK_SP : TK_COLON_SPACE);
        isWritten = isWritten && writeMicrosyntaxExpression(p, part.expression as NgExpression, part.alias, inHtml);
        break;
      }
      case PART_LET:
        w.token(TK_LET_);
        writeMicrosyntaxKey(p, part.key);
        if (part.value !== null) {
          w.token(TK_EQ_);
          writeMicrosyntaxKey(p, part.value);
        }
        break;
      case PART_AS:
        writeMicrosyntaxKey(p, part.key);
        w.token(TK_AS);
        writeMicrosyntaxKey(p, part.alias as string);
        break;
      default:
        break;
    }
  }
  hugPrinterEnd(p, should);
  return isWritten;
}

/** `formatAttributeValue(code, textToDoc, { parser: "__ng_.." })`. Returns whether it has been written. */
export function writeAngularExpression(p: Printer, b: Uint8Array, s: number, e: number, inHtml: InHtml, hug: number): boolean {
  if (inHtml.root === HTML_ROOT_NG_DIRECTIVE) return writeMicrosyntax(p, b, s, e, inHtml, hug);
  return writeChain(p, b, s, e, inHtml, hug);
}

/** `printAngularI18n` */
function printAngularI18n(p: Printer, element: number, b: Uint8Array, s: number, e: number): boolean {
  const t = p.t;
  const w = p.w;
  let hasAtAt = false;
  for (let i = s; i + 1 < e; i++) {
    if ((b[i] | 0) === 64 && (b[i + 1] | 0) === 64) {
      hasAtAt = true;
      break;
    }
  }
  beginExpand(p);
  // `getTextValueParts`
  const vs = trimJsWhitespaceStart(b, s, e);
  const ve = trimJsWhitespaceEnd(b, vs, e);
  const TRIM$ = TRIM;
  if (has(t, element, IS_WHITESPACE_SENSITIVE)) {
    // All that is between the parts of the `fill` is forced line breaks, so it is as good as an array.
    if (has(t, element, IS_INDENTATION_SENSITIVE)) {
      w.text(b, vs, ve);
      endExpand(p, !hasAtAt);
      return true;
    }
    htmlTrimPreserveIndentation(b, vs, ve);
    const ts = TRIM$.s0 | 0;
    const te = TRIM$.s1 | 0;
    const dedent = minIndentation(b, ts, te);
    let ls = ts;
    let index = 0;
    for (;;) {
      let le = ls;
      while (le < te && (b[le] | 0) !== 10) le = le + 1;
      if (index > 0) w.hardline();
      index = index + 1;
      w.text(b, le - ls > dedent ? ls + dedent : le, le);
      if (le >= te) break;
      ls = le + 1;
    }
    endExpand(p, !hasAtAt);
    return true;
  }
  w.startFill();
  w.startItem();
  let pos = vs;
  for (let index = 0; ; index++) {
    let we = pos;
    while (we < ve && !isAsciiWs(b[we] | 0)) we = we + 1;
    if (index > 0) {
      w.endItem();
      w.startItem();
      w.line();
      w.endItem();
      w.startItem();
    }
    w.text(b, pos, we);
    if (we >= ve) break;
    pos = we;
    while (pos < ve && isAsciiWs(b[pos] | 0)) pos = pos + 1;
  }
  w.endItem();
  w.endFill();
  endExpand(p, !hasAtAt);
  return true;
}

/** `printAngularInterpolation` */
function printAngularInterpolation(p: Printer, b: Uint8Array, s: number, e: number): boolean {
  const w = p.w;
  const inHtml = new InHtml();
  inHtml.root = HTML_ROOT_NG_INTERPOLATION;
  inHtml.isInAttribute = true;
  inHtml.isInInterpolation = true;
  const parts = splitAtInterpolations(b, s, e);
  // `parts`: for each interpolation: text start, `{{` start, inner start, inner end; then the last text start and the end.
  let n = 0;
  for (let i = 0; i + 3 < parts.length; i += 4) {
    const textS = parts[i];
    const open = parts[i + 1];
    const innerS = parts[i + 2];
    const innerE = parts[i + 3];
    w.text(b, textS, open);
    n = n + 1;
    // Two `line`s with an `NGEmptyExpression` between them, which is nothing. Where Prettier asks whether something fits, they are one blank.
    if (isBlankCode(b, innerS, innerE)) {
      w.startGroup();
      w.token(TK_OPEN_INTERPOLATION);
      w.startIf(false, 0);
      const start = w.beginForeign();
      w.f.textBytesWithWidth(BLANKS, 0, 2, twSingle(1));
      w.endForeign(start);
      w.endIf();
      w.softline();
      w.softline();
      w.token(TK_CLOSE_INTERPOLATION);
      w.endGroup();
      continue;
    }
    w.startAttempt();
    w.startGroup();
    w.token(TK_OPEN_INTERPOLATION);
    w.startIndent();
    w.line();
    const isWritten = writeAngularExpression(p, b, innerS, innerE, inHtml, HUG_ALWAYS);
    w.endIndent();
    w.line();
    w.token(TK_CLOSE_INTERPOLATION);
    w.endGroup();
    if (!w.endAttempt(isWritten)) {
      w.token(TK_OPEN_INTERPOLATION);
      w.text(b, innerS, innerE);
      w.token(TK_CLOSE_INTERPOLATION);
    }
  }
  w.text(b, parts[parts.length - 2], parts[parts.length - 1]);
  void n;
  return true;
}

const BLANKS = new Uint8Array([32, 32]);

/** The printers of `embed/angular-attributes.js`. `v`: without the entities for quotes. Returns whether the attribute has been written. */
export function embedAngularAttribute(
  p: Printer,
  element: number,
  a: number,
  raw: Uint8Array,
  rawS: number,
  rawE: number,
  vb: Uint8Array,
  vs: number,
  ve: number,
): boolean {
  const t = p.t;
  const ab = a * A_STRIDE;
  // `attr.full_name()`
  const name = new ByteBuf(32);
  const ns = t.a[ab + AF_NS_S] | 0;
  const ne = t.a[ab + AF_NS_E] | 0;
  if (ne > ns) {
    name.append(t.pool.data, ns, ne);
    name.push(58);
  }
  name.append(t.pool.data, t.a[ab + AF_NAME_S] | 0, t.a[ab + AF_NAME_E] | 0);
  const fn = name.data;
  const fl = name.len;
  const starts = (lit: string): boolean => fl >= lit.length && eqLit(fn, 0, lit.length, lit);
  const first = fl > 0 ? fn[0] | 0 : 0;
  const last = fl > 0 ? fn[fl - 1] | 0 : 0;
  let root = -1;
  if ((first === 40 && last === 41) || starts("on-")) {
    root = HTML_ROOT_NG_ACTION;
  } else if (
    (first === 91 && last === 93) ||
    starts("bind-") ||
    starts("bindon-") ||
    eqLit(fn, 0, fl, "ng-if") ||
    eqLit(fn, 0, fl, "ng-show") ||
    eqLit(fn, 0, fl, "ng-hide") ||
    eqLit(fn, 0, fl, "ng-class") ||
    eqLit(fn, 0, fl, "ng-style")
  ) {
    root = HTML_ROOT_NG_BINDING;
  } else if (first === 42) {
    root = HTML_ROOT_NG_DIRECTIVE;
  }
  if (root >= 0) {
    const inHtml = new InHtml();
    inHtml.root = root;
    inHtml.isInAttribute = true;
    beginAttributeValue(p);
    return endAttributeValue(p, a, writeAngularExpression(p, vb, vs, ve, inHtml, HUG_EXPRESSION));
  }
  // `/^i18n(?:-.+)?$/`
  if (starts("i18n") && (fl === 4 || (fl > 5 && (fn[4] | 0) === 45))) {
    beginAttributeValue(p);
    return endAttributeValue(p, a, printAngularI18n(p, element, vb, vs, ve));
  }
  if (countParts(raw, rawS, rawE) > 1) {
    beginAttributeValue(p);
    return endAttributeValue(p, a, printAngularInterpolation(p, vb, vs, ve));
  }
  return false;
}

/** `printAngularControlFlowBlockParameters` */
export function embedAngularControlFlowBlockParameters(p: Printer, block: number, parameters: number): boolean {
  const t = p.t;
  const b = t.pool.data;
  const ns = nameStart(t, block);
  const ne = nameEnd(t, block);
  if (!(eqLit(b, ns, ne, "if") || eqLit(b, ns, ne, "else if") || eqLit(b, ns, ne, "for") || eqLit(b, ns, ne, "switch") || eqLit(b, ns, ne, "case"))) {
    return false;
  }
  const text = p.o.originalText;
  const cs = nGet(t, parameters, F_SPAN_S);
  const ce = nGet(t, parameters, F_SPAN_E);
  if (trimJsWhitespaceStart(text, cs, ce) >= ce) return false;
  const inHtml = new InHtml();
  inHtml.root = HTML_ROOT_NG_DIRECTIVE;
  p.w.startAttempt();
  const isWritten = writeAngularExpression(p, text, cs, ce, inHtml, HUG_EXPRESSION);
  return p.w.endAttempt(isWritten);
}

export function embedAngularLetDeclarationInitializer(p: Printer, id: number): boolean {
  const t = p.t;
  const inHtml = new InHtml();
  inHtml.root = HTML_ROOT_NG_BINDING;
  p.w.startAttempt();
  const vs = valStart(t, id);
  const ve = valEnd(t, id);
  const isWritten = writeAngularExpression(p, t.pool.data, vs, ve, inHtml, HUG_ALWAYS);
  return p.w.endAttempt(isWritten);
}

void hugBegin;
void hugEnd;
void dedentString;
void F_SPAN_E;
void TK_OPEN_PAREN;
