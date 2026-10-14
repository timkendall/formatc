// Port of vendor/bun/src/format/css/value_groups.rs: Prettier's `print/comma-separated-value-group.js` and
// `print/parenthesized-value-group.js`.
//
// The functions of `impl Printer` here take the printer first, and the scope depth `sd` for `Statement`.
import { hasNewlineBackwards, isNextLineEmpty, trimJsWhitespaceEnd } from "../text.ts";
import { MSG_UNREADABLE_AT_RULE, MSG_UNREADABLE_VALUE } from "../syntax_error.ts";
import {
  endsBeforeEscapedBlank,
  endsWithLit,
  eqLit,
  eqLitIgnoreCase,
  lastIndexOfByteIn,
  lastIndexOfLit,
  lowerByte,
  startsWithLit,
} from "./misc.ts";
import { K_AT_RULE, K_DECL } from "./postcss.ts";
import type { Printer } from "./printer.ts";
import {
  SEP_DEDENTED_HARD_LINE,
  SEP_DEDENTED_LINE,
  SEP_HARD_LINE,
  SEP_LINE,
  SEP_SOFT_LINE,
} from "./sink.ts";
import { SYNTAX_CSS, SYNTAX_LESS, SYNTAX_SCSS } from "./syntax.ts";
import {
  BEFORE_EMPTY,
  BEFORE_SPACES,
  NONE,
  VK_AT_WORD,
  VK_COLON,
  VK_COMMA_GROUP,
  VK_COMMENT,
  VK_FUNC,
  VK_NUMBER,
  VK_OPERATOR,
  VK_PAREN_GROUP,
  VK_ROOT,
  VK_STRING,
  VK_VALUE,
  VK_WORD,
  Values,
  isAtWordPlaceholder,
  isListWithCommaGroup,
} from "./value_parser.ts";
import { SHAPE_GROUP_INDENT, SHAPE_GROUP_FILL, SHAPE_GROUP_INDENT_FILL } from "./value_groups.consts.ts";

/** `isOperator` */
function isOperator(v: Values, id: number, op: number): boolean {
  return (v.kind[id] | 0) === VK_OPERATOR && (v.firstByte[id] | 0) === op;
}
function isMultiplication(v: Values, id: number): boolean {
  return isOperator(v, id, 42);
}
function isDivision(v: Values, id: number): boolean {
  return isOperator(v, id, 47);
}
function isAddition(v: Values, id: number): boolean {
  return isOperator(v, id, 43);
}
function isSubtraction(v: Values, id: number): boolean {
  return isOperator(v, id, 45);
}
function isMathOperator(v: Values, id: number): boolean {
  if ((v.kind[id] | 0) !== VK_OPERATOR) return false;
  const b = v.firstByte[id] | 0;
  return b === 42 || b === 47 || b === 43 || b === 45 || b === 37;
}
/** Not `/`, which is between the parts of `rgb(from a r g b / 50%)` and of `font: 1px / 2 a`. */
function isOperatorOfExpression(v: Values, id: number): boolean {
  return isMathOperator(v, id) && !isDivision(v, id);
}

/** `node.value() == Some(lit)` */
function valueIs(v: Values, id: number, lit: string): boolean {
  return v.hasValueText(id) && eqLit(v.text.data, v.vs[id] | 0, v.ve[id] | 0, lit);
}
function valueEndsWith(v: Values, id: number, lit: string): boolean {
  return v.hasValueText(id) && endsWithLit(v.text.data, v.vs[id] | 0, v.ve[id] | 0, lit);
}
function valueStartsWith(v: Values, id: number, lit: string): boolean {
  return v.hasValueText(id) && startsWithLit(v.text.data, v.vs[id] | 0, v.ve[id] | 0, lit);
}
/** `word(node).is_some()` */
function isWord(v: Values, id: number): boolean {
  return (v.kind[id] | 0) === VK_WORD;
}
function isTheWord(v: Values, id: number, text: string): boolean {
  return (v.kind[id] | 0) === VK_WORD && valueIs(v, id, text);
}
/** `isWordNode` */
function isWordOrAtWord(v: Values, id: number): boolean {
  const k = v.kind[id] | 0;
  return k === VK_WORD || k === VK_AT_WORD;
}
function isFunc(v: Values, id: number): boolean {
  return (v.kind[id] | 0) === VK_FUNC;
}
function isColon(v: Values, id: number): boolean {
  return (v.kind[id] | 0) === VK_COLON;
}
function isComment(v: Values, id: number): boolean {
  return (v.kind[id] | 0) === VK_COMMENT;
}
function isInlineComment(v: Values, id: number): boolean {
  return (v.kind[id] | 0) === VK_COMMENT && (v.inline[id] | 0) !== 0;
}
function hasEmptyRawBefore(v: Values, id: number): boolean {
  return (v.before[id] | 0) === BEFORE_EMPTY;
}

/** `isParenGroupNode`: the `(`, or 0. */
function parenGroupOpen(v: Values, id: number): number {
  if ((v.kind[id] | 0) === VK_PAREN_GROUP && (v.open[id] | 0) !== 0 && (v.close[id] | 0) !== 0) return v.open[id] | 0;
  return 0;
}

/** The `)` of a function or of what is in parentheses (0: none). */
function closingParenthesis(v: Values, id: number): number {
  const group = (v.kind[id] | 0) === VK_FUNC ? v.group[id] | 0 : id;
  if (parenGroupOpen(v, group) !== 0) return v.close[group] | 0;
  return 0;
}

function lineOfClosingParenthesis(v: Values, id: number): number {
  const c = closingParenthesis(v, id);
  return c !== 0 ? v.locStartLine[c] | 0 : NONE;
}

