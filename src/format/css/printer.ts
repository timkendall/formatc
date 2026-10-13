// Port of vendor/bun/src/format/css/printer.rs: Prettier's `printer-postcss.js` and `print/sequence.js`.
//
// Rust -> TS (see also the header of parse.ts):
// - A `Scope` is a depth `sd`: `nodes[sd]` is the `CssNode` being printed, `scopeTree[sd]` the tree it is a node of, and
//   `scopeAtRule[sd]` the at-rule that it is or is in (`Statement::at_rule`). `Statement` is `sd` plus `parsed` (the selectors and
//   values of the node), which are the printer's.
// - `unit(is_too_long, |printer| ..)` is written out where it is used: `startUnit()`, the body (a method, called once or
//   twice), `endUnit()`.
// - Text that Rust makes (`Cow`) goes through `scratch` / `scratch2` and is written from there.
// - A `SyntaxError` is `fail(message, offset)`: the first one wins.
import { ByteBuf } from "../../base/bytebuf.ts";
import { FORMAT_NESTED_TOO_DEEPLY } from "../errors.ts";
import {
  hasNewlineBackwards,
  isNextLineEmpty,
  leadingWhiteSpaceLen,
  trimJsWhitespaceEnd,
  trimJsWhitespaceStart,
} from "../text.ts";
import {
  MSG_UNREADABLE_VALUE,
  refusalMessage,
  refusalOffset,
} from "../syntax_error.ts";
import { MK_COLON, MK_FEATURE, MK_FEATURE_EXPRESSION, MK_KEYWORD, MK_QUERY, MK_QUERY_LIST, MK_TYPE, MK_UNKNOWN, MK_URL, MK_VALUE, mediaTree } from "./media_query.ts";
import { Memo } from "./memo.ts";
import {
  isWsB,
  adjustNumbers,
  adjustStrings,
  appendLower,
  countByte,
  endsBeforeEscapedBlank,
  endsWithLit,
  eqLit,
  eqLitIgnoreCase,
  indexOfAny2,
  indexOfByteIn,
  indexOfLit,
  isAsciiAlphabetic,
  isAsciiDigit,
  isRegexpWordByte,
  lastLineHasInlineComment,
  lowerByte,
  maybeToLowerCase,
  printCssNumber,
  printString,
  quoteAttributeValue,
  startsWithLit,
  toLowerCase,
  cssUnitIndex,
  unitBytes,
  unitStart,
  unitEnd,
} from "./misc.ts";
import {
  CssNode,
  Context,
  PAR_MEDIA,
  PAR_NONE,
  PAR_TEXT,
  PAR_UNKNOWN,
  PAR_VALUE,
  Parsed,
  VAL_NONE,
  VAL_PARSED,
  VAL_RULE,
  VAL_TEXT,
} from "./parse.ts";
import {
  F_END,
  F_FIRST_CHILD,
  F_HAS_BLOCK,
  F_INLINE,
  F_KIND,
  F_NAME_E,
  F_NAME_S,
  F_NEXT_SIBLING,
  F_RAW_INLINE,
  F_BEFORE_E,
  F_BEFORE_S,
  F_TEXT_E,
  F_TEXT_S,
  F_PROP_E,
  F_PROP_S,
  F_VALUE_E,
  F_VALUE_S,
  F_CLEAN_VALUE_S,
  F_IS_NESTED,
  F_BETWEEN_E,
  F_BETWEEN_S,
  F_RAW_IMPORTANT_E,
  F_RAW_IMPORTANT_S,
  F_START,
  F_MIXIN,
  F_FUNCTION,
  K_AT_RULE,
  K_COMMENT,
  K_DECL,
  K_ROOT,
  K_RULE,
  NS,
  Tree,
} from "./postcss.ts";
import {
  NS_EMPTY,
  NS_NAME,
  SK_ATTRIBUTE,
  SK_CLASS,
  SK_COMBINATOR,
  SK_COMMENT,
  SK_ID,
  SK_NESTING,
  SK_PSEUDO,
  SK_ROOT,
  SK_SELECTOR,
  SK_STRING,
  SK_TAG,
  SK_UNIVERSAL,
  SK_UNKNOWN,
} from "./selector_parser.ts";
import { Sink } from "./sink.ts";
import { SYNTAX_CSS, SYNTAX_LESS, SYNTAX_SCSS } from "./syntax.ts";
import { tailwindFollowsPlugin, tailwindIsActive, tailwindSortedToApply } from "./tailwind_hook.ts";
import {
  BEFORE_EMPTY,
  VK_AT_WORD,
  VK_COLON,
  VK_COMMA,
  VK_COMMA_GROUP,
  VK_COMMENT,
  VK_FUNC,
  VK_NUMBER,
  VK_OPERATOR,
  VK_PAREN,
  VK_PAREN_GROUP,
  VK_ROOT,
  VK_SELECTOR,
  VK_STRING,
  VK_TEXT,
  VK_UNICODE_RANGE,
  VK_UNKNOWN,
  VK_VALUE,
  VK_WORD,
  isAtWordPlaceholder,
  isListWithCommaGroup,
  topLevelGroup,
} from "./value_parser.ts";
import { printCommaSeparatedValueGroup, printParenthesizedValueGroup } from "./value_groups.ts";

/** `text::starts_with_white_space(&[b])` */
function isWsByte(b: number): boolean {
  return b === 32 || (b >= 9 && b <= 13);
}

/** Whether the first of the selectors `selector[s, e)` has what is in the place of a `${}` of JavaScript in it. */
function hasPlaceholderInFirstSelector(sel: Uint8Array, s: number, e: number): boolean {
  const at = indexOfLit(sel, s, e, "@prettier-placeholder-");
  if (at < 0) return false;
  let depth = 0;
  let quote = 0;
  for (let i = s; i < at; i++) {
    const byte = sel[i] | 0;
    if (quote !== 0) {
      if (byte === quote) quote = 0;
    } else if (byte === 34 || byte === 39) {
      quote = byte;
    } else if (byte === 40 || byte === 91) {
      depth = depth + 1;
    } else if (byte === 41 || byte === 93) {
      depth = depth > 0 ? depth - 1 : 0;
    } else if (byte === 44 && depth === 0) {
      return false;
    }
  }
  return true;
}

/** Whether oxfmt leaves `value`, of a custom property, as it is: there is something in it that is no value in the language,
 * as in `--a: [{"b":1}]`, `--a: b:c` and `--a: 1px !b`. Prettier takes it for values all the same. Only what is on one line. */
function isMoreThanValues(value: Uint8Array, s: number, e: number, syntax: number): boolean {
  // How many `(` are open.
  let depth = 0;
  let at = s;
  while (at < e) {
    const byte = value[at] | 0;
    const next = at + 1 < e ? value[at + 1] | 0 : -1;
    if (byte === 10) {
      return false;
    } else if (byte === 34 || byte === 39) {
      at = at + 1;
      while (at < e && (value[at] | 0) !== byte) {
        at = at + 1 + ((value[at] | 0) === 92 ? 1 : 0);
      }
    } else if (byte === 35 && syntax === SYNTAX_SCSS && next === 123) {
      const f = indexOfByteIn(value, at, e, 125);
      at = at + (f < 0 ? 0 : f - at);
    } else if (byte === 58 || byte === 123 || byte === 125 || byte === 33) {
      break;
    } else if ((byte === 60 || byte === 62) && syntax === SYNTAX_CSS) {
      break;
    } else if (byte === 64 && startsWithLit(value, at, e, "@prettier-placeholder-")) {
      // What stands for a `${}` in a template of JavaScript is a value.
    } else if (byte === 64 && (syntax !== SYNTAX_LESS || next === 123)) {
      break;
    } else if (byte === 40 && at - s >= 3 && eqLitIgnoreCase(value, at - 3, at, "url")) {
      const f = indexOfByteIn(value, at, e, 41);
      at = at + (f < 0 ? 0 : f - at);
    } else if (byte === 40 && syntax !== SYNTAX_SCSS && depth === 0 && !(at > s && isNamePartByte(value[at - 1] | 0))) {
      // In the parentheses of a function there can be others.
      break;
    } else if (byte === 40) {
      depth = depth + 1;
    } else if (byte === 41) {
      depth = depth > 0 ? depth - 1 : 0;
    }
    at = at + 1;
  }
  return at < e && !containsLf(value, at, e);
}

function isNamePartByte(b: number): boolean {
  return isRegexpWordByte(b) || b === 45 || b >= 0x80;
}

function containsLf(text: Uint8Array, s: number, e: number): boolean {
  for (let i = s; i < e; i++) {
    if ((text[i] | 0) === 10) return true;
  }
  return false;
}

/** Whether `text`, which is in parentheses, is more than a name and a value: `(width>=1px)`, `((color) or (hover))`. Not what
 * starts with a variable or an interpolation, which oxfmt does not read either. The `(` of a function does not count. */
function isRangeOrCondition(text: Uint8Array, s: number, e: number): boolean {
  const inner = s + 1 < e ? s + 1 : e;
  const first = trimJsWhitespaceStart(text, inner, e);
  if (first < e) {
    const c = text[first] | 0;
    if (c === 36 || c === 64 || c === 35) return false;
  }
  let from = inner;
  while (from < e) {
    let at = -1;
    for (let i = from; i < e; i++) {
      const c = text[i] | 0;
      if (c === 60 || c === 62 || c === 61 || c === 40) { at = i; break; }
    }
    if (at < 0) return false;
    const isCall = (text[at] | 0) === 40 && at > inner && !isWsB(text[at - 1] | 0) && (text[at - 1] | 0) !== 40;
    if (!isCall) return true;
    from = at + 1;
  }
  return false;
}

/** For oxfmt there is a blank on both sides of `<`, `>`, `=`, `<=` and `>=` in a media query, one behind a `:`, and none behind
 * a `(` or before a `)`. Prettier knows a name, a `:` and a value, and leaves the rest as it is. Appends to `out`. */
function withBlanksInMediaFeature(text: Uint8Array, s: number, e: number, out: ByteBuf): void {
  const start = out.len;
  const last = (): number => (out.len > start ? out.data[out.len - 1] | 0 : -1);
  let at = s;
  while (at < e) {
    const byte = text[at] | 0;
    let len = 1;
    if (byte === 34 || byte === 39) {
      while (at + len < e && (text[at + len] | 0) !== byte) len = len + 1 + ((text[at + len] | 0) === 92 ? 1 : 0);
      len = len + 1 < e - at ? len + 1 : e - at;
      out.append(text, at, at + len);
    } else if (isWsB(byte)) {
      const l = last();
      if (!(l < 0 || l === 40 || l === 32)) out.push(32);
    } else if (byte === 41) {
      if (last() === 32) out.len = out.len - 1;
      out.push(byte);
    } else if (byte === 60 || byte === 62 || byte === 61) {
      len = 0;
      while (at + len < e) {
        const c = text[at + len] | 0;
        if (c === 60 || c === 62 || c === 61) len = len + 1;
        else break;
      }
      const l = last();
      if (!(l < 0 || l === 40 || l === 32)) out.push(32);
      out.append(text, at, at + len);
      out.push(32);
    } else if (byte === 58) {
      if (last() === 32) out.len = out.len - 1;
      out.push(58);
      out.push(32);
    } else {
      out.push(byte);
    }
    at = at + len;
  }
}

