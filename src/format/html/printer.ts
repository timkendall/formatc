// Port of vendor/bun/src/format/html/printer.rs: Prettier's `language-html/printer-html.js` and `print/*.js`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { jsWhitespaceLen, startsWithWhiteSpace, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import { ATTRIBUTE_POSITION_MULTILINE, EMBEDDED_AUTO } from "../options.ts";
import { token } from "../ir/element.ts";
import {
  A_STRIDE,
  AF_EXPLICIT_NS,
  AF_HAS_VAL,
  AF_NAME_E,
  AF_NAME_S,
  AF_NS_E,
  AF_NS_S,
  AF_SPAN_E,
  AF_SPAN_S,
  AF_VAL_E,
  AF_VAL_S,
  F_ATTR_E,
  F_ATTR_S,
  F_END_S,
  F_SPAN_E,
  F_SPAN_S,
  F_TC_E,
  F_TC_S,
  HAS_DANGLING_SPACES,
  HAS_END_SPAN,
  HAS_LEADING_SPACES,
  HAS_TRAILING_SPACES,
  HTree,
  IS_DANGLING_SPACE_SENSITIVE,
  IS_INDENTATION_SENSITIVE,
  IS_LEADING_SPACE_SENSITIVE,
  IS_SELF_CLOSING,
  IS_TRAILING_SPACE_SENSITIVE,
  IS_WHITESPACE_SENSITIVE,
  K_ANGULAR_CONTROL_FLOW_BLOCK,
  K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETER,
  K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETERS,
  K_ANGULAR_ICU_CASE,
  K_ANGULAR_ICU_EXPRESSION,
  K_ANGULAR_LET_DECLARATION,
  K_CDATA,
  K_COMMENT,
  K_DOC_TYPE,
  K_ELEMENT,
  K_FRONT_MATTER,
  K_IE_CONDITIONAL_COMMENT,
  K_IE_CONDITIONAL_END_COMMENT,
  K_IE_CONDITIONAL_START_COMMENT,
  K_INTERPOLATION,
  K_ROOT,
  K_TEXT,
  P_VUE,
  PRESERVES_CONTENT,
  TC_STRIDE,
  TCF_SINGLE,
  TCF_SPAN_E,
  TCF_SPAN_S,
  TCF_VAL_E,
  TCF_VAL_S,
  firstChild,
  flagsOf,
  has,
  hasChildren,
  kindOf,
  lastChild,
  nGet,
  nameEnd,
  nameStart,
  nextOf,
  nodeIsFullName,
  parentOf,
  prevOf,
  valEnd,
  valStart,
  nsEnd,
  nsStart,
  attrIsFullName,
  HAS_EXPLICIT_NAMESPACE,
  HAS_END_SPAN as HAS_END,
} from "./ast.ts";
import { eqLit } from "./data.ts";
import { HOptions } from "./hoptions.ts";
import { Printer, TG_IN_START_TAG, TG_NODE, cursorMarksBegin, cursorMarksEnd } from "./pstate.ts";
import {
  closingTag,
  closingTagEnd,
  closingTagSuffix,
  lenOfClosingTagEndMarker,
  lenOfOpeningTagStartMarker,
  needsToBorrowLastChildClosingTagEndMarker,
  needsToBorrowNextOpeningTagStartMarker,
  needsToBorrowParentClosingTagStartMarker,
  needsToBorrowParentOpeningTagEndMarker,
  needsToBorrowPrevClosingTagEndMarker,
  nodeContent,
  NODE_CONTENT,
  openingTagEnd,
  openingTagPrefix,
  openingTagStart,
  isWrittenToItsEnd,
} from "./tag.ts";
import {
  UQ,
  forceBreakChildren,
  forceBreakContent,
  forceNextEmptyLine,
  hasPrettierIgnore,
  htmlTrimPreserveIndentation,
  isAsciiWs,
  isPreLike,
  isScriptLikeTag,
  isTextLike,
  isVueCustomBlock,
  isVueSfcBlock,
  minIndentation,
  preferHardlineAsLeadingSpaces,
  shouldUnquoteAttributeValue,
  trimAsciiEnd,
  TRIM,
  unescapeQuoteEntities,
} from "./utilities.ts";
import { embed, embedAttribute } from "./embed.ts";
import {
  printAngularControlFlowBlock,
  printAngularControlFlowBlockParameters,
  printAngularIcuCase,
  printAngularIcuExpression,
  printAngularLetDeclaration,
} from "./angular_print.ts";
import { BL_NOTHING, BL_LINE, BL_SOFTLINE, BL_HARDLINE } from "./printer.consts.ts";