function endOfClosingParenthesis(v: Values, id: number): number {
  const c = closingParenthesis(v, id);
  return c !== 0 ? v.locEndOffset[c] | 0 : NONE;
}

/** Whether white space follows `node`, and the backslash that it ends with escapes that. */
function isBeforeEscapedBlank(v: Values, id: number): boolean {
  return (
    (v.kind[id] | 0) === VK_WORD && v.hasValueText(id) && endsBeforeEscapedBlank(v.text.data, v.vs[id] | 0, v.ve[id] | 0) && v.blanksBehind(id) > 0
  );
}

function endsWhereStarts(v: Values, a: number, b: number): boolean {
  const e = v.locEndOffset[a] | 0;
  return e !== NONE && e === (v.locStartOffset[b] | 0);
}

const COLOR_ADJUSTER_NAMES: string[] = [
  "red", "green", "blue", "alpha", "a", "rgb", "hue", "h", "saturation", "s", "lightness", "l", "whiteness", "w", "blackness", "b",
  "tint", "shade", "blend", "blenda", "contrast", "hsl", "hsla", "hwb", "hwba",
];

/** `isColorAdjusterFuncNode` */
function isColorAdjusterFunc(v: Values, id: number): boolean {
  if (!isFunc(v, id)) return false;
  const d = v.text.data;
  const s = v.vs[id] | 0;
  const e = v.ve[id] | 0;
  for (let i = 0; i < COLOR_ADJUSTER_NAMES.length; i++) {
    if (eqLitIgnoreCase(d, s, e, COLOR_ADJUSTER_NAMES[i])) return true;
  }
  return false;
}

function isPossibleFontSize(v: Values, id: number): boolean {
  if (id === 0) return false;
  const k = v.kind[id] | 0;
  if (k === VK_NUMBER) return true;
  if (k === VK_FUNC) {
    const d = v.text.data;
    const s = v.vs[id] | 0;
    const e = v.ve[id] | 0;
    return (
      eqLitIgnoreCase(d, s, e, "var") || eqLitIgnoreCase(d, s, e, "calc") || eqLitIgnoreCase(d, s, e, "min") || eqLitIgnoreCase(d, s, e, "max") ||
      eqLitIgnoreCase(d, s, e, "clamp") || startsWithLit(d, s, e, "--")
    );
  }
  return false;
}

/** `isKeyValuePairNode` */
function isKeyValuePair(v: Values, id: number): boolean {
  return (v.kind[id] | 0) === VK_COMMA_GROUP && isColonAt(v, id, 1);
}
function isColonAt(v: Values, id: number, index: number): boolean {
  const g = v.groupAt(id, index);
  return g !== 0 && isColon(v, g);
}

/** `isKeyValuePairInParenGroupNode` */
function isKeyValuePairInParenGroup(v: Values, id: number): boolean {
  if ((v.kind[id] | 0) !== VK_PAREN_GROUP) return false;
  const g = v.groupAt(id, 0);
  return g !== 0 && isKeyValuePair(v, g);
}


/** The node of the value that what is being printed is in, and the one that that is in, and so on (0: none). */
function valueAncestor(p: Printer, level: number): number {
  const at = p.nValueStack - (level + 1);
  if (at < 0) return 0;
  return p.valueStack[at] | 0;
}

/** `node`: a `value-comma_group`. */
function shapeOfCommaGroup(p: Printer, sd: number, node: number): number {
  const v = p.parsed.values;
  const atRule = p.atRuleAround(sd);
  if (atRule !== null && p.isScssControlDirective(atRule)) return SHAPE_GROUP_INDENT;
  if (v.groupCount(node) === 2) {
    const g0 = v.groupAt(node, 0);
    if (valueIs(v, g0, "url") && atRule !== null && eqLit(p.ctx.buf.data, atRule.nameS, atRule.nameE, "import")) {
      // `insideURLFunctionInImportAtRuleNode`: `@import url("very long") projection,tv`
      return SHAPE_GROUP_FILL;
    }
  }
  return SHAPE_GROUP_INDENT_FILL;
}

/** `is_operator_at` of the loop */
function isOperatorAt(v: Values, node: number, at: number): boolean {
  const it = v.groupAt(node, at);
  if (it === 0) return false;
  if (!isOperatorOfExpression(v, it)) return false;
  if (hasEmptyRawBefore(v, it)) return true;
  const next = v.groupAt(node, at + 1);
  return !(next !== 0 && hasEmptyRawBefore(v, next));
}

/** `is_glued_division` */
function isGluedDivision(v: Values, operator: number, before: number, after: number): boolean {
  if (!isDivision(v, operator) || !hasEmptyRawBefore(v, operator)) return false;
  if (after !== 0 && !hasEmptyRawBefore(v, after)) return false;
  if (before !== 0 && (v.kind[before] | 0) === VK_AT_WORD) return false;
  if (after !== 0 && (v.kind[after] | 0) === VK_AT_WORD) return false;
  return true;
}