/** `f($a)-1` in a media query of SCSS is `f($a) - 1` for oxfmt, as it is in a value. Prettier leaves it as it is.
 *
 * - `*` always has blanks around it.
 * - `+` and `-` have if there is none before them and a variable, a name or a function is next to them: not `1+2`. A `-`
 *   behind anything but a `)` is a part of a name, and so is one before a letter.
 * Appends to `out`; false: there is nothing to do (nothing is written). */
function withBlanksAroundOperators(value: Uint8Array, s: number, e: number, out: ByteBuf): boolean {
  let any = false;
  for (let i = s; i < e; i++) {
    const c = value[i] | 0;
    if (c === 43 || c === 45 || c === 42) { any = true; break; }
  }
  if (!any) return false;
  const isBlank = (b: number): boolean => b >= 0 && isWsB(b);
  const startsName = (b: number): boolean => b === 36 || isAsciiAlphabetic(b);
  let quote = 0;
  for (let at = s; at < e; at++) {
    const byte = value[at] | 0;
    if (quote !== 0 || byte === 34 || byte === 39) {
      quote = quote === 0 ? byte : byte === quote ? 0 : quote;
      out.push(byte);
      continue;
    }
    const previous = at > s ? value[at - 1] | 0 : -1;
    const next = at + 1 < e ? value[at + 1] | 0 : -1;
    let isOperator = false;
    if (byte === 42 && previous >= 0 && next >= 0) {
      isOperator = true;
    } else if (byte === 43 && previous === 41 && next >= 0) {
      isOperator = true;
    } else if (byte === 45 && previous === 41 && next >= 0) {
      isOperator = isAsciiDigit(next) || next === 36 || next === 40 || next === 46 || next === 32;
    } else if (byte === 43 && previous >= 0 && next >= 0 && !isWsB(previous)) {
      let wordLen = 0;
      let i = at - 1;
      while (i >= s) {
        const c = value[i] | 0;
        if (isAsciiAlphabetic(c) || isAsciiDigit(c) || c === 36 || c === 95 || c === 45 || c === 46 || c === 37) {
          wordLen = wordLen + 1;
          i = i - 1;
        } else {
          break;
        }
      }
      isOperator = startsName(next) || (wordLen > 0 && startsName(value[at - wordLen] | 0));
    }
    if (isOperator && !isBlank(previous)) out.push(32);
    out.push(byte);
    if (isOperator && !isBlank(next)) out.push(32);
  }
  return true;
}

/** The index of the first `!` in text[from, e) followed by `word` (ignoring case; after white space if `allowsSpace`):
 * normalizes it as `normalize_bang` does, appending to `out`; false if there is none. */
function normalizeBang(text: Uint8Array, s: number, e: number, word: string, allowsSpace: boolean, out: ByteBuf): void {
  let from = s;
  while (true) {
    const bang = indexOfByteIn(text, from, e, 33);
    if (bang < 0) break;
    let after = bang + 1;
    if (allowsSpace) after = trimJsWhitespaceStart(text, after, e);
    if (e - after >= word.length) {
      let ok = true;
      for (let k = 0; k < word.length; k++) {
        if (lowerByte(text[after + k] | 0) !== word.charCodeAt(k)) { ok = false; break; }
      }
      if (ok) {
        const te = trimJsWhitespaceEnd(text, s, bang);
        out.append(text, s, te);
        out.push(32);
        out.push(33);
        for (let k = 0; k < word.length; k++) out.push(word.charCodeAt(k));
        out.append(text, after + word.length, e);
        return;
      }
    }
    from = bang + 1;
  }
  out.append(text, s, e);
}

export class Printer {
  ctx: Context;
  parsed: Parsed;
  singleQuote: boolean;
  /** `trailingComma` is `"es5"` or `"all"`. */
  trailingComma: boolean;
  /** Nothing depends on it, but for what is kept of one flavor not to be taken for the other if that changes. */
  isOxfmt: boolean;
  /** Prettier's `__isHTMLStyleAttribute`: the declarations are on one line if they fit. It is not in the key of the memo: the
   * sink has to be `Sink::to_document()`, for which nothing is kept. */
  isHtmlStyleAttribute: boolean;
  /** oxfmt's `sortTailwindcss`, for the classes behind `@apply`: a handle, -1 is none. */
  tailwind: number;
  /** The nodes of the value that what is being printed is in. */
  valueStack: Int32Array;
  nValueStack: number;
  /** Not 0: the comment at the start of what follows a comma that has been written behind the comma. */
  commentBehindComma: number;
  /** Which of a `value-comma_group` is being written. */
  indexInCommaGroup: number;
  /** An item of a list, and how many of the comments that it starts with have been written before it. */
  commentsAboveItem: number;
  commentsAboveCount: number;
  /** For a text that is made to be written. */
  scratch: ByteBuf;
  scratch2: ByteBuf;
  scratch3: ByteBuf;
  /** Prettier throws an error for the style sheet. */
  failed: boolean;
  failMessage: number;
  failOffset: number;
  sink: Sink;
  memo: Memo;
  /** What has been printed of the declaration depends on nothing but its text and what `memo_context` takes into account. */
  isMemoizable: boolean;
  // scopes, by depth
  nodes: CssNode[];
  scopeTree: Tree[];
  scopeAtRule: (CssNode | null)[];
  /** Whether `nodes[sd + 1]` holds the converted node of the unit that is being written. */
  cacheValid: boolean;
  // out of `memoText`
  mtE: number;
  // The style sheet's tree
  rootTree: Tree;

  constructor(ctx: Context, parsed: Parsed, sink: Sink, memo: Memo, rootTree: Tree) {
    this.ctx = ctx;
    this.parsed = parsed;
    this.singleQuote = false;
    this.trailingComma = true;
    this.isOxfmt = false;
    this.isHtmlStyleAttribute = false;
    this.tailwind = -1;
    this.valueStack = new Int32Array(64);
    this.nValueStack = 0;
    this.commentBehindComma = 0;
    this.indexInCommaGroup = 0;
    this.commentsAboveItem = 0;
    this.commentsAboveCount = 0;
    this.scratch = new ByteBuf(256);
    this.scratch2 = new ByteBuf(256);
    this.scratch3 = new ByteBuf(256);
    this.failed = false;
    this.failMessage = 0;
    this.failOffset = 0;
    this.sink = sink;
    this.memo = memo;
    this.isMemoizable = false;
    this.nodes = [];
    this.scopeTree = [];
    this.scopeAtRule = [];
    this.cacheValid = false;
    this.mtE = 0;
    this.rootTree = rootTree;
  }

  syntax(): number {
    return this.ctx.syntax;
  }

  /** The node object of depth `sd`. */
  nodeAt(sd: number): CssNode {
    while (this.nodes.length <= sd) {
      this.nodes.push(new CssNode());
      this.scopeTree.push(this.rootTree);
      this.scopeAtRule.push(null);
    }
    return this.nodes[sd];
  }

  // ───────────────────────────── statements ─────────────────────────────

  /** `Statement::new`: the at-rule that the node of `sd` is or is in. */
  private enterScope(sd: number): void {
    const node = this.nodes[sd];
    this.scopeAtRule[sd] = node.kind === K_AT_RULE ? node : sd > 0 ? this.scopeAtRule[sd - 1] : null;
  }

  /** `path.findAncestor((node) => node.type === kind)`, for what is in a selector, a value or parameters: the node of the style
   * sheet that it belongs to counts. */
  cssAncestor(sd: number, kind: number): CssNode | null {
    for (let d = sd; d >= 0; d--) {
      if (this.nodes[d].kind === kind) return this.nodes[d];
    }
    return null;
  }

  /** `insideAtRuleNode`, with up to three names (lower case) */
  insideAtRule(sd: number, a: string, b: string, c: string): boolean {
    const node = this.scopeAtRule[sd];
    if (node === null) return false;
    const d = this.ctx.buf.data;
    return (
      eqLitIgnoreCase(d, node.nameS, node.nameE, a) ||
      (b.length > 0 && eqLitIgnoreCase(d, node.nameS, node.nameE, b)) ||
      (c.length > 0 && eqLitIgnoreCase(d, node.nameS, node.nameE, c))
    );
  }

  isInKeyframes(sd: number): boolean {
    const node = this.scopeAtRule[sd];
    if (node === null) return false;
    const d = this.ctx.buf.data;
    // `name.to_ascii_lowercase().ends_with("keyframes")`
    const n = node.nameE - node.nameS;
    if (n < 9) return false;
    const word = "keyframes";
    for (let i = 0; i < 9; i++) {
      if (lowerByte(d[node.nameE - 9 + i] | 0) !== word.charCodeAt(i)) return false;
    }
    return true;
  }

  /** `insideIcssRuleNode`, for a declaration. */
  private insideIcssRule(sd: number): boolean {
    const d = this.ctx.buf.data;
    for (let k = sd; k >= 0; k--) {
      const node = this.nodes[k];
      if (node.kind === K_RULE && (startsWithLit(d, node.rawSelectorS, node.rawSelectorE, ":import") || startsWithLit(d, node.rawSelectorS, node.rawSelectorE, ":export"))) {
        return true;
      }
    }
    return false;
  }

  // ───────────────────────────── the style sheet ─────────────────────────────

  /** The style sheet is refused. The first reason is the one that is given. */
  fail(message: number, offset: number): void {
    if (!this.failed) {
      this.failed = true;
      this.failMessage = message;
      this.failOffset = offset;
    }
  }

  private failFromRefusal(): void {
    this.fail(refusalMessage(), refusalOffset());
  }

  printRoot(tree: Tree, parsed: Parsed): void {
    const root = this.nodeAt(0);
    this.scopeTree[0] = tree;
    if (this.ctx.convert(tree, 0, parsed, root) < 0) {
      this.failFromRefusal();
      return;
    }
    this.enterScope(0);
    const d = this.ctx.buf.data;
    let as = trimJsWhitespaceStart(d, root.afterS, root.afterE);
    let ae = trimJsWhitespaceEnd(d, as, root.afterE);
    if (ae > as && (d[as] | 0) === 59) {
      as = trimJsWhitespaceStart(d, as + 1, ae);
      ae = trimJsWhitespaceEnd(d, as, ae);
    }
    this.printSequence(0, 0, as, ae, parsed);
    if ((tree.f[F_FIRST_CHILD] | 0) !== 0) this.sink.hardLine();
  }

  /** Whether no block is printed for the node `id` of `tree`. */
  private hasNoBlock(tree: Tree, id: number): boolean {
    const f = tree.f;
    const o = id * NS;
    switch (f[o + F_KIND] | 0) {
      case K_ROOT:
      case K_RULE:
        return false;
      case K_COMMENT:
        return true;
      case K_DECL: {
        // A custom property set looks like a declaration.
        if ((f[o + F_HAS_BLOCK] | 0) !== 0) return false;
        const d = this.ctx.buf.data;
        return !(startsWithLit(d, f[o + F_PROP_S] | 0, f[o + F_PROP_E] | 0, "--") && (f[o + F_VALUE_E] | 0) > (f[o + F_VALUE_S] | 0) && (d[f[o + F_VALUE_S] | 0] | 0) === 123);
      }
      default:
        return (f[o + F_HAS_BLOCK] | 0) === 0 || (this.ctx.syntax === SYNTAX_LESS && ((f[o + F_MIXIN] | 0) !== 0 || (f[o + F_FUNCTION] | 0) !== 0));
    }
  }