export const TK_EQ: number = token("=");
export const TK_DQ: number = token('"');
export const TK_SQ: number = token("'");
export const TK_LINE_COMMENT: number = token("//");
export const TK_OPEN_BLOCK_COMMENT: number = token("/*");
export const TK_CLOSE_BLOCK_COMMENT: number = token("*/");
export const TK_HTML: number = token("html");
export const TK_SP: number = token(" ");


export function formatsEmbedded(p: Printer): boolean {
  return p.o.format.embeddedLanguageFormatting === EMBEDDED_AUTO;
}

// ───────────────────────────── text made by tag.ts ─────────────────────────────

export function builtOpeningTagStart(p: Printer, id: number): void {
  const out = p.w.beginBuilt();
  const at = out.len;
  openingTagStart(p.t, p.o, id, out);
  p.w.endBuilt(at);
}
export function builtOpeningTagPrefix(p: Printer, id: number): void {
  const out = p.w.beginBuilt();
  const at = out.len;
  openingTagPrefix(p.t, p.o, id, out);
  p.w.endBuilt(at);
}
export function builtOpeningTagEnd(p: Printer, id: number): void {
  const out = p.w.beginBuilt();
  const at = out.len;
  openingTagEnd(p.t, p.o, id, out);
  p.w.endBuilt(at);
}
export function builtClosingTag(p: Printer, id: number): void {
  const out = p.w.beginBuilt();
  const at = out.len;
  closingTag(p.t, p.o, id, out);
  p.w.endBuilt(at);
}
export function builtClosingTagEnd(p: Printer, id: number): void {
  const out = p.w.beginBuilt();
  const at = out.len;
  closingTagEnd(p.t, p.o, id, out);
  p.w.endBuilt(at);
}
export function builtClosingTagSuffix(p: Printer, id: number): void {
  const out = p.w.beginBuilt();
  const at = out.len;
  closingTagSuffix(p.t, p.o, id, out);
  p.w.endBuilt(at);
}

/** `ends_with_line_break`: `stripTrailingHardline` is not called for the document. */
export function printRoot(p: Printer, endsWithLineBreak: boolean): void {
  const root = p.t.root;
  p.w.startGroup();
  printChildren(p, root);
  p.w.endGroup();
  if (endsWithLineBreak) p.w.hardline();
}

/** What Prettier's `mainPrint` comes to: what `embed` has made of the node, or else what `genericPrint` makes. */
export function printNode(p: Printer, id: number): void {
  const after = cursorMarksBegin(p, TG_NODE, id, 0);
  printNodeWithoutMarks(p, id);
  cursorMarksEnd(p, after);
}

function printNodeWithoutMarks(p: Printer, id: number): void {
  if (!p.stack.enter()) {
    p.isNestedTooDeeply = true;
    return;
  }
  if (!(formatsEmbedded(p) && embed(p, id))) genericPrint(p, id);
  p.stack.leave();
}