export function printCommaSeparatedValueGroup(p: Printer, sd: number, id: number): void {
  const v = p.parsed.values;
  const sink = p.sink;
  const node = id;
  const parent = valueAncestor(p, 0);
  const grandparent = valueAncestor(p, 1);
  // `getPropOfDeclNode`
  const decl = p.cssAncestor(sd, K_DECL);
  const d = p.ctx.buf.data;
  let propIsGrid = false;
  let propIsFontOrCustom = false;
  if (decl !== null) {
    propIsGrid = eqLitIgnoreCase(d, decl.propS, decl.propE, "grid") || lowerStartsWith(d, decl.propS, decl.propE, "grid-template");
    propIsFontOrCustom = eqLitIgnoreCase(d, decl.propS, decl.propE, "font") || startsWithLit(d, decl.propS, decl.propE, "--");
  }
  const isGridValue = parent !== 0 && (v.kind[parent] | 0) === VK_VALUE && propIsGrid;
  const atRule = p.atRuleAround(sd);
  const isControlDirective = atRule !== null && p.isScssControlDirective(atRule);
  const count = v.groupCount(node);
  let hasInlineComment = false;
  for (let k = 0; k < count; k++) {
    if (isInlineComment(v, v.groupAt(node, k))) { hasInlineComment = true; break; }
  }
  const isInParenGroup = parent !== 0 && (v.kind[parent] | 0) === VK_PAREN_GROUP;

  // `insideValueFunctionNode`
  const fn = p.valueFunction();
  const insideUrl = fn !== 0 && eqLitIgnoreCase(v.text.data, v.vs[fn] | 0, v.ve[fn] | 0, "url");
  const insideCalc = fn !== 0 && eqLitIgnoreCase(v.text.data, v.vs[fn] | 0, v.ve[fn] | 0, "calc");
  const insideType = fn !== 0 && eqLitIgnoreCase(v.text.data, v.vs[fn] | 0, v.ve[fn] | 0, "type");
  const isInScssIf = p.syntax() === SYNTAX_SCSS && isInParenGroup && grandparent !== 0 && isFunc(v, grandparent) && valueIs(v, grandparent, "if");

  // For oxfmt one of the values of a declaration is laid out as it is without the line comments before it. For Prettier it is
  // one of several things that fill lines, which are indented.
  if (p.isOxfmt && isInParenGroup && atRule === null && count > 1) {
    let allBefore = true;
    for (let k = 0; k < count - 1; k++) {
      if (!isInlineComment(v, v.groupAt(node, k))) { allBefore = false; break; }
    }
    if (allBefore && !isInlineComment(v, v.groupAt(node, count - 1))) {
      let previous = 0;
      for (let k = 0; k < count; k++) {
        const it = v.groupAt(node, k);
        if (it === p.commentBehindComma) {
          p.commentBehindComma = 0;
          continue;
        }
        p.pushValue(id);
        p.printValue(sd, it, previous);
        previous = it;
        p.popValue();
        if (isInlineComment(v, it)) sink.hardLine();
      }
      return;
    }
  }

  const shape = shapeOfCommaGroup(p, sd, node);
  sink.startGroup(false);
  if (shape !== SHAPE_GROUP_FILL) sink.startIndent();
  sink.startFill();
  let insideScssInterpolationInString = false;
  let didBreak = false;
  // For oxfmt, `$a * 2` in SCSS is one expression, so next to other values it is one of what the lines are filled with, and is
  // filled itself.
  const hasExpressions = p.isOxfmt && p.syntax() === SYNTAX_SCSS && !insideCalc;
  let isInExpression = false;

  const writtenAbove = p.commentsAboveItem === id ? p.commentsAboveCount : 0;
  for (let i = writtenAbove; i < count; i++) {
    const iNode = v.groupAt(node, i);
    const prevNode = i >= 1 && i - 1 >= writtenAbove ? v.groupAt(node, i - 1) : 0;
    const nextNode = v.groupAt(node, i + 1);

    if (iNode === p.commentBehindComma) {
      p.commentBehindComma = 0;
      continue;
    }

    // `a -1px` is two values.
    const isBeforeOperator = hasExpressions && !isMathOperator(v, iNode) && !isComment(v, iNode) && isOperatorAt(v, node, i + 1);
    if (!isInExpression && isBeforeOperator && (prevNode === 0 || !isOperatorOfExpression(v, prevNode))) {
      let last = i;
      while (isOperatorAt(v, node, last + 1)) {
        const nn = v.groupAt(node, last + 2);
        if (nn !== 0 && !isMathOperator(v, nn)) last = last + 2;
        else break;
      }
      if (i > 0 || v.groupAt(node, last + 1) !== 0) {
        isInExpression = true;
        sink.startGroup(false);
        sink.startIndent();
        sink.startFill();
      }
    }

    const isAtEndOfLine = isInlineComment(v, iNode) && nextNode === 0;
    if (isAtEndOfLine) {
      sink.startLineSuffix();
      sink.token(" ");
    }
    p.indexInCommaGroup = i;
    p.pushValue(id);
    p.printValue(sd, iNode, prevNode);
    p.popValue();
    if (isInExpression && !isBeforeOperator && (!isMathOperator(v, iNode) || nextNode === 0)) {
      isInExpression = false;
      sink.endFill();
      sink.endIndent();
      sink.endGroup();
    }
    if (isAtEndOfLine) {
      sink.endLineSuffix();
      continue;
    }

    if (insideUrl) {
      if ((nextNode !== 0 && isAddition(v, nextNode)) || isAddition(v, iNode)) sink.token(" ");
      continue;
    }

    // The wildcard of `@forward .. as a-*`.
    if (p.insideAtRule(sd, "forward", "", "") && isWord(v, iNode) && v.ve[iNode] > v.vs[iNode] && prevNode !== 0 && isTheWord(v, prevNode, "as")) {
      // Prettier takes it for granted that something follows.
      if (nextNode === 0) p.fail(MSG_UNREADABLE_AT_RULE, p.nodes[sd].start);
      if (nextNode !== 0 && isMultiplication(v, nextNode)) continue;
    }
    // `@utility a-*` of Tailwind.
    if (p.insideAtRule(sd, "utility", "", "") && isWord(v, iNode) && nextNode !== 0 && isMultiplication(v, nextNode)) continue;
    if (nextNode === 0) {
      // `(b a\ )`, of which Prettier prints `(b a\)`. The end of all of the value is up to who prints that.
      if (isInParenGroup && isBeforeEscapedBlank(v, iNode) && v.isBeforeMore(iNode)) sink.token(" ");
      continue;
    }
    // `if(condition: value; else: value)`
    if (isInScssIf && isTheWord(v, nextNode, ";")) continue;
    if (isWord(v, iNode) && isAtWordPlaceholder(v, nextNode) && endsWhereStarts(v, iNode, nextNode)) continue;

    // `"#{my-fn("_")}"`
    if ((v.kind[iNode] | 0) === VK_STRING && v.hasValueText(iNode)) {
      const s = v.vs[iNode] | 0;
      const e = v.ve[iNode] | 0;
      const opening = lastIndexOfLit(v.text.data, s, e, "#{");
      const closing = lastIndexOfByteIn(v.text.data, s, e, 125);
      if (opening >= 0 && closing >= 0) insideScssInterpolationInString = opening > closing;
      else if (opening >= 0) insideScssInterpolationInString = true;
      else if (closing >= 0) insideScssInterpolationInString = false;
    }
    if (insideScssInterpolationInString) continue;

    if (isColon(v, iNode) || isColon(v, nextNode)) continue;
    // `@@var`, `@var[ @notVarNested ][notVar]` in Less.
    if ((v.kind[iNode] | 0) === VK_AT_WORD && v.hasValueText(iNode) && (v.ve[iNode] === v.vs[iNode] || valueEndsWith(v, iNode, "["))) continue;
    if (isWord(v, nextNode) && valueStartsWith(v, nextNode, "]")) continue;
    // `[ a ]` is `[a]` for oxfmt and `[ a]` for Prettier.
    if (p.isOxfmt && isWord(v, iNode) && valueEndsWith(v, iNode, "[")) continue;
    // `~"escaped"` in Less.
    if (valueIs(v, iNode, "~")) continue;
    if (p.syntax() === SYNTAX_LESS) {
      if (isTheWord(v, nextNode, "[")) continue;
      if (isWord(v, iNode) && valueEndsWith(v, iNode, "[") && isWordOrAtWord(v, nextNode)) continue;
    }

    const iNonEmptyValue = v.hasValueText(iNode) && (v.ve[iNode] | 0) > (v.vs[iNode] | 0);
    if (
      (v.kind[iNode] | 0) !== VK_STRING && iNonEmptyValue && containsBackslash(v, iNode) && !isComment(v, nextNode)
    ) {
      // Prettier writes nothing between the two: `Font\ Awesome` becomes `Font\Awesome`, and `a\b c` one word.
      if ((v.before[nextNode] | 0) === BEFORE_SPACES) {
        const nk = v.kind[nextNode] | 0;
        const isWordLike = nk === VK_WORD || nk === VK_NUMBER || nk === VK_STRING || nk === VK_FUNC || nk === VK_AT_WORD;
        if (isBeforeEscapedBlank(v, iNode)) {
          if (isWordLike && v.blanksBehind(iNode) > 1) sink.token("  ");
          else sink.token(" ");
        } else if (isWordLike) {
          sink.token(" ");
        }
      }
      continue;
    }
    // An escaped `/`.
    if (prevNode !== 0 && v.hasValueText(prevNode)) {
      const ps = v.vs[prevNode] | 0;
      const pe = v.ve[prevNode] | 0;
      if (pe > ps) {
        const idx = indexOfBackslash(v.text.data, ps, pe);
        if (idx === pe - 1 - ps && isDivision(v, iNode)) continue;
      }
    }
    if (valueIs(v, iNode, "\\")) continue;
    // `isPostcssSimpleVarNode`: `$$(style)Color`
    if (isFunc(v, iNode) && valueIs(v, iNode, "$$") && isWord(v, nextNode) && (v.before[nextNode] | 0) !== BEFORE_SPACES) continue;

    // `#{variable}`
    if (
      isTheWord(v, iNode, "#") || isTheWord(v, iNode, "{") || isTheWord(v, nextNode, "}") ||
      (isTheWord(v, nextNode, "{") && hasEmptyRawBefore(v, nextNode)) || (isTheWord(v, iNode, "}") && hasEmptyRawBefore(v, nextNode))
    ) {
      continue;
    }
    // `--#{$var}`
    if (valueIs(v, iNode, "--") && isTheWord(v, nextNode, "#")) continue;

    const isMath = isMathOperator(v, iNode);
    const isNextMath = isMathOperator(v, nextNode);

    // Next to an interpolation, the spaces around an operator stay as they are.
    if (((isMath && isTheWord(v, nextNode, "#")) || (isNextMath && isTheWord(v, iNode, "}"))) && hasEmptyRawBefore(v, nextNode)) continue;
    // `type(<number>+)`
    if (isAddition(v, nextNode) && insideType && hasEmptyRawBefore(v, nextNode)) continue;
    // `-fb-url(/abs/path/)`
    if (prevNode === 0 && isDivision(v, iNode)) continue;
    // For oxfmt the blanks around every operator in `calc()` stay as they are, and the line can end behind one that has a
    // blank behind it.
    if (p.isOxfmt && insideCalc && (isMath || isNextMath)) {
      if (hasEmptyRawBefore(v, nextNode)) {
        // nothing
      } else if (isNextMath) {
        sink.token(" ");
      } else {
        sink.fillSeparator(SEP_LINE);
      }
      continue;
    }
    // In `calc()`, the spaces around `+` and `-` stay as they are.
    if (
      insideCalc && (isAddition(v, iNode) || isAddition(v, nextNode) || isSubtraction(v, iNode) || isSubtraction(v, nextNode)) &&
      hasEmptyRawBefore(v, nextNode)
    ) {
      continue;
    }
    // A unary minus before a function.
    if (p.syntax() === SYNTAX_SCSS && isMath && isSubtraction(v, iNode) && isFunc(v, nextNode) && !endsWhereStarts(v, iNode, nextNode)) {
      // For oxfmt it is an operator like any other: the line can end behind it.
      if (p.isOxfmt) sink.fillSeparator(SEP_LINE);
      else sink.token(" ");
      continue;
    }

    const nextNextNode = v.groupAt(node, i + 2);

    // For oxfmt `50%/var(--a)` stays as it is.
    if (
      p.isOxfmt && p.syntax() !== SYNTAX_SCSS &&
      (isGluedDivision(v, nextNode, iNode, nextNextNode) || isGluedDivision(v, iNode, prevNode, nextNode))
    ) {
      continue;
    }

    // `color(red l(+ 20%))`
    const nextKind = v.kind[nextNode] | 0;
    const isColorAdjuster =
      (isAddition(v, iNode) || isSubtraction(v, iNode)) && i === 0 &&
      (nextKind === VK_NUMBER || (nextKind === VK_WORD && (v.isHex[nextNode] | 0) !== 0)) &&
      grandparent !== 0 && isColorAdjusterFunc(v, grandparent) && !hasEmptyRawBefore(v, nextNode);
    const requireSpaceBeforeOperator = isFuncOrWord(v, nextNextNode) || isFuncOrWord(v, iNode);
    const requireSpaceAfterOperator = isFuncOrWord(v, nextNode) || isFuncOrWord(v, prevNode);

    // `/`, `+`, `-`
    if (
      !(isMultiplication(v, nextNode) || isMultiplication(v, iNode)) && !insideCalc && !isColorAdjuster &&
      ((isDivision(v, nextNode) && !requireSpaceBeforeOperator) ||
        (isDivision(v, iNode) && !requireSpaceAfterOperator) ||
        (isAddition(v, nextNode) && !requireSpaceBeforeOperator) ||
        (isAddition(v, iNode) && !requireSpaceAfterOperator) ||
        isSubtraction(v, nextNode) ||
        isSubtraction(v, iNode)) &&
      (hasEmptyRawBefore(v, nextNode) || (isMath && (prevNode === 0 || isMathOperator(v, prevNode))))
    ) {
      continue;
    }

    // `-(`
    if (
      (p.syntax() === SYNTAX_SCSS || p.syntax() === SYNTAX_LESS) && isMath && isSubtraction(v, iNode) &&
      parenGroupOpen(v, nextNode) !== 0 && endsWhereStarts(v, iNode, parenGroupOpen(v, nextNode))
    ) {
      continue;
    }

    if (isInlineComment(v, iNode)) {
      sink.fillSeparator(isInParenGroup ? SEP_DEDENTED_HARD_LINE : SEP_HARD_LINE);
      continue;
    }

    // The keywords of `@if`, `@each`, `@for`.
    if (
      isControlDirective &&
      (isOneOfWords2(v, nextNode, "==", "!=") ||
        isOneOfWords4(v, nextNode, "<", ">", "<=", ">=") ||
        isOneOfWords3(v, nextNode, "and", "or", "not") ||
        isTheWord(v, iNode, "in") ||
        isOneOfWords3(v, iNode, "from", "through", "end"))
    ) {
      sink.token(" ");
      continue;
    }

    if (atRule !== null && eqLitIgnoreCase(d, atRule.nameS, atRule.nameE, "namespace")) {
      sink.token(" ");
      continue;
    }

    if (isGridValue) {
      // oxfmt asks what is between the two, not where they start.
      let line = NONE;
      let hasLine = false;
      if (p.isOxfmt) {
        line = lineOfClosingParenthesis(v, iNode);
        hasLine = line !== NONE;
      }
      if (!hasLine) line = v.locStartLine[iNode] | 0;
      if (v.hasSource(iNode) && v.hasSource(nextNode) && line !== (v.locStartLine[nextNode] | 0)) {
        sink.fillSeparator(SEP_HARD_LINE);
        didBreak = true;
      } else {
        sink.token(" ");
      }
      continue;
    }

    // `font: 12px/1.5 a`
    if (propIsFontOrCustom) {
      if (isDivision(v, nextNode) && hasEmptyRawBefore(v, nextNode) && isPossibleFontSize(v, iNode)) continue;
      if (isDivision(v, iNode) && hasEmptyRawBefore(v, iNode) && isPossibleFontSize(v, prevNode)) continue;
    }

    // For oxfmt a `;` is right behind what is before it, like any other.
    if (p.isOxfmt && valueIs(v, nextNode, ";")) continue;
    // For oxfmt `-600px` behind a blank is one word, which the line can end before.
    if (
      p.isOxfmt && p.syntax() === SYNTAX_CSS && !insideCalc && (isAddition(v, nextNode) || isSubtraction(v, nextNode)) &&
      !hasEmptyRawBefore(v, nextNode) && nextNextNode !== 0 && hasEmptyRawBefore(v, nextNextNode)
    ) {
      sink.fillSeparator(SEP_LINE);
      continue;
    }
    if (isNextMath) {
      sink.token(" ");
      continue;
    }
    // `function(returns-list($list)...)`
    if (valueIs(v, nextNode, "...")) continue;
    if (isAtWordPlaceholder(v, iNode) && isAtWordPlaceholder(v, nextNode) && endsWhereStarts(v, iNode, nextNode)) continue;
    if (isAtWordPlaceholder(v, iNode)) {
      const open = parenGroupOpen(v, nextNode);
      if (open !== 0 && endsWhereStarts(v, iNode, open)) {
        sink.fillSeparator(SEP_SOFT_LINE);
        continue;
      }
    }
    if (valueIs(v, iNode, "with") && parenGroupOpen(v, nextNode) !== 0) {
      sink.nestFill();
      sink.token(" ");
      continue;
    }
    // `--a#{(1) + 2}`
    if (valueEndsWith(v, iNode, "#") && valueIs(v, nextNode, "{")) {
      const nk = v.kind[nextNode] | 0;
      if (nk === VK_FUNC) {
        if (parenGroupOpen(v, v.group[nextNode] | 0) !== 0) continue;
      } else {
        // Prettier takes it for a function.
        p.fail(MSG_UNREADABLE_VALUE, p.nodes[sd].start);
      }
    }

    // It is printed at the end of the line, with the space before it.
    if (isInlineComment(v, nextNode) && nextNextNode === 0) continue;
    // The value is in line with the block comments before it.
    if (atRule === null && isComment(v, iNode) && (v.inline[iNode] | 0) === 0) {
      let allComments = true;
      for (let k = 0; k < i; k++) {
        if (!isComment(v, v.groupAt(node, k))) { allComments = false; break; }
      }
      if (allComments) {
        sink.fillSeparator(SEP_DEDENTED_LINE);
        continue;
      }
    }
    sink.fillSeparator(SEP_LINE);
  }

  if (hasInlineComment) sink.breakParent();
  if (didBreak) sink.startFillWithHardLine();
  if (shape === SHAPE_GROUP_INDENT) sink.endFillAsArray();
  else sink.endFill();
  if (shape !== SHAPE_GROUP_FILL) sink.endIndent();
  sink.endGroup();
}