  /** `Memo::context` for the declarations in the block of `sd`. -1: nothing is kept of them. */
  private memoContext(sd: number): number {
    const parent = this.nodes[sd];
    if (parent.valueKind === VAL_RULE || !this.ctx.isOriginalText) return -1;
    const syntax = this.ctx.syntax;
    const rule = this.cssAncestor(sd, K_RULE);
    const atRule = this.scopeAtRule[sd];
    // the nine flags, first first
    let flags = 0;
    flags = (flags << 1) | (syntax === SYNTAX_LESS ? 1 : 0);
    flags = (flags << 1) | (syntax === SYNTAX_SCSS ? 1 : 0);
    flags = (flags << 1) | (this.singleQuote ? 1 : 0);
    flags = (flags << 1) | (this.trailingComma ? 1 : 0);
    flags = (flags << 1) | (this.isOxfmt ? 1 : 0);
    flags = (flags << 1) | (this.insideIcssRule(sd) ? 1 : 0);
    flags = (flags << 1) | (parent.kind === K_AT_RULE && parent.variable ? 1 : 0);
    flags = (flags << 1) | (rule !== null && rule.isScssNestedProperty ? 1 : 0);
    flags = (flags << 1) | (atRule !== null ? 1 : 0);
    if (atRule === null) return this.memo.context(flags, this.ctx.buf.data, 0, 0);
    return this.memo.context(flags, this.ctx.buf.data, atRule.nameS, atRule.nameE);
  }

  /** The text of the declaration `id`, if it has all that `postcss` says of it: returns the start (in `buf`), the end is
   * `mtE`; -1 if it has not. */
  private memoText(tree: Tree, id: number): number {
    const f = tree.f;
    const o = id * NS;
    const d = this.ctx.buf.data;
    if ((f[o + F_KIND] | 0) !== K_DECL || (f[o + F_IS_NESTED] | 0) !== 0 || (f[o + F_CLEAN_VALUE_S] | 0) >= 0 || !this.hasNoBlock(tree, id)) return -1;
    const bs = f[o + F_BEFORE_S] | 0;
    const be = f[o + F_BEFORE_E] | 0;
    for (let i = bs; i < be; i++) {
      if (!isWsB(d[i] | 0)) return -1;
    }
    const end0 = f[o + F_END] | 0;
    if (end0 < 0) return -1;
    const start = f[o + F_START] | 0;
    // Everything that it is made of is in the text, from where it starts on.
    let end = end0;
    let inOrder = true;
    const ps0 = f[o + F_PROP_S] | 0;
    const pe0 = f[o + F_PROP_E] | 0;
    const bs0 = f[o + F_BETWEEN_S] | 0;
    const be0 = f[o + F_BETWEEN_E] | 0;
    const vs0 = f[o + F_VALUE_S] | 0;
    const ve0 = f[o + F_VALUE_E] | 0;
    if (pe0 > end) end = pe0;
    if (be0 > end) end = be0;
    if (ve0 > end) end = ve0;
    if (ps0 < pe0 && ps0 < start) inOrder = false;
    if (bs0 < be0 && bs0 < start) inOrder = false;
    if (vs0 < ve0 && vs0 < start) inOrder = false;
    const ris = f[o + F_RAW_IMPORTANT_S] | 0;
    if (ris >= 0) {
      const rie = f[o + F_RAW_IMPORTANT_E] | 0;
      if (rie > end) end = rie;
      if (ris < rie && ris < start) inOrder = false;
    }
    if (!inOrder || start > end || end > this.ctx.cssLen) return -1;
    this.mtE = end;
    return start;
  }

  /** `printSequence` for the nodes of `block` (a node of the tree of `sd`), which `sd` is for, and `after` behind a blank unless
   * it is empty. */
  private printSequence(sd: number, block: number, afterS: number, afterE: number, parsed: Parsed): void {
    const text = this.ctx.originalText;
    const textLen = this.ctx.originalLen;
    const tree = this.scopeTree[sd];
    const memoContext = this.memoContext(sd);
    let previous = -1;
    let first = tree.f[block * NS + F_FIRST_CHILD] | 0;
    const sink = this.sink;
    if (first === 0 && afterE > afterS) {
      sink.token(" ");
      sink.text(this.ctx.buf.data, afterS, afterE);
    }
    while (first !== 0) {
      let f = tree.f;
      // The nodes from `first` up to `end` are on one line.
      let last = first;
      while (true) {
        const next = f[last * NS + F_NEXT_SIBLING] | 0;
        if (next === 0) break;
        const nk = f[next * NS + F_KIND] | 0;
        let take = false;
        if (nk === K_COMMENT) {
          const st = f[next * NS + F_START] | 0;
          take = !hasNewlineBackwards(text, st < textLen ? st : textLen);
        } else if (nk === K_AT_RULE && (f[last * NS + F_KIND] | 0) !== K_COMMENT) {
          const ns = this.ctx.nameOfAtRule(tree, next);
          take = eqLit(this.ctx.buf.data, ns, this.ctx.cE, "else");
        }
        if (!take) break;
        last = next;
      }
      const end = f[last * NS + F_NEXT_SIBLING] | 0;

      // What has a block takes care of the line that its `{` ends. Everything else goes with the rest of the line.
      let id = first;
      while (id !== end && ((f[id * NS + F_KIND] | 0) === K_COMMENT || !this.hasNoBlock(tree, id))) {
        if (id !== first) sink.token(" ");
        this.printInSequence(sd, id, previous, -1, false, parsed);
        previous = id;
        f = tree.f;
        id = f[id * NS + F_NEXT_SIBLING] | 0;
      }
      if (id === end) {
        if (end === 0 && afterE > afterS) {
          sink.token(" ");
          sink.text(this.ctx.buf.data, afterS, afterE);
        }
      } else {
        // What has been parsed of it is still there when it is written again, if nothing else is parsed.
        let isOnlyOneParsed = true;
        let s = f[id * NS + F_NEXT_SIBLING] | 0;
        while (s !== end) {
          const o = s * NS;
          if ((f[o + F_KIND] | 0) !== K_COMMENT || (f[o + F_INLINE] | 0) !== 0 || (f[o + F_END] | 0) < 0) {
            isOnlyOneParsed = false;
            break;
          }
          s = f[o + F_NEXT_SIBLING] | 0;
        }
        const rawEnd = f[id * NS + F_END] | 0;
        const rawStart = f[id * NS + F_START] | 0;
        const isTooLong = rawEnd >= 0 && !sink.hasRoomFor(rawEnd - (rawStart < rawEnd ? rawStart : rawEnd));
        this.cacheValid = false;
        const marked = sink.startUnit();
        if (!(isTooLong && marked)) this.writeUnit(sd, tree, id, end, first, previous, afterS, afterE, memoContext, isOnlyOneParsed, parsed);
        if (marked && (isTooLong || !sink.endUnit())) {
          sink.startDocument();
          this.writeUnit(sd, tree, id, end, first, previous, afterS, afterE, memoContext, isOnlyOneParsed, parsed);
          if (this.ctx.stack.ranOut()) sink.fail(FORMAT_NESTED_TOO_DEEPLY);
          sink.endDocument();
        }
      }
      previous = last;
      if (end !== 0) {
        if (this.isHtmlStyleAttribute) sink.line();
        else sink.hardLine();
        f = tree.f;
        let lastEnd: number;
        const le = f[last * NS + F_END] | 0;
        if (le >= 0 && (f[last * NS + F_INLINE] | 0) === 0) {
          lastEnd = le < textLen ? le : textLen;
        } else {
          let c = first;
          while ((f[c * NS + F_NEXT_SIBLING] | 0) !== end) c = f[c * NS + F_NEXT_SIBLING] | 0;
          lastEnd = this.ctx.endOf(tree, c, parsed);
        }
        if (isNextLineEmpty(text, lastEnd)) sink.hardLine();
      }
      first = end;
    }
  }

  /** The body of the `unit` of `printSequence`. */
  private writeUnit(
    sd: number,
    tree: Tree,
    firstOfUnit: number,
    end: number,
    first: number,
    previous0: number,
    afterS: number,
    afterE: number,
    memoContext: number,
    isOnlyOneParsed: boolean,
    parsed: Parsed,
  ): void {
    const sink = this.sink;
    let id = firstOfUnit;
    let previous = previous0;
    while (id !== end) {
      const f = tree.f;
      const o = id * NS;
      const nextSibling = f[o + F_NEXT_SIBLING] | 0;
      // oxfmt does not count a `//` comment at the end of the line when it asks what fits.
      const isLineSuffix =
        this.isOxfmt && id !== first && (f[o + F_KIND] | 0) === K_COMMENT && ((f[o + F_INLINE] | 0) !== 0 || (f[o + F_RAW_INLINE] | 0) !== 0) && nextSibling === end;
      if (isLineSuffix) sink.startLineSuffix();
      if (id !== first) sink.token(" ");
      this.printInSequence(sd, id, previous, memoContext, isOnlyOneParsed, parsed);
      if (isLineSuffix) sink.endLineSuffix();
      previous = id;
      id = nextSibling;
    }
    if (end === 0 && afterE > afterS) {
      sink.token(" ");
      sink.text(this.ctx.buf.data, afterS, afterE);
    }
  }

  /** Prints the node `id`, which is in the block of the scope `sd` behind `previous`. `useCache`: the node that is made of it
   * is kept in `nodes[sd + 1]` for the next time (`cacheValid`). */
  private printInSequence(sd: number, id: number, previous: number, memoContext: number, useCache: boolean, parsed: Parsed): void {
    const ctx = this.ctx;
    if (!ctx.stack.enter()) return;
    this.printInSequenceInner(sd, id, previous, memoContext, useCache, parsed);
    ctx.stack.leave();
  }