function genericPrint(p: Printer, id: number): void {
  const t = p.t;
  const w = p.w;
  const o = p.o;
  const b = t.pool.data;
  switch (kindOf(t, id)) {
    case K_ROOT:
      printRoot(p, true);
      break;
    case K_FRONT_MATTER:
      w.text(o.originalText, nGet(t, id, F_SPAN_S), nGet(t, id, F_SPAN_E));
      break;
    case K_ELEMENT:
    case K_IE_CONDITIONAL_COMMENT:
      printElement(p, id);
      break;
    case K_ANGULAR_CONTROL_FLOW_BLOCK:
      printAngularControlFlowBlock(p, id);
      break;
    case K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETERS:
      printAngularControlFlowBlockParameters(p, id);
      break;
    case K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETER: {
      const s = trimAsciiStartOf(b, valStart(t, id), valEnd(t, id));
      w.text(b, s, trimAsciiEnd(b, s, valEnd(t, id)));
      break;
    }
    case K_ANGULAR_LET_DECLARATION:
      printAngularLetDeclaration(p, id);
      break;
    case K_ANGULAR_ICU_EXPRESSION:
      printAngularIcuExpression(p, id);
      break;
    case K_ANGULAR_ICU_CASE:
      printAngularIcuCase(p, id);
      break;
    case K_IE_CONDITIONAL_START_COMMENT:
    case K_IE_CONDITIONAL_END_COMMENT:
      builtOpeningTagStart(p, id);
      builtClosingTagEnd(p, id);
      break;
    case K_INTERPOLATION: {
      builtOpeningTagStart(p, id);
      p.ancestors = p.ancestors + 1;
      for (let c = firstChild(t, id); c >= 0; c = nextOf(t, c)) printNode(p, c);
      p.ancestors = p.ancestors - 1;
      builtClosingTagEnd(p, id);
      break;
    }
    case K_TEXT:
      printText(p, id);
      break;
    case K_DOC_TYPE: {
      w.startGroup();
      builtOpeningTagStart(p, id);
      w.token(TK_SP);
      // `.replace(/^html\b/i, "html").replaceAll(/\s+/g, " ")`
      let vs = valStart(t, id);
      const ve = valEnd(t, id);
      if (ve - vs >= 4 && lowerEq4(b, vs, "html") && !(ve - vs > 4 && isRegexpWordByte(b[vs + 4] | 0))) {
        w.token(TK_HTML);
        vs = vs + 4;
      }
      while (vs < ve) {
        let len = 0;
        while (vs + len < ve && !startsWithWhiteSpace(b, vs + len, ve)) len = len + 1;
        w.text(b, vs, vs + len);
        const rest = trimJsWhitespaceStart(b, vs + len, ve);
        if (rest > vs + len) w.token(TK_SP);
        vs = rest;
      }
      w.endGroup();
      builtClosingTagEnd(p, id);
      break;
    }
    case K_COMMENT:
      builtOpeningTagPrefix(p, id);
      w.text(o.originalText, nGet(t, id, F_SPAN_S), nGet(t, id, F_SPAN_E));
      builtClosingTagSuffix(p, id);
      break;
    case K_CDATA:
      // It has become a text.
      break;
    default:
      break;
  }
}

function trimAsciiStartOf(b: Uint8Array, s: number, e: number): number {
  let i = s;
  while (i < e && isAsciiWs(b[i] | 0)) i = i + 1;
  return i;
}

function lowerEq4(b: Uint8Array, s: number, lit: string): boolean {
  for (let i = 0; i < 4; i++) {
    let c = b[s + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== lit.charCodeAt(i)) return false;
  }
  return true;
}