function isFuncOrWord(v: Values, n: number): boolean {
  if (n === 0) return false;
  const k = v.kind[n] | 0;
  return k === VK_FUNC || k === VK_WORD || k === VK_AT_WORD;
}

function lowerStartsWith(d: Uint8Array, s: number, e: number, lit: string): boolean {
  if (e - s < lit.length) return false;
  for (let i = 0; i < lit.length; i++) {
    if (lowerByte(d[s + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

function containsBackslash(v: Values, id: number): boolean {
  const d = v.text.data;
  const e = v.ve[id] | 0;
  for (let i = v.vs[id] | 0; i < e; i++) {
    if ((d[i] | 0) === 92) return true;
  }
  return false;
}

/** The index (relative to s) of the first `\` in d[s, e), or -1. */
function indexOfBackslash(d: Uint8Array, s: number, e: number): number {
  for (let i = s; i < e; i++) {
    if ((d[i] | 0) === 92) return i - s;
  }
  return -1;
}

function isOneOfWords2(v: Values, id: number, a: string, b: string): boolean {
  return isTheWord(v, id, a) || isTheWord(v, id, b);
}
function isOneOfWords3(v: Values, id: number, a: string, b: string, c: string): boolean {
  return isTheWord(v, id, a) || isTheWord(v, id, b) || isTheWord(v, id, c);
}
function isOneOfWords4(v: Values, id: number, a: string, b: string, c: string, e: string): boolean {
  return isTheWord(v, id, a) || isTheWord(v, id, b) || isTheWord(v, id, c) || isTheWord(v, id, e);
}

/** `printTrailingComma`: whether there is a comma behind the last of what is in the parentheses `node`. */
function hasCommaBeforeClosingParenthesis(p: Printer, node: number): boolean {
  const v = p.parsed.values;
  const count = v.groupCount(node);
  if (count === 0) return false;
  const last = v.groupAt(node, count - 1);
  const start = v.locStartOffset[last] | 0;
  const close = v.close[node] | 0;
  if (start === NONE || close === 0) return false;
  const end = v.locStartOffset[close] | 0;
  if (end === NONE) return false;
  const orig = p.ctx.originalText;
  if (start > end || end > p.ctx.originalLen) return false;
  const te = trimJsWhitespaceEnd(orig, start, end);
  return te > start && (orig[te - 1] | 0) === 44;
}

/** Writes the comments before the key of `item`, a pair of a key and a value in the list `list`, where oxfmt has them: next to
 * the pair, not in it, and each on a line of its own if the pair takes more than one. Returns whether it has started the group
 * for that, which the caller ends behind the pair. */
function printCommentsAbovePair(p: Printer, sd: number, list: number, item: number): boolean {
  const v = p.parsed.values;
  const sink = p.sink;
  if (!p.isOxfmt || (v.kind[item] | 0) !== VK_COMMA_GROUP) return false;
  const g0 = v.groupAt(item, 0);
  if (g0 === 0 || !isComment(v, g0)) return false;
  if (p.atRuleAround(sd) !== null) return false;
  const total = v.groupCount(item);
  let count = 0;
  while (count < total && isComment(v, v.groupAt(item, count))) count = count + 1;
  if (count === 0 || !isColonAt(v, item, count + 1)) return false;
  sink.startGroup(false);
  for (let k = 0; k < count; k++) {
    const comment = v.groupAt(item, k);
    if (comment === p.commentBehindComma) {
      p.commentBehindComma = 0;
      continue;
    }
    p.pushValue(list);
    p.printChildValue(sd, item, comment);
    p.popValue();
    if (isInlineComment(v, comment)) sink.hardLine();
    else sink.line();
  }
  p.commentsAboveItem = item;
  p.commentsAboveCount = count;
  return true;
}

/** For oxfmt a `//` comment on the line of a comma stays there. For Prettier it is the first of what follows the comma, `next`,
 * and on a line of its own. Returns whether it has been written. */
function printCommentBehindComma(p: Printer, sd: number, next: number): boolean {
  if (!p.isOxfmt) return false;
  const v = p.parsed.values;
  const sink = p.sink;
  if (next === 0 || (v.kind[next] | 0) !== VK_COMMA_GROUP || v.groupCount(next) <= 1) return false;
  const comment = v.groupAt(next, 0);
  if (comment === 0 || !isInlineComment(v, comment)) return false;
  const so = v.locStartOffset[comment] | 0;
  const isOnLineOfComma = so !== NONE && !hasNewlineBackwards(p.ctx.originalText, so);
  if (!isOnLineOfComma) return false;
  sink.startLineSuffix();
  sink.token(" ");
  p.printValue(sd, comment, 0);
  sink.endLineSuffix();
  sink.breakParent();
  p.commentBehindComma = comment;
  return true;
}

function startsWithPair(p: Printer, v: Values, it: number): boolean {
  if (p.isOxfmt) {
    if ((v.kind[it] | 0) !== VK_PAREN_GROUP) return false;
    const first = v.groupAt(it, 0);
    if (first === 0) return false;
    let key = 0;
    const total = v.groupCount(first);
    while (key < total && isComment(v, v.groupAt(first, key))) key = key + 1;
    return (v.kind[first] | 0) === VK_COMMA_GROUP && isColonAt(v, first, key + 1);
  }
  return isKeyValuePairInParenGroup(v, it);
}

/** `isSCSSMapItemNode`, for `node`, which is in `valueStack`. */
function isScssMapItem(p: Printer, sd: number, node: number): boolean {
  if (p.syntax() !== SYNTAX_SCSS) return false;
  const v = p.parsed.values;
  if (v.groupCount(node) === 0) return false;
  // `$key: (value)` is not a list.
  if (parenGroupOpen(v, node) !== 0 && v.groupCount(node) === 1 && (v.kind[v.groupAt(node, 0)] | 0) !== VK_COMMA_GROUP) return false;
  const parent = valueAncestor(p, 0);
  if (parent !== 0 && isFunc(v, parent) && valueIs(v, parent, "if")) return false;
  const grandparent = valueAncestor(p, 1);
  // For oxfmt a map is a map with a comment before its first key too.
  const isInPair = grandparent !== 0 && startsWithPair(p, v, grandparent);
  if (!startsWithPair(p, v, node) && !isInPair) return false;
  // `$map: (key: value, other-key: other-value)`
  const decl = p.cssAncestor(sd, K_DECL);
  if (decl !== null && decl.propE > decl.propS && (p.ctx.buf.data[decl.propS] | 0) === 36) return true;
  // `$map: (key: (value other-value other-other-value))`
  if (isInPair) {
    if (parent === 0) return true;
    const total = v.groupCount(parent);
    for (let k = 0; k < total; k++) {
      if (isMathOperator(v, v.groupAt(parent, k))) return false;
    }
    return true;
  }
  // `func((key: value, other-key: other-value))`
  return grandparent !== 0 && isFunc(v, grandparent);
}

/** Whether what is being printed is the `group` of the `group` of the root of a value. */
function isTopLevelOfValue(p: Printer): boolean {
  if (p.nValueStack !== 2) return false;
  const v = p.parsed.values;
  return (v.kind[p.valueStack[0] | 0] | 0) === VK_ROOT && (v.kind[p.valueStack[1] | 0] | 0) === VK_VALUE;
}

/** `shouldBreakList`, for `node`, which is in `valueStack`. */
function shouldBreakList(p: Printer, sd: number, node: number): boolean {
  const v = p.parsed.values;
  if (!isListWithCommaGroup(v, node, p.isOxfmt) || !isTopLevelOfValue(p)) return false;
  const n = p.nodes[sd];
  if (n.kind === K_DECL) return !startsWithLit(p.ctx.buf.data, n.propS, n.propE, "--");
  if (n.kind === K_AT_RULE) return n.variable;
  return false;
}

function parenText(v: Values, paren: number): string {
  if (paren === 0) return "";
  if (valueIs(v, paren, "(")) return "(";
  return ")";
}

export function printParenthesizedValueGroup(p: Printer, sd: number, id: number): void {
  const v = p.parsed.values;
  const sink = p.sink;
  const node = id;
  const open = v.open[node] | 0;
  const close = v.close[node] | 0;
  const parent = valueAncestor(p, 0);
  const count = v.groupCount(node);

  const isUrl = parent !== 0 && isFunc(v, parent) && v.hasValueText(parent) && eqLitIgnoreCase(v.text.data, v.vs[parent] | 0, v.ve[parent] | 0, "url");
  if (isUrl) {
    let cond = count === 1;
    if (!cond) {
      const first = v.groupAt(node, 0);
      if (first !== 0 && (v.kind[first] | 0) === VK_COMMA_GROUP) {
        const g0 = v.groupAt(first, 0);
        cond = g0 !== 0 && isWord(v, g0) && valueStartsWith(v, g0, "data:");
      }
    }
    if (cond) {
      sink.token(parenText(v, open));
      for (let index = 0; index < count; index++) {
        if (index > 0) sink.token(",");
        p.printChildValue(sd, id, v.groupAt(node, index));
      }
      sink.token(parenText(v, close));
      return;
    }
  }

  if (open === 0) {
    const forceHardLine = shouldBreakList(p, sd, node);
    // `shouldPrecededBySoftline`
    const isPrecededBySoftline = isTopLevelOfValue(p) && p.nodes[sd].kind === K_DECL;
    sink.startIndent();
    if (forceHardLine) {
      sink.hardLine();
    } else {
      sink.startGroup(false);
      if (isPrecededBySoftline) sink.softLine();
      sink.startFill();
    }
    let isBehindComment = false;
    for (let index = 0; index < count; index++) {
      const child = v.groupAt(node, index);
      if (index > 0) {
        if (forceHardLine) sink.hardLine();
        else if (isBehindComment) sink.fillSeparator(SEP_HARD_LINE);
        else sink.fillSeparator(SEP_LINE);
      }
      p.printChildValue(sd, id, child);
      if (index + 1 < count) {
        // Or the backslash would escape the `,`.
        if (isBeforeEscapedBlank(v, child)) sink.token(" ");
        sink.token(",");
        isBehindComment = printCommentBehindComma(p, sd, v.groupAt(node, index + 1));
      }
    }
    if (!forceHardLine) {
      sink.endFill();
      sink.endGroup();
    }
    sink.endIndent();
    return;
  }

  const isVar = parent !== 0 && isFunc(v, parent) && v.hasValueText(parent) && eqLitIgnoreCase(v.text.data, v.vs[parent] | 0, v.ve[parent] | 0, "var");
  let isScssMap = isScssMapItem(p, sd, node);
  // What has written the group that this is in knows. There can be as many of these in it as the text is long.
  const hint = p.indexInCommaGroup;
  let parentIsCommaGroup = false;
  let indexInParent = -1;
  if (parent !== 0 && (v.kind[parent] | 0) === VK_COMMA_GROUP) {
    parentIsCommaGroup = true;
    if (v.groupAt(parent, hint) === id) {
      indexInParent = hint;
    } else {
      const total = v.groupCount(parent);
      for (let k = 0; k < total; k++) {
        if (v.groupAt(parent, k) === id) { indexInParent = k; break; }
      }
    }
  }
  // `isKeyInValuePairNode`
  const isKey = indexInParent >= 0 && isKeyValuePair(v, parent) && isColonAt(v, parent, indexInParent + 1);
  // `isConfigurationNode`: `@use "a" with (..)`
  let isConfiguration = false;
  if (close !== 0) {
    let allCommaGroups = true;
    for (let k = 0; k < count; k++) {
      if ((v.kind[v.groupAt(node, k)] | 0) !== VK_COMMA_GROUP) { allCommaGroups = false; break; }
    }
    if (allCommaGroups && indexInParent >= 0 && parentIsCommaGroup && indexInParent >= 1) {
      const before = v.groupAt(parent, indexInParent - 1);
      isConfiguration = before !== 0 && isTheWord(v, before, "with");
    }
  }
  // For oxfmt only a list of several and a map have each item on a line of its own, and a comma at the end if there is none:
  // `($a + $b,)` is not `($a + $b)`. It is a list of one, and stays one.
  const first0 = v.groupAt(node, 0);
  const isOneValue = p.isOxfmt && count === 1 && !(first0 !== 0 && isKeyValuePair(v, first0));
  isScssMap = isScssMap && !isOneValue;
  const isListOfOne = isOneValue && p.syntax() === SYNTAX_SCSS && !(parent !== 0 && isFunc(v, parent)) && hasCommaBeforeClosingParenthesis(p, node);
  const shouldBreak = isConfiguration || (isScssMap && !isKey);
  const shouldDedent = isConfiguration || isKey;

  if (shouldDedent) sink.startDedent();
  sink.startGroup(shouldBreak);
  sink.token(parenText(v, open));
  sink.startIndent();
  sink.softLine();
  for (let index = 0; index < count; index++) {
    const child = v.groupAt(node, index);
    const isLast = index + 1 === count;
    if (index > 0) sink.line();
    // For oxfmt the comments before a key make no difference to what follows them.
    const isInGroupWithComments = printCommentsAbovePair(p, sd, id, child);
    const key = p.commentsAboveItem === child ? p.commentsAboveCount : 0;
    // A pair of a key and a value in parentheses is indented already.
    const childIsCommaGroup = (v.kind[child] | 0) === VK_COMMA_GROUP;
    let isDedented = false;
    if (childIsCommaGroup && isColonAt(v, child, key + 1)) {
      const gk = v.groupAt(child, key);
      const gk2 = v.groupAt(child, key + 2);
      isDedented =
        gk !== 0 && (v.kind[gk] | 0) !== VK_PAREN_GROUP && gk2 !== 0 && (v.kind[gk2] | 0) === VK_PAREN_GROUP &&
        shapeOfCommaGroup(p, sd, child) === SHAPE_GROUP_INDENT_FILL;
    }
    if (isDedented) {
      sink.startGroup(false);
      sink.startDedent();
    }
    p.printChildValue(sd, id, child);
    // `(a\ )`, of which Prettier prints `(a\)`. One word is in no group that would write the blank.
    if (isBeforeEscapedBlank(v, child)) sink.token(" ");
    p.commentsAboveItem = 0;
    p.commentsAboveCount = 0;
    if (isDedented) {
      sink.endIndent();
      sink.endGroup();
    }
    if (isInGroupWithComments) sink.endGroup();

    if (!isLast) {
      sink.token(",");
      printCommentBehindComma(p, sd, v.groupAt(node, index + 1));
    } else {
      let isOnlyComments = isComment(v, child);
      if (!isOnlyComments && childIsCommaGroup) {
        isOnlyComments = true;
        const total = v.groupCount(child);
        for (let k = 0; k < total; k++) {
          if (!isComment(v, v.groupAt(child, k))) { isOnlyComments = false; break; }
        }
      }
      if (isListOfOne || (isVar && hasCommaBeforeClosingParenthesis(p, node))) {
        sink.token(",");
      } else if (!isOnlyComments && p.trailingComma && isScssMap) {
        sink.ifBreak(",");
      }
    }

    if (!isLast && childIsCommaGroup) {
      const gc = v.groupCount(child);
      if (gc > 0) {
        const last = v.groupAt(child, gc - 1);
        let end = NONE;
        if (p.isOxfmt) end = endOfClosingParenthesis(v, last);
        if (end === NONE && v.hasSource(last)) end = v.locEndOffset[last] | 0;
        if (end !== NONE) {
          // It may look at what follows the declaration.
          p.isMemoizable = false;
          if (isNextLineEmpty(p.ctx.originalText, end)) sink.hardLine();
        }
      }
    }
  }
  sink.endIndent();
  sink.softLine();
  sink.lineSuffixBoundary();
  sink.token(parenText(v, close));
  sink.endGroup();
  if (shouldDedent) sink.endIndent();
}

void K_AT_RULE;