  private printInSequenceInner(sd: number, id: number, previous: number, memoContext: number, useCache: boolean, parsed: Parsed): void {
    const ctx = this.ctx;
    const sink = this.sink;
    const text = ctx.originalText;
    const textLen = ctx.originalLen;
    const tree = this.scopeTree[sd];
    const f = tree.f;
    const o = id * NS;
    const rawStart = f[o + F_START] | 0;
    const start = rawStart < textLen ? rawStart : textLen;
    const kind = f[o + F_KIND] | 0;
    if (previous >= 0 && (f[previous * NS + F_KIND] | 0) === K_COMMENT) {
      const d = ctx.buf.data;
      const ts = trimJsWhitespaceStart(d, f[previous * NS + F_TEXT_S] | 0, f[previous * NS + F_TEXT_E] | 0);
      const te = trimJsWhitespaceEnd(d, ts, f[previous * NS + F_TEXT_E] | 0);
      if (eqLit(d, ts, te, "prettier-ignore") || (this.isOxfmt && eqLit(d, ts, te, "oxfmt-ignore"))) {
        const end = ctx.endOf(tree, id, parsed);
        if (end > start) sink.text(text, start, end);
        return;
      }
    }
    if (kind === K_COMMENT) {
      const end = ctx.endOf(tree, id, parsed);
      let ce = end > start ? end : start;
      if ((f[o + F_INLINE] | 0) !== 0 || (f[o + F_RAW_INLINE] | 0) !== 0) ce = trimJsWhitespaceEnd(text, start, ce);
      sink.text(text, start, ce);
      return;
    }
    let ms = -1;
    let me = 0;
    let posLen = -1;
    let posBreaks = 0;
    if (memoContext >= 0) {
      ms = this.memoText(tree, id);
      if (ms >= 0) {
        me = this.mtE;
        posLen = sink.position();
        posBreaks = sink.lineBreaks;
      }
    }
    const hasPosition = memoContext >= 0 && ms >= 0 && posLen >= 0;
    if (hasPosition && this.memo.get(memoContext, ctx.buf.data, ms, me)) {
      sink.writeAgain(this.memo.bytes, this.memo.outStart, this.memo.outEnd, this.memo.hasGroup);
      return;
    }

    const node = this.nodeAt(sd + 1);
    if (!(useCache && this.cacheValid)) {
      this.scopeTree[sd + 1] = tree;
      if (ctx.convert(tree, id, parsed, node) < 0) {
        this.failFromRefusal();
        return;
      }
      if (useCache) this.cacheValid = true;
    }
    this.scopeTree[sd + 1] = tree;
    this.enterScope(sd + 1);
    this.isMemoizable = true;
    switch (node.kind) {
      case K_RULE:
        this.printRule(sd + 1, id, parsed);
        break;
      case K_DECL:
        this.printDeclaration(sd + 1, id, parsed);
        break;
      case K_AT_RULE:
        this.printAtRule(sd + 1, id, parsed);
        break;
      default:
        break;
    }
    if (hasPosition && this.isMemoizable && !this.failed) {
      const from = sink.writtenSince(posLen, posBreaks);
      if (from >= 0) {
        this.memo.insert(memoContext, ctx.buf.data, ms, me, sink.out.data, from, sink.out.len, sink.hasGroupInLine);
      }
    }
  }

  /** What is in `block`, each on a line of its own, and `}`. The `{` has been written. */
  private printBlock(sd: number, block: number, isHardLine: boolean, parsed: Parsed): void {
    const sink = this.sink;
    const tree = this.scopeTree[sd];
    if ((tree.f[block * NS + F_FIRST_CHILD] | 0) !== 0) {
      sink.startIndent();
      if (isHardLine) sink.hardLine();
      else sink.softLine();
      this.printSequence(sd, block, 0, 0, parsed);
      sink.endIndent();
    }
    if (isHardLine) sink.hardLine();
    else sink.softLine();
    sink.token("}");
  }

  private printRule(sd: number, rawId: number, parsed: Parsed): void {
    const node = this.nodes[sd];
    const sink = this.sink;
    const selectors = parsed.selectors;
    const unknownSelector = node.selector !== 0 && (selectors.kind[node.selector] | 0) === SK_UNKNOWN ? node.selector : 0;
    // `isDetachedRulesetDeclarationNode`: `/^@.+:.*$/`
    let isDetachedRuleset = false;
    if (unknownSelector !== 0) {
      const sdata = selectors.text.data;
      const vs = selectors.vs[unknownSelector] | 0;
      const ve = selectors.ve[unknownSelector] | 0;
      isDetachedRuleset = ve > vs && (sdata[vs] | 0) === 64 && indexOfAny2(sdata, vs, ve, 10, 13) < 0 && indexOfByteIn(sdata, vs + 2, ve, 58) >= 0;
    }
    const marked = sink.startUnit();
    this.writeRuleHead(sd, unknownSelector, parsed);
    if (marked && !sink.endUnit()) {
      sink.startDocument();
      this.writeRuleHead(sd, unknownSelector, parsed);
      if (this.ctx.stack.ranOut()) sink.fail(FORMAT_NESTED_TOO_DEEPLY);
      sink.endDocument();
    }
    this.printBlock(sd, rawId, true, parsed);
    if (isDetachedRuleset) sink.token(";");
  }

  private writeRuleHead(sd: number, unknownSelector: number, parsed: Parsed): void {
    const node = this.nodes[sd];
    const sink = this.sink;
    const d = this.ctx.buf.data;
    if (this.isOxfmt && hasPlaceholderInFirstSelector(d, node.rawSelectorS, node.rawSelectorE)) {
      this.printLinesOfSelector(d, node.rawSelectorS, node.rawSelectorE);
    } else if (node.selector !== 0) {
      this.printSelector(sd, node.selector, 0, 0);
    }
    if (node.important) sink.token(" !important");
    if (unknownSelector !== 0 && lastLineHasInlineComment(parsed.selectors.text.data, parsed.selectors.vs[unknownSelector] | 0, parsed.selectors.ve[unknownSelector] | 0)) {
      sink.line();
    } else if (node.selector !== 0) {
      sink.token(" ");
    }
    sink.token("{");
  }

  /** What oxfmt does with selectors in JavaScript from the first that has a `${}` in it: the lines stay, each with one blank
   * where it has blanks, and none is indented. */
  private printLinesOfSelector(sel: Uint8Array, s: number, e: number): void {
    const sink = this.sink;
    let isFirst = true;
    let lineStart = s;
    while (lineStart <= e) {
      let lineEnd = indexOfByteIn(sel, lineStart, e, 10);
      if (lineEnd < 0) lineEnd = e;
      // the words of the line: split by " \t\r\x0C", nonempty
      let wordCount = 0;
      let i = lineStart;
      while (i < lineEnd) {
        while (i < lineEnd && isSelSpace(sel[i] | 0)) i = i + 1;
        if (i >= lineEnd) break;
        wordCount = wordCount + 1;
        while (i < lineEnd && !isSelSpace(sel[i] | 0)) i = i + 1;
      }
      if (wordCount > 0) {
        if (!isFirst) sink.hardLine();
        isFirst = false;
        let index = 0;
        i = lineStart;
        while (i < lineEnd) {
          while (i < lineEnd && isSelSpace(sel[i] | 0)) i = i + 1;
          if (i >= lineEnd) break;
          const ws = i;
          while (i < lineEnd && !isSelSpace(sel[i] | 0)) i = i + 1;
          if (index > 0) sink.token(" ");
          sink.text(sel, ws, i);
          index = index + 1;
        }
      }
      if (lineEnd >= e) break;
      lineStart = lineEnd + 1;
    }
  }

  private printDeclaration(sd: number, rawId: number, parsed: Parsed): void {
    const node = this.nodes[sd];
    const sink = this.sink;
    if (node.valueKind === VAL_RULE) {
      // The lines of the block are written as they come.
      const marked = sink.startUnit();
      this.writeBlockDeclaration(sd, rawId, parsed);
      if (marked && !sink.endUnit()) {
        sink.startDocument();
        this.writeBlockDeclaration(sd, rawId, parsed);
        if (this.ctx.stack.ranOut()) sink.fail(FORMAT_NESTED_TOO_DEEPLY);
        sink.endDocument();
      }
      return;
    }
    if (!node.hasBlock) {
      this.writeDeclaration(sd, rawId, parsed);
    } else {
      const marked = sink.startUnit();
      this.writeDeclaration(sd, rawId, parsed);
      if (marked && !sink.endUnit()) {
        sink.startDocument();
        this.writeDeclaration(sd, rawId, parsed);
        if (this.ctx.stack.ranOut()) sink.fail(FORMAT_NESTED_TOO_DEEPLY);
        sink.endDocument();
      }
      this.printBlock(sd, rawId, false, parsed);
    }
  }

  private writeBlockDeclaration(sd: number, rawId: number, parsed: Parsed): void {
    const node = this.nodes[sd];
    const sink = this.sink;
    const tree = node.valueTree as Tree;
    const isOnItsOwnLine = this.printNameAndExtend(sd, true, parsed);
    sink.token("{");
    const outer = this.scopeTree[sd];
    this.scopeTree[sd] = tree;
    const only = tree.f[F_FIRST_CHILD] | 0;
    this.printBlock(sd, only, true, parsed);
    if (isOnItsOwnLine) {
      sink.endIndent();
      sink.endIndent();
    }
    this.printRestOfDeclaration(sd, rawId);
    this.scopeTree[sd] = outer;
  }

  private writeDeclaration(sd: number, rawId: number, parsed: Parsed): void {
    const node = this.nodes[sd];
    const sink = this.sink;
    const ctx = this.ctx;
    const tree = this.scopeTree[sd];
    const f = tree.f;
    const o = rawId * NS;
    const isOnItsOwnLine = this.printNameAndExtend(sd, false, parsed);
    const values = parsed.values;
    switch (node.valueKind) {
      case VAL_TEXT:
        sink.text(ctx.buf.data, node.valueS, node.valueE);
        break;
      case VAL_PARSED: {
        const d = ctx.buf.data;
        const rawValueS = f[o + F_VALUE_S] | 0;
        const rawValueE = f[o + F_VALUE_E] | 0;
        if (this.isOxfmt && startsWithLit(d, node.propS, node.propE, "--") && isMoreThanValues(d, rawValueS, rawValueE, ctx.syntax)) {
          const ts = trimJsWhitespaceStart(d, rawValueS, rawValueE);
          sink.text(d, ts, trimJsWhitespaceEnd(d, ts, rawValueE));
        } else {
          const value = node.valueId;
          // `hasComposesNode`
          const isWithoutLines = (values.kind[value] | 0) === VK_ROOT && eqLitIgnoreCase(d, node.propS, node.propE, "composes");
          if (isWithoutLines) sink.startWithoutLines();
          this.printValue(sd, value, 0);
          if (isWithoutLines) sink.endWithoutLines();
          // `$a: 1,` is a list of one in SCSS, and for oxfmt it stays one.
          if (this.isOxfmt && (d[node.propS] | 0) === 36 && node.propE > node.propS) {
            const te = trimJsWhitespaceEnd(d, rawValueS, rawValueE);
            if (te > rawValueS && (d[te - 1] | 0) === 44) {
              const group = topLevelGroup(values, value);
              if (group === 0 || (values.kind[group] | 0) !== VK_PAREN_GROUP || (values.open[group] | 0) !== 0 || values.groupCount(group) === 1) {
                sink.token(",");
              }
            }
          }
        }
        break;
      }
      default:
        break;
    }
    if (isOnItsOwnLine) {
      sink.endIndent();
      sink.endIndent();
    }
    // Or the backslash would escape the `;`, as in what Prettier prints.
    const d2 = ctx.buf.data;
    {
      const rvs = f[o + F_VALUE_S] | 0;
      let rve = f[o + F_VALUE_E] | 0;
      // `.trim_ascii_end()`
      while (rve > rvs && isWsB(d2[rve - 1] | 0)) rve = rve - 1;
      if (endsBeforeEscapedBlank(d2, rvs, rve)) sink.token(" ");
    }
    this.printRestOfDeclaration(sd, rawId);
  }