function isRegexpWordByte(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function printText(p: Printer, id: number): void {
  const t = p.t;
  const w = p.w;
  const b = t.pool.data;
  const vs = valStart(t, id);
  const ve = valEnd(t, id);
  const parent = parentOf(t, id);
  if (parent < 0) return;
  if (kindOf(t, parent) === K_INTERPOLATION) {
    // The line break at the end is not a literal one: `/\n[^\S\n]*$/`
    const textLen = trimJsWhitespaceEnd(b, vs, ve);
    let at = -1;
    for (let i = ve - 1; i >= textLen; i--) {
      if ((b[i] | 0) === 10) {
        at = i;
        break;
      }
    }
    if (at >= 0) {
      w.text(b, vs, at);
      w.hardline();
    } else {
      w.text(b, vs, ve);
    }
    return;
  }
  const TRIM$ = TRIM;
  if (has(t, parent, IS_WHITESPACE_SENSITIVE)) {
    // All that is between the parts of the `fill` is forced line breaks, so it is as good as an array.
    builtOpeningTagPrefix(p, id);
    if (has(t, parent, IS_INDENTATION_SENSITIVE)) {
      w.text(b, vs, ve);
    } else {
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
    }
    builtClosingTagSuffix(p, id);
    return;
  }
  // The first and the last part of the `fill` have what is borrowed. One part is no `fill`: `cleanDoc` makes it so in a template of
  // JavaScript, where the part can be more than a string.
  const isFill = hasTwoWords(b, vs, ve);
  if (isFill) {
    w.startFill();
    w.startItem();
  }
  builtOpeningTagPrefix(p, id);
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
  builtClosingTagSuffix(p, id);
  if (isFill) {
    w.endItem();
    w.endFill();
  }
}

/** `html_split(value).nth(1).is_some()` */
function hasTwoWords(b: Uint8Array, s: number, e: number): boolean {
  let we = s;
  while (we < e && !isAsciiWs(b[we] | 0)) we = we + 1;
  return we < e;
}

// ───────────────────────────── `print/children.js` ─────────────────────────────

/** `getEndLocation` */
function endLocation(t: HTree, id0: number): number {
  let id = id0;
  let end = nGet(t, id, F_SPAN_E);
  // An element can be unclosed.
  while (kindOf(t, id) === K_ELEMENT && !has(t, id, HAS_END_SPAN)) {
    const last = lastChild(t, id);
    if (last < 0) break;
    id = last;
    end = Math.max(end, nGet(t, id, F_SPAN_E));
  }
  return end;
}

function printChild(p: Printer, child: number): void {
  const t = p.t;
  const o = p.o;
  if (!hasPrettierIgnore(t, child)) {
    printNode(p, child);
    return;
  }
  let start = nGet(t, child, F_SPAN_S);
  const prev = prevOf(t, child);
  if (prev >= 0 && needsToBorrowNextOpeningTagStartMarker(t, prev)) start = start + lenOfOpeningTagStartMarker(t, o, child);
  let end = endLocation(t, child);
  const next = nextOf(t, child);
  if (next >= 0 && needsToBorrowPrevClosingTagEndMarker(t, next)) {
    end = Math.max(0, end - lenOfClosingTagEndMarker(t, o, child));
  }
  builtOpeningTagPrefix(p, child);
  const text = o.originalText;
  if (start <= end && end <= text.length) p.w.text(text, start, trimAsciiEnd(text, start, end));
  builtClosingTagSuffix(p, child);
}

function betweenLine(p: Printer, prev: number, next: number): number {
  const t = p.t;
  const o = p.o;
  if (isTextLike(t, prev) && isTextLike(t, next)) {
    if (has(t, prev, IS_TRAILING_SPACE_SENSITIVE)) {
      if (!has(t, prev, HAS_TRAILING_SPACES)) return BL_NOTHING;
      return preferHardlineAsLeadingSpaces(t, next, o) ? BL_HARDLINE : BL_LINE;
    }
    return preferHardlineAsLeadingSpaces(t, next, o) ? BL_HARDLINE : BL_SOFTLINE;
  }
  if (
    (needsToBorrowNextOpeningTagStartMarker(t, prev) &&
      (hasPrettierIgnore(t, next) ||
        hasChildren(t, next) ||
        has(t, next, IS_SELF_CLOSING) ||
        (kindOf(t, next) === K_ELEMENT && nGet(t, next, F_ATTR_S) < nGet(t, next, F_ATTR_E)))) ||
    (kindOf(t, prev) === K_ELEMENT && has(t, prev, IS_SELF_CLOSING) && needsToBorrowPrevClosingTagEndMarker(t, next))
  ) {
    return BL_NOTHING;
  }
  if (kindOf(t, next) === K_COMMENT && has(t, next, IS_LEADING_SPACE_SENSITIVE) && !has(t, next, HAS_LEADING_SPACES)) {
    return BL_SOFTLINE;
  }
  if (!has(t, next, IS_LEADING_SPACE_SENSITIVE) || preferHardlineAsLeadingSpaces(t, next, o)) return BL_HARDLINE;
  if (needsToBorrowPrevClosingTagEndMarker(t, next)) {
    const lastOfPrev = lastChild(t, prev);
    if (lastOfPrev >= 0 && needsToBorrowParentClosingTagStartMarker(t, lastOfPrev)) {
      const lastOfLast = lastChild(t, lastOfPrev);
      if (lastOfLast >= 0 && needsToBorrowParentClosingTagStartMarker(t, lastOfLast)) return BL_HARDLINE;
    }
  }
  return has(t, next, HAS_LEADING_SPACES) ? BL_LINE : BL_SOFTLINE;
}

function writeBetweenLine(p: Printer, line: number): void {
  if (line === BL_LINE) p.w.line();
  else if (line === BL_SOFTLINE) p.w.softline();
  else if (line === BL_HARDLINE) p.w.hardline();
}

export function withAncestorBegin(p: Printer): void {
  p.ancestors = p.ancestors + 1;
}
export function withAncestorEnd(p: Printer): void {
  p.ancestors = p.ancestors - 1;
}

export function printChildren(p: Printer, parent: number): void {
  p.ancestors = p.ancestors + 1;
  printChildrenOf(p, parent);
  p.ancestors = p.ancestors - 1;
}

function printChildrenOf(p: Printer, parent: number): void {
  const t = p.t;
  const o = p.o;
  const w = p.w;
  if (forceBreakChildren(t, parent)) {
    w.breakParent();
    for (let child = firstChild(t, parent); child >= 0; child = nextOf(t, child)) {
      const prev = prevOf(t, child);
      if (prev >= 0) {
        const line = betweenLine(p, prev, child);
        writeBetweenLine(p, line);
        if (line !== BL_NOTHING && forceNextEmptyLine(t, prev, o)) w.hardline();
      }
      printChild(p, child);
    }
    return;
  }
  // What is between a child and the one before it, if the one before it has asked (-1: nothing known).
  let knownLine = -1;
  // The id of the group of the child before, if this one asks about it (0: none).
  let prevGroupId = 0;
  for (let child = firstChild(t, parent); child >= 0; child = nextOf(t, child)) {
    const prev = prevOf(t, child);
    let prevLine = knownLine;
    knownLine = -1;
    if (isTextLike(t, child)) {
      if (prev >= 0 && isTextLike(t, prev)) {
        const line = betweenLine(p, prev, child);
        if (line !== BL_NOTHING) {
          if (forceNextEmptyLine(t, prev, o)) {
            w.hardline();
            w.hardline();
          } else {
            writeBetweenLine(p, line);
          }
        }
      }
      printChild(p, child);
      continue;
    }
    const next = nextOf(t, child);
    if (prev >= 0) {
      if (prevLine < 0) prevLine = betweenLine(p, prev, child);
    } else {
      prevLine = BL_NOTHING;
    }
    const nextLine = next >= 0 ? betweenLine(p, child, next) : BL_NOTHING;
    knownLine = nextLine;

    // What comes before the groups, and what is at the start of the outer one: -1 none, 1 the line, 0 a softline if the other group is broken.
    let leadingLine = -1;
    if (prev >= 0 && prevLine !== BL_NOTHING) {
      if (forceNextEmptyLine(t, prev, o)) {
        w.hardline();
        w.hardline();
      } else if (prevLine === BL_HARDLINE) {
        w.hardline();
      } else {
        leadingLine = isTextLike(t, prev) ? 1 : 0;
      }
    }
    w.startGroup();
    if (leadingLine === 1) {
      writeBetweenLine(p, prevLine);
    } else if (leadingLine === 0) {
      w.startIf(false, prevGroupId);
      w.softline();
      w.endIf();
    }
    const forcesNextEmptyLine = nextLine !== BL_NOTHING && forceNextEmptyLine(t, child, o);
    const isTrailingLine = nextLine !== BL_NOTHING && !forcesNextEmptyLine && nextLine !== BL_HARDLINE;
    // Only an element behind it asks whether the group is broken.
    prevGroupId = next >= 0 && isTrailingLine && !isTextLike(t, next) ? w.newGroupId() : 0;
    w.startGroupWith(false, prevGroupId);
    printChild(p, child);
    if (isTrailingLine) writeBetweenLine(p, nextLine);
    w.endGroup();
    w.endGroup();
    if (next >= 0 && isTextLike(t, next)) {
      if (forcesNextEmptyLine) {
        w.hardline();
        w.hardline();
      } else if (nextLine === BL_HARDLINE) {
        w.hardline();
      }
    }
  }
}

// ───────────────────────────── `print/element.js` ─────────────────────────────

function printElement(p: Printer, id: number): void {
  const t = p.t;
  const o = p.o;
  const w = p.w;
  const NODE_CONTENT$ = NODE_CONTENT;
  if (has(t, id, PRESERVES_CONTENT)) {
    builtOpeningTagPrefix(p, id);
    w.startGroup();
    printOpeningTag(p, id);
    w.endGroup();
    nodeContent(t, o, id);
    w.text(o.originalText, NODE_CONTENT$.s0 | 0, NODE_CONTENT$.s1 | 0);
    if (!isWrittenToItsEnd(t, id)) builtClosingTag(p, id);
    builtClosingTagSuffix(p, id);
    return;
  }
  const first = firstChild(t, id);
  const last = lastChild(t, id);
  if (first < 0 || last < 0) {
    w.startGroup();
    w.startGroup();
    printOpeningTag(p, id);
    w.endGroup();
    if (has(t, id, HAS_DANGLING_SPACES) && has(t, id, IS_DANGLING_SPACE_SENSITIVE)) w.line();
    builtClosingTag(p, id);
    w.endGroup();
    return;
  }
  const hasSensitiveLeadingSpaces = has(t, first, HAS_LEADING_SPACES | IS_LEADING_SPACE_SENSITIVE);
  const hasSensitiveTrailingSpaces = has(t, last, HAS_TRAILING_SPACES | IS_TRAILING_SPACE_SENSITIVE);
  const firstKind = kindOf(t, first);
  const shouldHugContent =
    first === last &&
    (firstKind === K_INTERPOLATION || firstKind === K_ANGULAR_ICU_EXPRESSION) &&
    has(t, first, IS_LEADING_SPACE_SENSITIVE) &&
    !has(t, first, HAS_LEADING_SPACES) &&
    has(t, last, IS_TRAILING_SPACE_SENSITIVE) &&
    !has(t, last, HAS_TRAILING_SPACES);
  const attrGroupId = shouldHugContent ? w.newGroupId() : 0;
  // `isSensitiveText(kind)`: `kind === Text && node.has(IS_WHITESPACE_SENSITIVE | IS_INDENTATION_SENSITIVE)`: both flags.
  const nodeHasBoth = has(t, id, IS_WHITESPACE_SENSITIVE | IS_INDENTATION_SENSITIVE);

  w.startGroup();
  w.startGroupWith(false, attrGroupId);
  printOpeningTag(p, id);
  w.endGroup();
  if (forceBreakContent(t, id, o)) w.breakParent();

  // `printChildrenDoc`
  const isIndented =
    attrGroupId === 0 &&
    !(
      (isScriptLikeTag(t, id, o) || isVueCustomBlock(t, id, o)) &&
      parentOf(t, id) >= 0 &&
      kindOf(t, parentOf(t, id)) === K_ROOT &&
      o.parser === P_VUE &&
      !o.format.vueIndentScriptAndStyle
    );
  let outerIndentLevel = -2;
  if (attrGroupId !== 0) outerIndentLevel = w.startIndentIfBreak(attrGroupId);
  if (isIndented) w.startIndent();
  // `printLineBeforeChildren`
  if (attrGroupId !== 0) {
    w.softlineIfBreak(attrGroupId);
  } else if (hasSensitiveLeadingSpaces) {
    w.line();
  } else if (firstKind === K_TEXT && nodeHasBoth) {
    w.softlineDedentedToRoot();
  } else {
    w.softline();
  }
  printChildren(p, id);
  if (attrGroupId !== 0 && outerIndentLevel !== -2) w.endIndentIfBreak(attrGroupId, outerIndentLevel);
  if (isIndented) w.endIndent();

  // `printLineAfterChildren`
  let needsToBorrow: boolean;
  const nextSibling = nextOf(t, id);
  const parent = parentOf(t, id);
  if (nextSibling >= 0) needsToBorrow = needsToBorrowPrevClosingTagEndMarker(t, nextSibling);
  else if (parent >= 0) needsToBorrow = needsToBorrowLastChildClosingTagEndMarker(t, parent);
  else needsToBorrow = false;
  const lastKind = kindOf(t, last);
  if (needsToBorrow) {
    if (hasSensitiveTrailingSpaces) w.token(TK_SP);
  } else if (isPreLike(t, id) && needsToBorrowParentClosingTagStartMarker(t, last)) {
    // (nothing)
  } else if (attrGroupId !== 0) {
    w.softlineIfBreak(attrGroupId);
  } else if (hasSensitiveTrailingSpaces) {
    w.line();
  } else if ((lastKind === K_COMMENT || (lastKind === K_TEXT && nodeHasBoth)) && endsWithIndentationOfElement(p, last)) {
    // (nothing)
  } else {
    w.softline();
  }
  builtClosingTag(p, id);
  w.endGroup();
}

/** `\n[\t ]{n}$`, where `n` is the indentation of the element. */
function endsWithIndentationOfElement(p: Printer, last: number): boolean {
  const t = p.t;
  const b = t.pool.data;
  const width = p.o.format.indentWidth * Math.max(0, p.ancestors - 1);
  const vs = valStart(t, last);
  const ve = valEnd(t, last);
  const len = ve - vs;
  if (len <= width) return false;
  for (let i = ve - width; i < ve; i++) {
    const c = b[i] | 0;
    if (c !== 9 && c !== 32) return false;
  }
  return (b[ve - width - 1] | 0) === 10;
}

// ───────────────────────────── `print/tag.js` ─────────────────────────────

export function printOpeningTag(p: Printer, id: number): void {
  builtOpeningTagStart(p, id);
  printAttributes(p, id);
  if (!has(p.t, id, IS_SELF_CLOSING)) builtOpeningTagEnd(p, id);
}

/** `getPrettierIgnoreAttributeCommentData`: 0 none, 1 all, 2 named (the names are in `ignoredNames`: pairs of ranges of the pool). */
function ignoredFromComment(t: HTree, comment: number, ignoredNames: I32Vec): number {
  const b = t.pool.data;
  const s = trimJsWhitespaceStart(b, valStart(t, comment), valEnd(t, comment));
  const e = trimJsWhitespaceEnd(b, s, valEnd(t, comment));
  const lit = "prettier-ignore-attribute";
  if (e - s < lit.length || !eqLit(b, s, s + lit.length, lit)) return 0;
  const rest = s + lit.length;
  if (rest === e) return 1;
  if (!startsWithWhiteSpace(b, rest, e)) return 0;
  ignoredNames.reset();
  let at = trimJsWhitespaceStart(b, rest, e);
  while (at < e) {
    let len = 0;
    while (at + len < e && !startsWithWhiteSpace(b, at + len, e)) len = len + 1;
    ignoredNames.push(at);
    ignoredNames.push(at + len);
    at = trimJsWhitespaceStart(b, at + len, e);
  }
  return 2;
}

function ignoredHas(t: HTree, mode: number, a: number, ignoredNames: I32Vec): boolean {
  if (mode === 0) return false;
  if (mode === 1) return true;
  const b = t.pool.data;
  const ab = a * A_STRIDE;
  const explicit = (t.a[ab + AF_EXPLICIT_NS] | 0) !== 0 && (t.a[ab + AF_NS_E] | 0) > (t.a[ab + AF_NS_S] | 0);
  const ns = t.a[ab + AF_NS_S] | 0;
  const ne = t.a[ab + AF_NS_E] | 0;
  const ms = t.a[ab + AF_NAME_S] | 0;
  const me = t.a[ab + AF_NAME_E] | 0;
  const rawLen = (explicit ? ne - ns + 1 : 0) + (me - ms);
  for (let i = 0; i + 1 < ignoredNames.len; i += 2) {
    const s = ignoredNames.data[i] | 0;
    const e = ignoredNames.data[i + 1] | 0;
    if (e - s !== rawLen) continue;
    let same = true;
    let k = 0;
    if (explicit) {
      for (let j = ns; j < ne; j++) {
        if ((b[s + k] | 0) !== (b[j] | 0)) same = false;
        k = k + 1;
      }
      if ((b[s + k] | 0) !== 58) same = false;
      k = k + 1;
    }
    for (let j = ms; j < me; j++) {
      if ((b[s + k] | 0) !== (b[j] | 0)) same = false;
      k = k + 1;
    }
    if (same) return true;
  }
  return false;
}

function printAttributes(p: Printer, id: number): void {
  const t = p.t;
  const o = p.o;
  const w = p.w;
  const isSelfClosing = has(t, id, IS_SELF_CLOSING);
  const attrStart = nGet(t, id, F_ATTR_S);
  const attrEnd = nGet(t, id, F_ATTR_E);
  const cStart = nGet(t, id, F_TC_S);
  const cEnd = nGet(t, id, F_TC_E);
  if (attrStart >= attrEnd && cStart >= cEnd) {
    if (isSelfClosing) w.token(TK_SP);
    return;
  }
  let ignored = 0;
  const ignoredNames = new I32Vec(2);
  const prev = prevOf(t, id);
  if (prev >= 0 && kindOf(t, prev) === K_COMMENT) ignored = ignoredFromComment(t, prev, ignoredNames);
  const attrCount = attrEnd - attrStart;
  const forceNotToBreakAttrContent =
    kindOf(t, id) === K_ELEMENT &&
    nodeIsFullName(t, id, "script") &&
    attrCount === 1 &&
    attrIsFullName(t, attrStart, "src") &&
    !hasChildren(t, id) &&
    cStart >= cEnd;
  let shouldForceBreak = false;
  for (let c = cStart; c < cEnd; c++) {
    if ((t.c[c * TC_STRIDE + TCF_SINGLE] | 0) !== 0) {
      shouldForceBreak = true;
      break;
    }
  }
  const shouldPrintAttributePerLine =
    shouldForceBreak || (o.format.attributePosition === ATTRIBUTE_POSITION_MULTILINE && attrCount > 1 && !isVueSfcBlock(t, id, o));

  w.startIndent();
  if (forceNotToBreakAttrContent) w.token(TK_SP);
  else if (shouldForceBreak) w.hardline();
  else w.line();
  // In the order they are written in.
  let a = attrStart;
  let c = cStart;
  let isFirst = true;
  for (;;) {
    let isComment: boolean;
    if (a < attrEnd && c < cEnd) {
      isComment = (t.c[c * TC_STRIDE + TCF_SPAN_S] | 0) < (t.a[a * A_STRIDE + AF_SPAN_S] | 0);
    } else if (a < attrEnd) {
      isComment = false;
    } else if (c < cEnd) {
      isComment = true;
    } else {
      break;
    }
    if (!isFirst) {
      if (shouldPrintAttributePerLine) w.hardline();
      else w.line();
    }
    isFirst = false;
    if (!isComment) {
      const attr = a;
      a = a + 1;
      if (ignoredHas(t, ignored, attr, ignoredNames)) {
        w.text(o.originalText, t.a[attr * A_STRIDE + AF_SPAN_S] | 0, t.a[attr * A_STRIDE + AF_SPAN_E] | 0);
      } else {
        const after = cursorMarksBegin(p, TG_IN_START_TAG, t.a[attr * A_STRIDE + AF_SPAN_S] | 0, t.a[attr * A_STRIDE + AF_SPAN_E] | 0);
        printAttribute(p, id, attr);
        cursorMarksEnd(p, after);
      }
    } else {
      const comment = c;
      c = c + 1;
      const cb = comment * TC_STRIDE;
      const after = cursorMarksBegin(p, TG_IN_START_TAG, t.c[cb + TCF_SPAN_S] | 0, t.c[cb + TCF_SPAN_E] | 0);
      // `printStartTagComment`
      const vs = t.c[cb + TCF_VAL_S] | 0;
      const ve = t.c[cb + TCF_VAL_E] | 0;
      if ((t.c[cb + TCF_SINGLE] | 0) !== 0) {
        w.token(TK_LINE_COMMENT);
        w.text(t.pool.data, vs, trimJsWhitespaceEnd(t.pool.data, vs, ve));
      } else {
        w.token(TK_OPEN_BLOCK_COMMENT);
        w.text(t.pool.data, vs, ve);
        w.token(TK_CLOSE_BLOCK_COMMENT);
      }
      cursorMarksEnd(p, after);
    }
  }
  w.endIndent();

  const first = firstChild(t, id);
  const parent = parentOf(t, id);
  if (
    (first >= 0 && needsToBorrowParentOpeningTagEndMarker(t, first)) ||
    (isSelfClosing && parent >= 0 && needsToBorrowLastChildClosingTagEndMarker(t, parent)) ||
    forceNotToBreakAttrContent ||
    o.format.bracketSameLine
  ) {
    if (isSelfClosing) w.token(TK_SP);
  } else if (isSelfClosing) {
    w.line();
  } else {
    w.softline();
  }
}

/** `rawName`: the namespace, if it is written, a colon, and the name of the attribute `a`. */
export function writeRawName(p: Printer, a: number): void {
  const t = p.t;
  const b = t.pool.data;
  const ab = a * A_STRIDE;
  if ((t.a[ab + AF_EXPLICIT_NS] | 0) !== 0 && (t.a[ab + AF_NS_E] | 0) > (t.a[ab + AF_NS_S] | 0)) {
    p.w.text(b, t.a[ab + AF_NS_S] | 0, t.a[ab + AF_NS_E] | 0);
    p.w.token(TK_COLON);
  }
  p.w.text(b, t.a[ab + AF_NAME_S] | 0, t.a[ab + AF_NAME_E] | 0);
}

export const TK_COLON: number = token(":");

function printAttribute(p: Printer, element: number, a: number): void {
  const t = p.t;
  if (formatsEmbedded(p) && embedAttribute(p, element, a)) return;
  writeRawName(p, a);
  const ab = a * A_STRIDE;
  if ((t.a[ab + AF_HAS_VAL] | 0) === 0) return;
  unescapeQuoteEntities(t.pool.data, t.a[ab + AF_VAL_S] | 0, t.a[ab + AF_VAL_E] | 0);
  const UQ$ = UQ;
  const vb = UQ$.buf;
  const vs = UQ$.s;
  const ve = UQ$.e;
  p.w.token(TK_EQ);
  if (shouldUnquoteAttributeValue(t, a, p.o)) {
    p.w.textReplacing(vb, vs, ve, 39, "&apos;");
    return;
  }
  // `getPreferredQuote(value, '"')`
  let dq = 0;
  let sq = 0;
  for (let i = vs; i < ve; i++) {
    const c = vb[i] | 0;
    if (c === 34) dq = dq + 1;
    else if (c === 39) sq = sq + 1;
  }
  if (dq > sq) {
    p.w.token(TK_SQ);
    p.w.textReplacing(vb, vs, ve, 39, "&apos;");
    p.w.token(TK_SQ);
  } else {
    p.w.token(TK_DQ);
    p.w.textReplacing(vb, vs, ve, 34, "&quot;");
    p.w.token(TK_DQ);
  }
}

void ByteBuf;
void jsWhitespaceLen;
void F_END_S;
void IS_LEADING_SPACE_SENSITIVE;
void HAS_END;
void flagsOf;
void nameEnd;
void nameStart;
void nsEnd;
void nsStart;
void HAS_EXPLICIT_NAMESPACE;
void K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETERS;
void K_IE_CONDITIONAL_COMMENT;
void TCF_VAL_E;
void TCF_VAL_S;
void AF_NS_S;