  /** What is before the value. Returns whether an `indent` and a `dedent` in it have been started for the value. `forRule`: the
   * name of a declaration whose value is a block (the selectors and values are not those of the node). */
  private printNameAndExtend(sd: number, forRule: boolean, parsed: Parsed): boolean {
    const node = this.nodes[sd];
    const sink = this.sink;
    const ctx = this.ctx;
    const d = ctx.buf.data;
    const values = parsed.values;
    const ts = trimJsWhitespaceStart(d, node.betweenS, node.betweenE);
    const te = trimJsWhitespaceEnd(d, ts, node.betweenE);
    const isColon = te - ts === 1 && (d[ts] | 0) === 58;
    let isValueAllSpace = false;
    if (node.valueKind === VAL_TEXT) {
      isValueAllSpace = true;
      for (let i = node.valueS; i < node.valueE; i++) {
        if ((d[i] | 0) !== 32) { isValueAllSpace = false; break; }
      }
    }

    {
      let any = false;
      for (let i = node.beforeS; i < node.beforeE; i++) {
        const b = d[i] | 0;
        if (b !== 59 && !isWsByte(b)) { any = true; break; }
      }
      if (any) {
        const sc = this.scratch;
        sc.len = 0;
        for (let i = node.beforeS; i < node.beforeE; i++) {
          const b = d[i] | 0;
          if (b !== 59 && !isWsByte(b)) sc.push(b);
        }
        sink.text(sc.data, 0, sc.len);
      }
    }
    const parent = sd > 0 ? this.nodes[sd - 1] : null;
    const isInLessVariable = parent !== null && parent.kind === K_AT_RULE && parent.variable;
    if (isInLessVariable || this.insideIcssRule(sd)) {
      sink.text(d, node.propS, node.propE);
    } else {
      this.emitMaybeLower(d, node.propS, node.propE);
    }
    if (te - ts >= 2 && (d[ts] | 0) === 47 && (d[ts + 1] | 0) === 47) sink.token(" ");
    sink.text(d, ts, te);
    // `a:${b} { .. }` in a template of JavaScript.
    let isPlaceholderRightBehindColon = false;
    if (node.isNested && !(isColon && node.betweenE > node.betweenS && (d[node.betweenE - 1] | 0) === 32) && node.valueKind === VAL_PARSED && !forRule) {
      const group = topLevelGroup(values, node.valueId);
      if (group !== 0) {
        const firstGroup = values.groupAt(group, 0);
        isPlaceholderRightBehindColon = isAtWordPlaceholder(values, group) || (firstGroup !== 0 && isAtWordPlaceholder(values, firstGroup));
      }
    }
    if (!(node.extend || isValueAllSpace || isPlaceholderRightBehindColon)) sink.token(" ");
    if (node.selector !== 0 && ctx.syntax === SYNTAX_LESS && node.extend && !forRule) {
      if ((parsed.selectors.childCount[node.selector] | 0) > 1) {
        sink.startGroup(false);
        sink.token("extend(");
        sink.startIndent();
        sink.softLine();
        this.printSelector(sd, node.selector, 0, 0);
        sink.endIndent();
        sink.softLine();
        sink.token(")");
        sink.endGroup();
      } else {
        sink.token("extend(");
        this.printSelector(sd, node.selector, 0, 0);
        sink.token(")");
      }
    }

    // `path.call(() => shouldBreakList(path), "value", "group", "group")`
    let shouldBreakTopLevelList = false;
    if (node.valueKind === VAL_PARSED && !forRule) {
      const group = topLevelGroup(values, node.valueId);
      if (group !== 0 && isListWithCommaGroup(values, group, this.isOxfmt)) shouldBreakTopLevelList = true;
    }
    if (shouldBreakTopLevelList && startsWithLit(d, node.propS, node.propE, "--")) shouldBreakTopLevelList = false;
    const isOnItsOwnLine = !isColon && lastLineHasInlineComment(d, ts, te) && !shouldBreakTopLevelList;
    if (isOnItsOwnLine) {
      sink.startIndent();
      sink.hardLine();
      sink.startDedent();
    }
    return isOnItsOwnLine;
  }

  /** `text(maybe_to_lower_case(d[s, e)))` */
  private emitMaybeLower(d: Uint8Array, s: number, e: number): void {
    const sc = this.scratch;
    sc.len = 0;
    if (maybeToLowerCase(d, s, e, sc)) this.sink.text(sc.data, 0, sc.len);
    else this.sink.text(d, s, e);
  }

  /** What follows the value, up to the `{` if there is a block. */
  private printRestOfDeclaration(sd: number, rawId: number): void {
    const node = this.nodes[sd];
    const sink = this.sink;
    const d = this.ctx.buf.data;
    const tree = this.scopeTree[sd];
    // `!default /* comment */ ;`: for oxfmt there is nothing before a `;`. Prettier has the text from `postcss` as it is.
    this.bang(d, node.rawImportantS, node.rawImportantE, node.important, "important", true);
    this.bang(d, node.rawScssDefaultS, node.rawScssDefaultE, node.scssDefault, "default", false);
    this.bang(d, node.rawScssGlobalS, node.rawScssGlobalE, node.scssGlobal, "global", false);
    if (node.hasBlock) {
      sink.token(" {");
    } else if (startsWithLit(d, node.propS, node.propE, "@prettier-placeholder") && this.hasNoSemicolon(sd)) {
      // `isTemplatePropNode`
    } else if (this.isHtmlStyleAttribute && (tree.f[rawId * NS + F_NEXT_SIBLING] | 0) === 0) {
      sink.ifBreak(";");
    } else {
      sink.token(";");
    }
  }

  private bang(d: Uint8Array, rs: number, re: number, isSet: boolean, word: string, allowsSpace: boolean): void {
    const sink = this.sink;
    if (rs >= 0) {
      const sc = this.scratch;
      sc.len = 0;
      let e = re;
      if (this.isOxfmt) e = trimJsWhitespaceEnd(d, rs, re);
      normalizeBang(d, rs, e, word, allowsSpace, sc);
      sink.text(sc.data, 0, sc.len);
    } else if (isSet) {
      sink.token(" !");
      sink.token(word);
    }
  }

  /** Whether there is no semicolon behind the node of `sd`. */
  private hasNoSemicolon(sd: number): boolean {
    this.isMemoizable = false;
    const parent = sd > 0 ? this.nodes[sd - 1] : null;
    const node = this.nodes[sd];
    // What Prettier makes of `--a: { .. }` has no `raws` to look at.
    if (parent !== null && parent.valueKind === VAL_RULE) this.fail(MSG_UNREADABLE_VALUE, node.start);
    // For oxfmt it is a statement of its own, wherever it is.
    const cond = this.isOxfmt || (parent !== null && !parent.semicolon);
    if (!cond) return false;
    const at = node.end - 1;
    if (node.end === 0) return true;
    return !(at < this.ctx.originalLen && (this.ctx.originalText[at] | 0) === 59);
  }

  private printAtRule(sd: number, rawId: number, parsed: Parsed): void {
    const node = this.nodes[sd];
    const sink = this.sink;
    const tree = this.scopeTree[sd];
    if (this.hasNoBlock(tree, rawId)) {
      this.printAtRuleUpToBlock(sd, parsed);
      return;
    }
    const marked = sink.startUnit();
    this.printAtRuleUpToBlock(sd, parsed);
    if (marked && !sink.endUnit()) {
      sink.startDocument();
      this.printAtRuleUpToBlock(sd, parsed);
      if (this.ctx.stack.ranOut()) sink.fail(FORMAT_NESTED_TOO_DEEPLY);
      sink.endDocument();
    }
    this.printBlock(sd, rawId, false, parsed);
    if (this.ctx.syntax === SYNTAX_LESS && node.variable) {
      sink.token(this.semicolonOfAtRule(sd));
    }
  }

  private semicolonOfAtRule(sd: number): string {
    // `isTemplatePlaceholderNode`: an expression in a template of JavaScript.
    const node = this.nodes[sd];
    if (startsWithLit(this.ctx.buf.data, node.nameS, node.nameE, "prettier-placeholder") && this.hasNoSemicolon(sd)) return "";
    return ";";
  }

  /** All of an at-rule, or what is before its block and the `{`. */
  private printAtRuleUpToBlock(sd: number, parsed: Parsed): void {
    const node = this.nodes[sd];
    const sink = this.sink;
    const ctx = this.ctx;
    const values = parsed.values;
    const d = ctx.buf.data;
    const isPlaceholder = startsWithLit(d, node.nameS, node.nameE, "prettier-placeholder");
    const semicolon = this.semicolonOfAtRule(sd);
    // `/^\(\s*\)$/`
    const rps = node.rawParamsS;
    const rpe = node.rawParamsE;
    const isDetachedRulesetCall =
      rpe - rps >= 2 && (d[rps] | 0) === 40 && (d[rpe - 1] | 0) === 41 && trimJsWhitespaceStart(d, rps + 1, rpe - 1) >= rpe - 1;
    if (ctx.syntax === SYNTAX_LESS) {
      if (node.mixin) {
        if (node.selector !== 0) this.printSelector(sd, node.selector, 0, 0);
        if (node.important) sink.token(" !important");
        sink.token(semicolon);
        return;
      }
      if (node.isFn) {
        sink.text(d, node.nameS, node.nameE);
        if (node.paramsKind === PAR_TEXT) sink.text(d, node.paramsS, node.paramsE);
        sink.token(semicolon);
        return;
      }
      if (node.variable) {
        const bs = trimJsWhitespaceStart(d, node.betweenS, node.betweenE);
        const be = trimJsWhitespaceEnd(d, bs, node.betweenE);
        sink.token("@");
        sink.text(d, node.nameS, node.nameE);
        sink.token(": ");
        if (node.valueKind === VAL_PARSED) {
          this.printValue(sd, node.valueId, 0);
          sink.lineSuffixBoundary();
        }
        if (be > bs) {
          sink.text(d, bs, be);
          sink.token(" ");
        }
        sink.token(node.hasBlock ? "{" : semicolon);
        return;
      }
    }
    const isControlDirective = this.isScssControlDirective(node);
    sink.token("@");
    if (isDetachedRulesetCall || (node.nameE > node.nameS && (d[node.nameE - 1] | 0) === 58) || isPlaceholder) {
      sink.text(d, node.nameS, node.nameE);
    } else {
      this.emitMaybeLower(d, node.nameS, node.nameE);
    }
    if (!(node.paramsKind === PAR_NONE) && !(node.paramsKind === PAR_TEXT && node.paramsE <= node.paramsS)) {
      // How many line breaks there are before the first other character of `raws.afterName`.
      const spacesEnd = trimJsWhitespaceStart(d, node.afterNameS, node.afterNameE);
      const lineBreaks = countByte(d, node.afterNameS, spacesEnd, 10);
      if (isDetachedRulesetCall) {
        // nothing
      } else if (!isPlaceholder) {
        sink.token(" ");
      } else if (node.afterNameE <= node.afterNameS) {
        // nothing
      } else if (node.nameE > node.nameS && (d[node.nameE - 1] | 0) === 58) {
        sink.token(" ");
      } else if (lineBreaks === 0) {
        sink.token(" ");
      } else if (lineBreaks === 1) {
        sink.hardLine();
      } else {
        sink.hardLine();
        sink.hardLine();
      }
      const kind = node.paramsKind;
      const isTextOrUnknown = kind === PAR_TEXT || kind === PAR_UNKNOWN;
      if (isTextOrUnknown && this.isOxfmt && (this.isInKeyframes(sd) || eqLit(d, node.nameS, node.nameE, "error") || eqLit(d, node.nameS, node.nameE, "warn"))) {
        // For oxfmt the quotes of the name of `@keyframes` and of what `@error` and `@warn` say are as everywhere.
        this.emitStrings(d, node.paramsS, node.paramsE);
      } else if (isTextOrUnknown && this.isOxfmt && isPlaceholder && node.hasBlock) {
        // `${a}-b > c,⏎ .d {` is a rule whose selectors start with a `${}`.
        this.printLinesOfSelector(d, node.paramsS, node.paramsE);
      } else if (
        isTextOrUnknown && !this.isOxfmt && tailwindIsActive(this.tailwind) &&
        (eqLit(d, node.nameS, node.nameE, "plugin") || eqLit(d, node.nameS, node.nameE, "config") || eqLit(d, node.nameS, node.nameE, "source"))
      ) {
        // `prettier-plugin-tailwindcss` has them parsed like those of `@import`.
        this.emitStrings(d, node.paramsS, node.paramsE);
      } else if (isTextOrUnknown) {
        const isSorted = eqLit(d, node.nameS, node.nameE, "apply") && !node.hasBlock;
        // To the plugin the parts of a comment are classes like others. oxfmt leaves such a list alone.
        const hasComment = indexOfLit(d, node.paramsS, node.paramsE, "/*") >= 0;
        let done = false;
        if (isSorted && tailwindIsActive(this.tailwind) && (tailwindFollowsPlugin(this.tailwind) || !hasComment)) {
          const sc = this.scratch;
          sc.len = 0;
          if (tailwindSortedToApply(this.tailwind, d, node.paramsS, node.paramsE, sc)) {
            sink.text(sc.data, 0, sc.len);
            done = true;
          }
        }
        if (!done) sink.text(d, node.paramsS, node.paramsE);
      } else if (kind === PAR_MEDIA) {
        this.printMedia(node.paramsId, true);
      } else if (kind === PAR_VALUE) {
        this.printValue(sd, node.paramsId, 0);
      }
    }
    if (node.selector !== 0) {
      sink.startIndent();
      sink.token(" ");
      this.printSelector(sd, node.selector, 0, 0);
      sink.endIndent();
    }
    if (node.valueKind === VAL_PARSED) {
      const value = node.valueId;
      // `hasParensAroundNode`
      const group = topLevelGroup(values, value);
      const hasParens = group !== 0 && (values.kind[group] | 0) === VK_PAREN_GROUP && (values.open[group] | 0) !== 0 && (values.close[group] | 0) !== 0;
      sink.startGroup(false);
      sink.token(" ");
      this.printValue(sd, value, 0);
      if (isControlDirective) {
        if (hasParens) sink.token(" ");
        else sink.line();
      }
      sink.endGroup();
    } else if (eqLit(d, node.nameS, node.nameE, "else")) {
      sink.token(" ");
    }
    const isImportThatEndsWithSemicolon =
      eqLit(d, node.nameS, node.nameE, "import") && node.paramsKind === PAR_VALUE && (values.kind[node.paramsId] | 0) === VK_UNKNOWN &&
      endsWithLit(values.text.data, values.vs[node.paramsId] | 0, values.ve[node.paramsId] | 0, ";");
    if (node.hasBlock) {
      let hasInlineComment = false;
      if (node.selector !== 0) {
        hasInlineComment =
          (parsed.selectors.kind[node.selector] | 0) === SK_UNKNOWN &&
          lastLineHasInlineComment(parsed.selectors.text.data, parsed.selectors.vs[node.selector] | 0, parsed.selectors.ve[node.selector] | 0);
      } else if (node.paramsKind === PAR_TEXT) {
        hasInlineComment = lastLineHasInlineComment(d, node.paramsS, node.paramsE);
      }
      if (isControlDirective) {
        // nothing
      } else if (hasInlineComment) {
        sink.line();
      } else {
        sink.token(" ");
      }
      sink.token("{");
    } else if (isImportThatEndsWithSemicolon) {
      // nothing
    } else {
      // Or the backslash would escape the `;`, as in what Prettier prints. Behind the value of `@if` there is a blank.
      if (endsBeforeEscapedBlank(d, node.rawParamsS, node.rawParamsE) && !isControlDirective) sink.token(" ");
      sink.token(semicolon);
    }
  }

  /** `atRuleAncestorNode`, for a value. For oxfmt, only its parameters are in an at-rule: what is in its block is printed as it
   * is anywhere else. */
  atRuleAround(sd: number): CssNode | null {
    const atRule = this.scopeAtRule[sd];
    if (atRule === null) return null;
    if (this.isOxfmt && this.nodes[sd].kind !== K_AT_RULE) return null;
    return atRule;
  }

  /** `isSCSSControlDirectiveNode` */
  isScssControlDirective(node: CssNode): boolean {
    if (this.ctx.syntax !== SYNTAX_SCSS || node.kind !== K_AT_RULE) return false;
    const d = this.ctx.buf.data;
    return (
      eqLit(d, node.nameS, node.nameE, "if") || eqLit(d, node.nameS, node.nameE, "else") || eqLit(d, node.nameS, node.nameE, "for") ||
      eqLit(d, node.nameS, node.nameE, "each") || eqLit(d, node.nameS, node.nameE, "while")
    );
  }

  // ───────────────────────────── helpers that emit adjusted text ─────────────────────────────

  /** `text(adjust_strings(d[s, e)))` */
  emitStrings(d: Uint8Array, s: number, e: number): void {
    const sc = this.scratch;
    sc.len = 0;
    if (adjustStrings(d, s, e, this.singleQuote, sc)) this.sink.text(sc.data, 0, sc.len);
    else this.sink.text(d, s, e);
  }

  /** `text(adjust_numbers(adjust_strings(d[s, e))))` */
  emitStringsNumbers(d: Uint8Array, s: number, e: number): void {
    const sc = this.scratch;
    const sc2 = this.scratch2;
    sc.len = 0;
    let cd = d;
    let cs = s;
    let ce = e;
    if (adjustStrings(d, s, e, this.singleQuote, sc)) {
      cd = sc.data;
      cs = 0;
      ce = sc.len;
    }
    sc2.len = 0;
    if (adjustNumbers(cd, cs, ce, sc2)) this.sink.text(sc2.data, 0, sc2.len);
    else this.sink.text(cd, cs, ce);
  }

  // ───────────────────────────── media queries ─────────────────────────────

  private printMedia(id: number, isLast: boolean): void {
    const t = mediaTree;
    const sink = this.sink;
    const d = this.ctx.buf.data;
    const kind = t.kind[id] | 0;
    const vs = t.vs[id] | 0;
    const ve = t.ve[id] | 0;
    switch (kind) {
      case MK_QUERY_LIST: {
        sink.startGroup(false);
        sink.startIndent();
        let isFirst = true;
        const count = t.childCount[id] | 0;
        let index = 0;
        let child = t.first[id] | 0;
        while (child !== 0) {
          index = index + 1;
          if (!((t.kind[child] | 0) === MK_QUERY && (t.ve[child] | 0) <= (t.vs[child] | 0))) {
            if (!isFirst) sink.line();
            isFirst = false;
            this.printMedia(child, index === count);
          }
          child = t.next[child] | 0;
        }
        sink.endIndent();
        sink.endGroup();
        break;
      }
      case MK_QUERY: {
        let index = 0;
        let child = t.first[id] | 0;
        while (child !== 0) {
          if (index > 0) sink.token(" ");
          this.printMedia(child, false);
          index = index + 1;
          child = t.next[child] | 0;
        }
        if (!isLast) sink.token(",");
        break;
      }
      case MK_TYPE:
      case MK_VALUE: {
        const isExpression = kind === MK_VALUE && this.isOxfmt && this.ctx.syntax === SYNTAX_SCSS;
        let cd = d;
        let cs = vs;
        let ce = ve;
        if (isExpression) {
          const sc2 = this.scratch2;
          sc2.len = 0;
          if (withBlanksAroundOperators(d, vs, ve, sc2)) {
            cd = sc2.data;
            cs = 0;
            ce = sc2.len;
          }
          // `adjust_strings` and `adjust_numbers` read from scratch2 and write to scratch / scratch2: copy first
          const copy = new Uint8Array(ce - cs);
          copy.set(cd.subarray(cs, ce));
          this.emitStringsNumbers(copy, 0, copy.length);
        } else {
          this.emitStringsNumbers(d, cs, ce);
        }
        break;
      }
      case MK_FEATURE_EXPRESSION: {
        if ((t.isContainer[id] | 0) === 0) {
          sink.text(d, vs, ve);
        } else if (this.isOxfmt && isRangeOrCondition(d, vs, ve)) {
          const sc = this.scratch;
          sc.len = 0;
          withBlanksInMediaFeature(d, vs, ve, sc);
          // adjust_numbers(maybe_to_lower_case(adjust_strings(text)))
          const sc2 = this.scratch2;
          sc2.len = 0;
          let cd = sc.data;
          let cs = 0;
          let ce = sc.len;
          if (adjustStrings(cd, cs, ce, this.singleQuote, sc2)) {
            cd = sc2.data;
            cs = 0;
            ce = sc2.len;
          }
          const sc3 = new ByteBuf(ce - cs + 16);
          if (maybeToLowerCase(cd, cs, ce, sc3)) {
            cd = sc3.data;
            cs = 0;
            ce = sc3.len;
          }
          const sc4 = new ByteBuf(ce - cs + 16);
          if (adjustNumbers(cd, cs, ce, sc4)) sink.text(sc4.data, 0, sc4.len);
          else sink.text(cd, cs, ce);
        } else {
          sink.token("(");
          let child = t.first[id] | 0;
          while (child !== 0) {
            this.printMedia(child, false);
            child = t.next[child] | 0;
          }
          // `(a\ )`, of which Prettier prints `(a\)`.
          if (ve - vs >= 1 && (d[ve - 1] | 0) === 41) {
            const ie = ve - 1;
            if (ie > vs && isWsB(d[ie - 1] | 0)) {
              let te = ie;
              while (te > vs && isWsB(d[te - 1] | 0)) te = te - 1;
              if (endsBeforeEscapedBlank(d, vs, te)) sink.token(" ");
            }
          }
          sink.token(")");
        }
        break;
      }
      case MK_FEATURE: {
        // `value.replaceAll(/ +/g, " ")`
        const sc = this.scratch;
        sc.len = 0;
        for (let i = vs; i < ve; i++) {
          const b = d[i] | 0;
          if (b !== 32 || sc.len === 0 || (sc.data[sc.len - 1] | 0) !== 32) sc.push(b);
        }
        const sc2 = this.scratch2;
        sc2.len = 0;
        let cd = sc.data;
        let cs = 0;
        let ce = sc.len;
        const sc3 = new ByteBuf(ce + 16);
        if (adjustStrings(cd, cs, ce, this.singleQuote, sc3)) {
          cd = sc3.data;
          cs = 0;
          ce = sc3.len;
        }
        if (maybeToLowerCase(cd, cs, ce, sc2)) sink.text(sc2.data, 0, sc2.len);
        else sink.text(cd, cs, ce);
        break;
      }
      case MK_COLON:
        sink.token(":");
        sink.token(" ");
        break;
      case MK_KEYWORD:
        this.emitStrings(d, vs, ve);
        break;
      case MK_URL: {
        // `.replaceAll(/^url\(\s+/gi, "url(").replaceAll(/\s+\)$/g, ")")`
        const sc = this.scratch;
        sc.len = 0;
        let s0 = vs;
        let e0 = ve;
        if (ve - vs >= 4 && eqLitIgnoreCase(d, vs, vs + 4, "url(") && (isWsAt(d, vs + 4, ve))) {
          sc.append(d, vs, vs + 4);
          const after = trimJsWhitespaceStart(d, vs + 4, ve);
          sc.append(d, after, ve);
        } else {
          sc.append(d, vs, ve);
        }
        s0 = 0;
        e0 = sc.len;
        const sd2 = sc.data;
        if (e0 > s0 && (sd2[e0 - 1] | 0) === 41) {
          const te = trimJsWhitespaceEnd(sd2, s0, e0 - 1);
          if (te < e0 - 1) {
            sc.len = 0;
            const tmp = new Uint8Array(te - s0);
            tmp.set(sd2.subarray(s0, te));
            sc.append(tmp, 0, tmp.length);
            sc.push(41);
            e0 = sc.len;
          }
        }
        const copy = new Uint8Array(e0 - s0);
        copy.set(sc.data.subarray(s0, e0));
        this.emitStrings(copy, 0, copy.length);
        break;
      }
      default:
        sink.text(d, vs, ve);
        break;
    }
    void MK_UNKNOWN;
  }

  // ───────────────────────────── selectors ─────────────────────────────

  private printNamespace(nsKind: number, nsS: number, nsE: number): void {
    const sink = this.sink;
    if (nsKind === NS_EMPTY) {
      sink.token("|");
    } else if (nsKind === NS_NAME) {
      const data = this.parsed.selectors.text.data;
      const ts = trimJsWhitespaceStart(data, nsS, nsE);
      sink.text(data, ts, trimJsWhitespaceEnd(data, ts, nsE));
      sink.token("|");
    }
  }

  /** `parent`: the selector that `id` is in. `previous`: what is before it there. (0: none) */
  printSelector(sd: number, id: number, parent: number, previous: number): void {
    const sel = this.parsed.selectors;
    const kind = sel.kind[id] | 0;
    if (kind === SK_ROOT || kind === SK_PSEUDO) {
      if (!this.ctx.stack.enter()) return;
      this.printSelectorInner(sd, id, parent, previous);
      this.ctx.stack.leave();
      return;
    }
    this.printSelectorInner(sd, id, parent, previous);
  }

  private printSelectorInner(sd: number, id: number, parent: number, previous: number): void {
    const sel = this.parsed.selectors;
    const sink = this.sink;
    const kind = sel.kind[id] | 0;
    const vs = sel.vs[id] | 0;
    const ve = sel.ve[id] | 0;
    const data = sel.text.data;
    switch (kind) {
      case SK_ROOT: {
        const atRule = this.scopeAtRule[sd];
        let customS = -1;
        let customE = 0;
        if (this.insideAtRule(sd, "custom-selector", "", "") && atRule !== null) {
          customS = atRule.customSelectorS;
          customE = atRule.customSelectorE;
        }
        const isOnOneLine = this.insideAtRule(sd, "extend", "custom-selector", "nest");
        // One on each line, which the group is broken by.
        sink.startGroup(!isOnOneLine && (sel.childCount[id] | 0) > 1);
        if (customS >= 0) {
          sink.text(this.ctx.buf.data, customS, customE);
          sink.line();
        }
        let child = sel.firstChild[id] | 0;
        let prev = 0;
        while (child !== 0) {
          if (prev !== 0) {
            sink.token(",");
            if (isOnOneLine) sink.line();
            else sink.hardLine();
          }
          this.printSelector(sd, child, id, prev);
          prev = child;
          child = sel.nextSibling[child] | 0;
        }
        sink.endGroup();
        break;
      }
      case SK_SELECTOR: {
        sink.startGroup(false);
        const many = (sel.childCount[id] | 0) > 2;
        if (many) sink.startIndent();
        let child = sel.firstChild[id] | 0;
        let prev = 0;
        while (child !== 0) {
          this.printSelector(sd, child, id, prev);
          prev = child;
          child = sel.nextSibling[child] | 0;
        }
        if (many) sink.endIndent();
        sink.endGroup();
        break;
      }
      case SK_COMMENT:
      case SK_NESTING:
        sink.text(data, vs, ve);
        break;
      case SK_STRING:
        this.emitStrings(data, vs, ve);
        break;
      case SK_TAG: {
        this.printNamespace(sel.nsKind[id] | 0, sel.nsS[id] | 0, sel.nsE[id] | 0);
        if (previous !== 0 && (sel.kind[previous] | 0) === SK_NESTING) {
          sink.text(data, vs, ve);
          return;
        }
        // `isKeyframeAtRuleKeywords`
        const isKeyframeKeyword = (eqLitIgnoreCase(data, vs, ve, "from") || eqLitIgnoreCase(data, vs, ve, "to")) && this.isInKeyframes(sd);
        if (isKeyframeKeyword) {
          const sc = this.scratch;
          sc.len = 0;
          appendLower(data, vs, ve, sc);
          sink.text(sc.data, 0, sc.len);
        } else {
          let hasDigit = false;
          for (let i = vs; i < ve; i++) {
            const c = data[i] | 0;
            if (c >= 48 && c <= 57) { hasDigit = true; break; }
          }
          if (!hasDigit) {
            sink.text(data, vs, ve);
          } else {
            const sc = this.scratch;
            sc.len = 0;
            if (adjustNumbers(data, vs, ve, sc)) sink.text(sc.data, 0, sc.len);
            else sink.text(data, vs, ve);
          }
        }
        break;
      }
      case SK_ID:
        // With the `#` before it.
        sink.text(data, vs > 0 ? vs - 1 : 0, ve);
        break;
      case SK_CLASS: {
        if (this.isOxfmt && previous === 0 && ve > vs && isAsciiDigit(data[vs] | 0) && this.isInKeyframes(sd)) {
          // For oxfmt, `.50%` in `@keyframes` is a number.
          const sc = this.scratch;
          sc.len = 0;
          const s0 = vs > 0 ? vs - 1 : 0;
          if (adjustNumbers(data, s0, ve, sc)) sink.text(sc.data, 0, sc.len);
          else sink.text(data, s0, ve);
          break;
        }
        // Most class names have no quote and no digit.
        let maybe = false;
        for (let i = vs; i < ve; i++) {
          const c = data[i] | 0;
          if (c === 34 || c === 39 || (c >= 48 && c <= 57)) { maybe = true; break; }
        }
        if (!maybe) {
          sink.text(data, vs > 0 ? vs - 1 : 0, ve);
          break;
        }
        const sc = this.scratch;
        const sc2 = this.scratch2;
        sc.len = 0;
        sc2.len = 0;
        const strChanged = adjustStrings(data, vs, ve, this.singleQuote, sc);
        const numChanged = adjustNumbers(data, vs, ve, sc2);
        if (!strChanged && !numChanged) {
          // With the `.` before it.
          sink.text(data, vs > 0 ? vs - 1 : 0, ve);
        } else {
          sink.token(".");
          if (strChanged) {
            const out = this.scratch3;
            out.len = 0;
            if (adjustNumbers(sc.data, 0, sc.len, out)) sink.text(out.data, 0, out.len);
            else sink.text(sc.data, 0, sc.len);
          } else {
            sink.text(sc2.data, 0, sc2.len);
          }
        }
        break;
      }
      case SK_ATTRIBUTE: {
        sink.token("[");
        this.printNamespace(sel.nsKind[id] | 0, sel.nsS[id] | 0, sel.nsE[id] | 0);
        {
          const as = trimJsWhitespaceStart(data, sel.attrS[id] | 0, sel.attrE[id] | 0);
          sink.text(data, as, trimJsWhitespaceEnd(data, as, sel.attrE[id] | 0));
        }
        if ((sel.opS[id] | 0) >= 0) sink.text(data, sel.opS[id] | 0, sel.opE[id] | 0);
        if ((sel.hasValue[id] | 0) !== 0) {
          const ts = trimJsWhitespaceStart(data, vs, ve);
          const te = trimJsWhitespaceEnd(data, ts, ve);
          const sc = this.scratch;
          sc.len = 0;
          let cd = data;
          let cs = ts;
          let ce = te;
          if (adjustStrings(data, ts, te, this.singleQuote, sc)) {
            cd = sc.data;
            cs = 0;
            ce = sc.len;
          }
          const sc2 = this.scratch3;
          sc2.len = 0;
          if (quoteAttributeValue(cd, cs, ce, this.singleQuote, sc2)) {
            cd = sc2.data;
            cs = 0;
            ce = sc2.len;
          }
          // `replaceEndOfLine(.., literallineWithoutBreakParent)`
          let lineStart = cs;
          let index = 0;
          while (true) {
            let lineEnd = indexOfByteIn(cd, lineStart, ce, 10);
            if (lineEnd < 0) lineEnd = ce;
            if (index > 0) sink.literalLine();
            sink.text(cd, lineStart, lineEnd);
            index = index + 1;
            if (lineEnd >= ce) break;
            lineStart = lineEnd + 1;
          }
        }
        sink.token((sel.insensitive[id] | 0) !== 0 ? " i]" : "]");
        break;
      }
      case SK_COMBINATOR: {
        if (
          eqLit(data, vs, ve, "+") || eqLit(data, vs, ve, ">") || eqLit(data, vs, ve, "~") || eqLit(data, vs, ve, ">>>")
        ) {
          let isFirst = false;
          if (parent !== 0) {
            isFirst = (sel.kind[parent] | 0) === SK_SELECTOR && (sel.firstChild[parent] | 0) === id;
          }
          if (!isFirst) sink.line();
          sink.text(data, vs, ve);
          if ((sel.nextSibling[id] | 0) !== 0) sink.token(" ");
          return;
        }
        let allWs = true;
        for (let i = vs; i < ve; i++) {
          if (!isWsB(data[i] | 0)) { allWs = false; break; }
        }
        if (allWs) {
          sink.line();
          return;
        }
        {
          const ts = trimJsWhitespaceStart(data, vs, ve);
          if (ts < ve && (data[ts] | 0) === 40) sink.line();
          const te = trimJsWhitespaceEnd(data, ts, ve);
          const sc = this.scratch;
          sc.len = 0;
          let cd = data;
          let cs = ts;
          let ce = te;
          if (adjustStrings(data, ts, te, this.singleQuote, sc)) {
            cd = sc.data;
            cs = 0;
            ce = sc.len;
          }
          const sc2 = this.scratch3;
          sc2.len = 0;
          if (adjustNumbers(cd, cs, ce, sc2)) {
            cd = sc2.data;
            cs = 0;
            ce = sc2.len;
          }
          if (ce <= cs) sink.line();
          else sink.text(cd, cs, ce);
        }
        break;
      }
      case SK_UNIVERSAL:
        this.printNamespace(sel.nsKind[id] | 0, sel.nsS[id] | 0, sel.nsE[id] | 0);
        sink.text(data, vs, ve);
        break;
      case SK_PSEUDO: {
        this.emitMaybeLower(data, vs, ve);
        if ((sel.firstChild[id] | 0) !== 0) {
          sink.startGroup(false);
          sink.token("(");
          sink.startIndent();
          sink.softLine();
          let child = sel.firstChild[id] | 0;
          let prev = 0;
          while (child !== 0) {
            if (prev !== 0) {
              sink.token(",");
              sink.line();
            }
            this.printSelector(sd, child, id, prev);
            prev = child;
            child = sel.nextSibling[child] | 0;
          }
          sink.endIndent();
          sink.softLine();
          sink.token(")");
          sink.endGroup();
        }
        break;
      }
      default:
        this.printUnknownSelector(sd, data, vs, ve);
        break;
    }
  }

  private printUnknownSelector(sd: number, value: Uint8Array, vs: number, ve: number): void {
    this.isMemoizable = false;
    const sink = this.sink;
    const rule = this.cssAncestor(sd, K_RULE);
    if (rule !== null && rule.isScssNestedProperty) {
      const sc = this.scratch;
      sc.len = 0;
      let cd = value;
      let cs = vs;
      let ce = ve;
      if (maybeToLowerCase(value, vs, ve, sc)) {
        cd = sc.data;
        cs = 0;
        ce = sc.len;
      }
      const copy = new Uint8Array(ce - cs);
      copy.set(cd.subarray(cs, ce));
      this.emitStringsNumbers(copy, 0, copy.length);
      return;
    }
    const values = this.parsed.values;
    // In the parentheses of `selector()`.
    if (this.nValueStack >= 2) {
      const func = this.valueStack[this.nValueStack - 2] | 0;
      const pg = this.valueStack[this.nValueStack - 1] | 0;
      if (
        (values.kind[pg] | 0) === VK_PAREN_GROUP && (values.open[pg] | 0) !== 0 && (values.close[pg] | 0) !== 0 &&
        (values.kind[func] | 0) === VK_FUNC && eqLit(values.text.data, values.vs[func] | 0, values.ve[func] | 0, "selector")
      ) {
        const oe = values.locEndOffset[values.open[pg] | 0] | 0;
        const cst = values.locStartOffset[values.close[pg] | 0] | 0;
        const start = oe !== 2147483647 ? oe + 1 : 0;
        const end = cst !== 2147483647 ? cst : 0;
        const orig = this.ctx.originalText;
        const s0 = start <= end && end <= this.ctx.originalLen ? start : 0;
        const e0 = start <= end && end <= this.ctx.originalLen ? end : 0;
        const ts = trimJsWhitespaceStart(orig, s0, e0);
        const te = trimJsWhitespaceEnd(orig, ts, e0);
        if (lastLineHasInlineComment(orig, ts, te)) sink.breakParent();
        sink.text(orig, ts, te);
        return;
      }
    }
    // The text is taken from the style sheet, for the sake of Less.
    const parent = this.nodes[sd];
    if (this.nValueStack === 0 && parent.rawSelectorE > parent.rawSelectorS) {
      const end = parent.start + (parent.rawSelectorE - parent.rawSelectorS);
      const orig = this.ctx.originalText;
      const s0 = parent.start <= end && end <= this.ctx.originalLen ? parent.start : 0;
      const e0 = parent.start <= end && end <= this.ctx.originalLen ? end : 0;
      const ts = trimJsWhitespaceStart(orig, s0, e0);
      sink.text(orig, ts, trimJsWhitespaceEnd(orig, ts, e0));
      return;
    }
    sink.text(value, vs, ve);
  }

  // ───────────────────────────── values ─────────────────────────────

  /** The name of the function that what is being printed is in: the node, or 0. */
  valueFunction(): number {
    const values = this.parsed.values;
    for (let i = this.nValueStack - 1; i >= 0; i--) {
      const id = this.valueStack[i] | 0;
      if ((values.kind[id] | 0) === VK_FUNC) return id;
    }
    return 0;
  }

  /** `insideValueFunctionNode` with a (lower case) name */
  insideValueFunction(name: string): boolean {
    const f = this.valueFunction();
    if (f === 0) return false;
    const values = this.parsed.values;
    return eqLitIgnoreCase(values.text.data, values.vs[f] | 0, values.ve[f] | 0, name);
  }

  pushValue(id: number): void {
    if (this.nValueStack === this.valueStack.length) {
      const n = new Int32Array(this.nValueStack * 2);
      n.set(this.valueStack);
      this.valueStack = n;
    }
    this.valueStack[this.nValueStack] = id | 0;
    this.nValueStack = this.nValueStack + 1;
  }

  popValue(): void {
    this.nValueStack = this.nValueStack - 1;
  }

  /** `previous`: what is before `id` in the group that it is in (0: none). */
  printValue(sd: number, id: number, previous: number): void {
    const values = this.parsed.values;
    const kind = values.kind[id] | 0;
    if (
      kind === VK_ROOT || kind === VK_VALUE || kind === VK_COMMA_GROUP || kind === VK_PAREN_GROUP || kind === VK_FUNC || kind === VK_SELECTOR
    ) {
      if (!this.ctx.stack.enter()) return;
      this.printValueInner(sd, id, previous);
      this.ctx.stack.leave();
      return;
    }
    this.printValueInner(sd, id, previous);
  }

  private printValueInner(sd: number, id: number, previous: number): void {
    const values = this.parsed.values;
    const sink = this.sink;
    const kind = values.kind[id] | 0;
    const vdata = values.text.data;
    const vs = values.vs[id] | 0;
    const ve = values.ve[id] | 0;
    switch (kind) {
      case VK_ROOT:
      case VK_VALUE:
        this.printChildValue(sd, id, values.group[id] | 0);
        break;
      case VK_COMMENT: {
        this.isMemoizable = false;
        const so = values.locStartOffset[id] | 0;
        const eo = values.locEndOffset[id] | 0;
        const start = so === 2147483647 ? 0 : so;
        const end = eo === 2147483647 ? 0 : eo;
        const orig = this.ctx.originalText;
        const ok = start <= end && end <= this.ctx.originalLen;
        const s0 = ok ? start : 0;
        const e0 = ok ? end : 0;
        if ((values.inline[id] | 0) !== 0) {
          sink.startLineSuffix();
          sink.text(orig, s0, trimJsWhitespaceEnd(orig, s0, e0));
          sink.endLineSuffix();
        } else {
          sink.text(orig, s0, e0);
        }
        break;
      }
      case VK_COMMA_GROUP:
        printCommaSeparatedValueGroup(this, sd, id);
        break;
      case VK_PAREN_GROUP:
        printParenthesizedValueGroup(this, sd, id);
        break;
      case VK_FUNC: {
        const isKeyword = eqLitIgnoreCase(vdata, vs, ve, "not") || eqLitIgnoreCase(vdata, vs, ve, "and") || eqLitIgnoreCase(vdata, vs, ve, "or");
        sink.text(vdata, vs, ve);
        if (isKeyword && this.insideAtRule(sd, "supports", "", "")) sink.token(" ");
        this.printChildValue(sd, id, values.group[id] | 0);
        break;
      }
      case VK_NUMBER: {
        const sc = this.scratch;
        sc.len = 0;
        printCssNumber(vdata, vs, ve, sc);
        sink.text(sc.data, 0, sc.len);
        const us = values.unitS[id] | 0;
        const ue = values.unitE[id] | 0;
        const ui = cssUnitIndex(vdata, us, ue);
        if (ui >= 0) sink.text(unitBytes(), unitStart(ui), unitEnd(ui));
        else sink.text(vdata, us, ue);
        break;
      }
      case VK_PAREN:
      case VK_OPERATOR:
      case VK_UNICODE_RANGE:
      case VK_UNKNOWN:
      case VK_COMMA:
        sink.text(vdata, vs, ve);
        break;
      case VK_TEXT:
        sink.text(vdata, vs, ve);
        break;
      case VK_WORD: {
        const isWideKeyword =
          eqLitIgnoreCase(vdata, vs, ve, "initial") || eqLitIgnoreCase(vdata, vs, ve, "inherit") || eqLitIgnoreCase(vdata, vs, ve, "unset") ||
          eqLitIgnoreCase(vdata, vs, ve, "revert");
        if (((values.isColor[id] | 0) !== 0 && (values.isHex[id] | 0) !== 0) || isWideKeyword) {
          const sc = this.scratch;
          sc.len = 0;
          if (toLowerCase(vdata, vs, ve, sc)) sink.text(sc.data, 0, sc.len);
          else sink.text(vdata, vs, ve);
        } else {
          sink.text(vdata, vs, ve);
        }
        break;
      }
      case VK_COLON: {
        const isEscaped =
          previous !== 0 && values.hasValueText(previous) && endsWithLit(vdata, values.vs[previous] | 0, values.ve[previous] | 0, "\\");
        sink.startGroup(false);
        sink.token(":");
        if (!(isEscaped || this.insideValueFunction("url"))) sink.line();
        sink.endGroup();
        break;
      }
      case VK_STRING: {
        // `@import "a" source('b')`: oxfmt knows `url()`. A string in another function keeps its quotes.
        let keepQuotes = false;
        if (this.isOxfmt && this.insideAtRule(sd, "import", "", "")) {
          const f = this.valueFunction();
          if (f !== 0 && !eqLitIgnoreCase(vdata, values.vs[f] | 0, values.ve[f] | 0, "url")) keepQuotes = true;
        }
        const rs = vs > 0 ? vs - 1 : 0;
        if (keepQuotes) {
          sink.text(vdata, rs, ve + 1);
        } else {
          const sc = this.scratch;
          sc.len = 0;
          printString(vdata, rs, ve + 1, this.singleQuote, sc);
          sink.text(sc.data, 0, sc.len);
        }
        break;
      }
      case VK_AT_WORD: {
        sink.token("@");
        // For oxfmt `@a!important` is `@a !important`.
        const n = ve - vs;
        if (this.isOxfmt && n > 10 && eqLitIgnoreCase(vdata, ve - 10, ve, "!important")) {
          sink.text(vdata, vs, ve - 10);
          sink.token(" !important");
        } else {
          sink.text(vdata, vs, ve);
        }
        break;
      }
      case VK_SELECTOR:
        this.printSelector(sd, values.selector[id] | 0, 0, 0);
        break;
      default:
        break;
    }
  }

  /** Prints `child`, which is in `parent`. */
  printChildValue(sd: number, parent: number, child: number): void {
    this.pushValue(parent);
    this.printValue(sd, child, 0);
    this.popValue();
  }
}

function isSelSpace(b: number): boolean {
  return b === 32 || b === 9 || b === 13 || b === 12;
}

function isWsAt(d: Uint8Array, at: number, e: number): boolean {
  return at < e && trimJsWhitespaceStart(d, at, e) > at;
}

void leadingWhiteSpaceLen;
void PAR_NONE;
void VAL_NONE;
void MK_URL;
void BEFORE_EMPTY;
void F_NAME_E;
void F_NAME_S;
void F_BEFORE_S;
void F_BEFORE_E;
void isNextLineEmpty;
void F_RAW_IMPORTANT_E;
void F_RAW_IMPORTANT_S;
void F_BETWEEN_E;
void F_BETWEEN_S;
void SK_ATTRIBUTE;
void indexOfAny2;
void countByte;
void isListWithCommaGroup;
void refusalMessage;
void SYNTAX_CSS;
void F_KIND;
