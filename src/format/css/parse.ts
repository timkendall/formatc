// Port of vendor/bun/src/format/css/parse.rs: Prettier's `parser-postcss.js`: the tree of `postcss`, with selectors, values
// and parameters parsed.
//
// Rust -> TS: `CssNode` is a class (one object per nesting depth is reused by the printer: `convert` fills it); every text
// in it is a range `(s, e)` of `ctx.buf` (the owned `Cow`s were made in the arena above the style sheet and its extra
// strings: whoever converts marks `buf.len` before and cuts back after). `Cow::Borrowed` vs `Owned` matters in two places
// (the media query and `Params`), where a flag says which.
import { ByteBuf } from "../../base/bytebuf.ts";
import { Stack } from "../../base/stack.ts";
import {
  leadingWhiteSpaceLen,
  startsWithWhiteSpace,
  trimJsWhitespaceEnd,
  trimJsWhitespaceStart,
} from "../text.ts";
import {
  MSG_RULE_WITHOUT_SELECTOR,
  MSG_UNREADABLE_AT_RULE,
  MSG_UNREADABLE_VALUE,
  noteRefusal,
} from "../syntax_error.ts";
import { mediaTree, parseMedia } from "./media_query.ts";
import {
  PLACEHOLDER_AT_RULE,
  PostcssParser,
  Tree,
  K_AT_RULE,
  K_COMMENT,
  K_DECL,
  K_ROOT,
  K_RULE,
  NS,
  F_AFTER_E,
  F_AFTER_NAME_E,
  F_AFTER_NAME_S,
  F_AFTER_S,
  F_BEFORE_E,
  F_BEFORE_S,
  F_BETWEEN_E,
  F_BETWEEN_S,
  F_CLEAN_PARAMS_E,
  F_CLEAN_PARAMS_S,
  F_CLEAN_SELECTOR_E,
  F_CLEAN_SELECTOR_S,
  F_CLEAN_VALUE_E,
  F_CLEAN_VALUE_S,
  F_END,
  F_EXTEND,
  F_FIRST_CHILD,
  F_FUNCTION,
  F_HAS_BLOCK,
  F_IDENTIFIER_E,
  F_IDENTIFIER_S,
  F_IMPORTANT,
  F_INLINE,
  F_IS_NESTED,
  F_KIND,
  F_LAST_CHILD,
  F_MIXIN,
  F_NAME_E,
  F_NAME_S,
  F_NEXT_SIBLING,
  F_PARAMS_E,
  F_PARAMS_S,
  F_PROP_E,
  F_PROP_S,
  F_RAW_IMPORTANT_E,
  F_RAW_IMPORTANT_S,
  F_RAW_INLINE,
  F_SELECTOR_E,
  F_SELECTOR_S,
  F_SEMICOLON,
  F_START,
  F_VALUE_E,
  F_VALUE_S,
  F_VALUE_SKIPS,
  F_VARIABLE,
} from "./postcss.ts";
import { Selectors, SK_UNKNOWN } from "./selector_parser.ts";
import { SYNTAX_CSS, SYNTAX_LESS, SYNTAX_SCSS } from "./syntax.ts";
import { Values } from "./value_parser.ts";
import {
  containsByteIn,
  eqLit,
  eqLitIgnoreCase,
  endsWithLit,
  indexOfAny2,
  indexOfByteIn,
  indexOfLit,
  isAsciiDigit,
  lowerByte,
  startsWithLit,
} from "./misc.ts";

// `Value`
export const VAL_NONE = 0;
export const VAL_TEXT = 1;
export const VAL_PARSED = 2;
/** `--a: { .. }`: the nodes are those of the rule that is the only node of `valueTree`. */
export const VAL_RULE = 3;

// `Params`
export const PAR_NONE = 0;
export const PAR_TEXT = 1;
export const PAR_MEDIA = 2;
export const PAR_VALUE = 3;
/** `media-unknown` and `selector-unknown`, which are printed the same way here. */
export const PAR_UNKNOWN = 4;

/** The selectors and the values of a node. Those of the next node take their place. */
export class Parsed {
  selectors: Selectors;
  values: Values;
  constructor() {
    this.selectors = new Selectors();
    this.values = new Values();
  }
}

/** A node, without what is in its block. */
export class CssNode {
  kind: number = K_ROOT;
  /** `locStart(node)` and `locEnd(node)` */
  start: number = 0;
  end: number = 0;
  /** Whether it has `nodes`. */
  hasBlock: boolean = false;
  beforeS: number = 0;
  beforeE: number = 0;
  betweenS: number = 0;
  betweenE: number = 0;
  afterS: number = 0;
  afterE: number = 0;
  afterNameS: number = 0;
  afterNameE: number = 0;
  semicolon: boolean = false;
  /** 0: none */
  selector: number = 0;
  /** `raws.selector` */
  rawSelectorS: number = 0;
  rawSelectorE: number = 0;
  isScssNestedProperty: boolean = false;
  isNested: boolean = false;
  propS: number = 0;
  propE: number = 0;
  valueKind: number = VAL_NONE;
  valueS: number = 0;
  valueE: number = 0;
  valueId: number = 0;
  valueTree: Tree | null = null;
  important: boolean = false;
  /** start -1: none */
  rawImportantS: number = -1;
  rawImportantE: number = 0;
  scssDefault: boolean = false;
  rawScssDefaultS: number = -1;
  rawScssDefaultE: number = 0;
  scssGlobal: boolean = false;
  rawScssGlobalS: number = -1;
  rawScssGlobalE: number = 0;
  nameS: number = 0;
  nameE: number = 0;
  paramsKind: number = PAR_NONE;
  paramsS: number = 0;
  paramsE: number = 0;
  /** The id of the root of the media query in `mediaTree`, or of the value. */
  paramsId: number = 0;
  /** `raws.params` */
  rawParamsS: number = 0;
  rawParamsE: number = 0;
  /** start -1: none */
  customSelectorS: number = -1;
  customSelectorE: number = 0;
  extend: boolean = false;
  mixin: boolean = false;
  isFn: boolean = false;
  variable: boolean = false;

  /** Sets everything to what `convert` starts from. */
  reset(): void {
    this.kind = K_ROOT;
    this.start = 0;
    this.end = 0;
    this.hasBlock = false;
    this.beforeS = this.beforeE = 0;
    this.betweenS = this.betweenE = 0;
    this.afterS = this.afterE = 0;
    this.afterNameS = this.afterNameE = 0;
    this.semicolon = false;
    this.selector = 0;
    this.rawSelectorS = this.rawSelectorE = 0;
    this.isScssNestedProperty = false;
    this.isNested = false;
    this.propS = this.propE = 0;
    this.valueKind = VAL_NONE;
    this.valueS = this.valueE = 0;
    this.valueId = 0;
    this.valueTree = null;
    this.important = false;
    this.rawImportantS = -1;
    this.rawImportantE = 0;
    this.scssDefault = false;
    this.rawScssDefaultS = -1;
    this.rawScssDefaultE = 0;
    this.scssGlobal = false;
    this.rawScssGlobalS = -1;
    this.rawScssGlobalE = 0;
    this.nameS = this.nameE = 0;
    this.paramsKind = PAR_NONE;
    this.paramsS = this.paramsE = 0;
    this.paramsId = 0;
    this.rawParamsS = this.rawParamsE = 0;
    this.customSelectorS = -1;
    this.customSelectorE = 0;
    this.extend = false;
    this.mixin = false;
    this.isFn = false;
    this.variable = false;
  }
}

/** `/(\s*)(!default).*$/` or the same with `!global`: where the match starts (the end of the trimmed text before the
 * directive), or -1. */
function findDirective(value: Uint8Array, s: number, e: number, directive: string): number {
  let from = s;
  while (true) {
    const at = indexOfLit(value, from, e, directive);
    if (at < 0) return -1;
    let ok = indexOfAny2(value, at, e, 10, 13) < 0;
    if (ok && indexOfLit(value, at, e, " ") >= 0) ok = false;
    if (ok) return trimJsWhitespaceEnd(value, s, at);
    from = at + 1;
  }
}

/** The regular expression `^\s*:?\s*`: the length of the match. */
function afterNamePrefixLen(data: Uint8Array, s: number, e: number): number {
  let i = trimJsWhitespaceStart(data, s, e);
  if (i < e && (data[i] | 0) === 58) i = i + 1;
  i = trimJsWhitespaceStart(data, i, e);
  return i - s;
}

/** `getValueRootOffset` and `getAtRuleParamsRootOffset` for an at-rule. */
function valueRootOffset(data: Uint8Array, node: CssNode): number {
  return node.start + 1 + (node.nameE - node.nameS) + afterNamePrefixLen(data, node.afterNameS, node.afterNameE);
}

/** `is_scss_nested_property`. `selector`: as `postcss` has cleaned it. */
function isScssNestedProperty(sel: Uint8Array, s: number, e: number): boolean {
  let data = sel;
  let cs = s;
  let ce = e;
  const hasBlockComment = indexOfLit(data, cs, ce, "/*") >= 0;
  const hasLineComment = indexOfLit(data, cs, ce, "//") >= 0;
  if (hasBlockComment || hasLineComment) {
    // `.replace(/\/\*.*?\*\//, "")`
    let from = cs;
    while (true) {
      const start = indexOfLit(data, from, ce, "/*");
      if (start < 0) break;
      let lineEnd = ce;
      for (let i = start; i < ce; i++) {
        const c = data[i] | 0;
        if (c === 10 || c === 13) { lineEnd = i; break; }
      }
      const end = indexOfLit(data, start + 2, lineEnd, "*/");
      if (end >= 0) {
        const out = new Uint8Array(ce - cs - (end + 2 - start));
        out.set(data.subarray(cs, start), 0);
        out.set(data.subarray(end + 2, ce), start - cs);
        data = out;
        cs = 0;
        ce = out.length;
        break;
      }
      from = start + 1;
    }
    // `.replace(/\/\/.*\n/, "")`
    from = cs;
    while (true) {
      const start = indexOfLit(data, from, ce, "//");
      if (start < 0) break;
      const at = indexOfAny2(data, start, ce, 10, 13);
      if (at < 0) break;
      if ((data[at] | 0) === 10) {
        const out = new Uint8Array(ce - cs - (at + 1 - start));
        out.set(data.subarray(cs, start), 0);
        out.set(data.subarray(at + 1, ce), start - cs);
        data = out;
        cs = 0;
        ce = out.length;
        break;
      }
      from = at;
    }
  }
  const te = trimJsWhitespaceEnd(data, cs, ce);
  return te > cs && (data[te - 1] | 0) === 58;
}

/** `text::starts_with_white_space(&[b])`: the white space of one byte. */
function isJsWsByte(b: number): boolean {
  return b === 32 || (b >= 9 && b <= 13);
}

export class Context {
  /** The text of the style sheet (blanks in the place of the front matter), what the postcss parser has in `buf.data`,
   * its extra strings, and above those what `convert` makes. */
  buf: ByteBuf;
  /** The length of the text that is parsed. */
  cssLen: number;
  /** `options.originalText` */
  originalText: Uint8Array;
  originalLen: number;
  /** Whether `buf` has the same text as `originalText`. */
  isOriginalText: boolean;
  syntax: number;
  isOxfmt: boolean;
  /** Why a node has not been converted: see `noteRefusal`. */
  stack: Stack;
  convertibleSets: Map<number, boolean>;
  // `concat` results
  cE: number;
  cOwned: boolean;
  // scratch nodes for `canBeConverted` and `endOf`, by depth
  tmpNodes: CssNode[];
  tmpDepth: number;
  scratchParsed: Parsed;

  constructor() {
    this.buf = new ByteBuf(16);
    this.cssLen = 0;
    this.originalText = new Uint8Array(0);
    this.originalLen = 0;
    this.isOriginalText = true;
    this.syntax = SYNTAX_CSS;
    this.isOxfmt = false;
    this.stack = Stack.forTree();
    this.convertibleSets = new Map<number, boolean>();
    this.cE = 0;
    this.cOwned = false;
    this.tmpNodes = [];
    this.tmpDepth = 0;
    this.scratchParsed = new Parsed();
  }

  // ───────────────────────────── the arena ─────────────────────────────

  /** Copies src[s, e) to the arena; returns the start, the end is `buf.len`. */
  copy(src: Uint8Array, s: number, e: number): number {
    const at = this.buf.len;
    this.buf.append(src, s, e);
    return at;
  }

  /** `a + b + c` for ranges of `buf`. Returns the start; the end is `cE`; `cOwned` says whether the text had to be made. */
  concat3(aS: number, aE: number, bS: number, bE: number, cS: number, cE: number): number {
    let allS = 0;
    let allE = 0;
    for (let index = 0; index < 3; index++) {
      const s = index === 0 ? aS : index === 1 ? bS : cS;
      const e = index === 0 ? aE : index === 1 ? bE : cE;
      if (allS >= allE) {
        allS = s;
        allE = e;
      } else if (s >= e) {
        // nothing
      } else if (allE === s) {
        allE = e;
      } else {
        const start = this.buf.len;
        this.buf.append(this.buf.data, allS, allE);
        for (let k = index; k < 3; k++) {
          const ks = k === 0 ? aS : k === 1 ? bS : cS;
          const ke = k === 0 ? aE : k === 1 ? bE : cE;
          this.buf.append(this.buf.data, ks, ke);
        }
        this.cE = this.buf.len;
        this.cOwned = true;
        return start;
      }
    }
    this.cE = allE;
    this.cOwned = false;
    return allS;
  }

  // ───────────────────────────── conversion ─────────────────────────────

  /** `Context::of(range)` is `buf.data[s .. e)`. */

  /** `name_of_at_rule`: the name that an at-rule has for Prettier: sets `cE`; returns the start. */
  nameOfAtRule(tree: Tree, id: number): number {
    const f = tree.f;
    const o = id * NS;
    const s = f[o + F_NAME_S] | 0;
    const e = f[o + F_NAME_E] | 0;
    const colon = indexOfByteIn(this.buf.data, s, e, 58);
    // `@color:blue;`
    if (colon >= 0 && this.syntax === SYNTAX_LESS && (f[o + F_MIXIN] | 0) === 0 && (f[o + F_FUNCTION] | 0) === 0) {
      this.cE = colon;
      return s;
    }
    this.cE = e;
    return s;
  }

  private tmpNode(): CssNode {
    while (this.tmpNodes.length <= this.tmpDepth) this.tmpNodes.push(new CssNode());
    return this.tmpNodes[this.tmpDepth];
  }

  /** Whether `id` and everything in it can be converted. */
  private canBeConverted(tree: Tree, id: number, parsed: Parsed): boolean {
    if (!this.stack.enter()) return false;
    const mark = this.buf.len;
    const node = this.tmpNode();
    this.tmpDepth = this.tmpDepth + 1;
    let ok = this.convert(tree, id, parsed, node) >= 0;
    this.tmpDepth = this.tmpDepth - 1;
    this.buf.len = mark;
    if (ok) {
      let child = tree.f[id * NS + F_FIRST_CHILD] | 0;
      while (child !== 0) {
        if (!this.canBeConverted(tree, child, parsed)) { ok = false; break; }
        child = tree.f[child * NS + F_NEXT_SIBLING] | 0;
      }
    }
    this.stack.leave();
    return ok;
  }

  /** Whether the rule `only` of `tree`, which is what is in the custom property set that starts at `start`, can be
   * converted. */
  private isConvertibleSet(start: number, tree: Tree, only: number, parsed: Parsed): boolean {
    const known = this.convertibleSets.get(start);
    if (known !== undefined) return known;
    const can = this.canBeConverted(tree, only, parsed);
    this.convertibleSets.set(start, can);
    return can;
  }

  /** `locEnd(node)` */
  endOf(tree: Tree, id: number, parsed: Parsed): number {
    const f = tree.f;
    const o = id * NS;
    const end = f[o + F_END] | 0;
    if (end >= 0 && (f[o + F_INLINE] | 0) === 0) return end < this.originalLen ? end : this.originalLen;
    if (!this.stack.enter()) return 0;
    const mark = this.buf.len;
    const node = this.tmpNode();
    this.tmpDepth = this.tmpDepth + 1;
    const r = this.convert(tree, id, parsed, node);
    this.tmpDepth = this.tmpDepth - 1;
    this.buf.len = mark;
    this.stack.leave();
    return r < 0 ? 0 : node.end;
  }

  /** `parseNestedCSS`, and `calculateLoc` for the node. What has been in `parsed` is lost. Returns 0 or -1 (refused). */
  convert(tree: Tree, id: number, parsed: Parsed, node: CssNode): number {
    parsed.selectors.clear();
    parsed.values.clear();
    node.reset();
    const f = tree.f;
    const o = id * NS;
    const kind = f[o + F_KIND] | 0;
    node.kind = kind;
    node.start = f[o + F_START] | 0;
    node.hasBlock = (f[o + F_HAS_BLOCK] | 0) !== 0;
    node.beforeS = f[o + F_BEFORE_S] | 0;
    node.beforeE = f[o + F_BEFORE_E] | 0;
    node.betweenS = f[o + F_BETWEEN_S] | 0;
    node.betweenE = f[o + F_BETWEEN_E] | 0;
    node.afterS = f[o + F_AFTER_S] | 0;
    node.afterE = f[o + F_AFTER_E] | 0;
    node.afterNameS = f[o + F_AFTER_NAME_S] | 0;
    node.afterNameE = f[o + F_AFTER_NAME_E] | 0;
    node.semicolon = (f[o + F_SEMICOLON] | 0) !== 0;
    node.isNested = (f[o + F_IS_NESTED] | 0) !== 0;
    node.propS = f[o + F_PROP_S] | 0;
    node.propE = f[o + F_PROP_E] | 0;
    node.important = (f[o + F_IMPORTANT] | 0) !== 0;
    node.rawImportantS = f[o + F_RAW_IMPORTANT_S] | 0;
    node.rawImportantE = f[o + F_RAW_IMPORTANT_E] | 0;
    node.nameS = f[o + F_NAME_S] | 0;
    node.nameE = f[o + F_NAME_E] | 0;
    node.extend = (f[o + F_EXTEND] | 0) !== 0;
    node.mixin = (f[o + F_MIXIN] | 0) !== 0;
    node.isFn = (f[o + F_FUNCTION] | 0) !== 0;
    node.variable = (f[o + F_VARIABLE] | 0) !== 0;

    switch (kind) {
      case K_RULE: {
        const data0 = this.buf.data;
        const hasBetween = trimJsWhitespaceStart(data0, node.betweenS, node.betweenE) < node.betweenE;
        const selS = f[o + F_SELECTOR_S] | 0;
        const selE = f[o + F_SELECTOR_E] | 0;
        if (!hasBetween) {
          node.rawSelectorS = selS;
          node.rawSelectorE = selE;
        } else {
          node.rawSelectorS = this.concat3(selS, selE, node.betweenS, node.betweenE, 0, 0);
          node.rawSelectorE = this.cE;
        }
        if (this.isOxfmt && this.syntax === SYNTAX_SCSS && indexOfLit(this.buf.data, node.rawSelectorS, node.rawSelectorE, "#{") >= 0) {
          const at = this.withoutBlanksAtTheEndsOfInterpolations(node.rawSelectorS, node.rawSelectorE);
          node.rawSelectorS = at;
          node.rawSelectorE = this.buf.len;
        }
        // Prettier has no way to print a selector that is still a string.
        const data = this.buf.data;
        const rs = node.rawSelectorS;
        const re = node.rawSelectorE;
        if (
          trimJsWhitespaceStart(data, rs, re) >= re || (re > rs && (data[rs] | 0) === 64 && (data[re - 1] | 0) === 58)
        ) {
          return noteRefusal(MSG_RULE_WITHOUT_SELECTOR, f[o + F_START] | 0);
        }
        {
          const cleanS = f[o + F_CLEAN_SELECTOR_S] | 0;
          if (this.syntax === SYNTAX_SCSS) {
            if (cleanS >= 0) {
              node.isScssNestedProperty = isScssNestedProperty(tree.cleans.data, cleanS, f[o + F_CLEAN_SELECTOR_E] | 0);
            } else {
              node.isScssNestedProperty = isScssNestedProperty(data, selS, selE);
            }
          }
          node.selector = parsed.selectors.parse(this.buf.data, node.rawSelectorS, node.rawSelectorE, this.stack);
        }
        break;
      }
      case K_DECL:
        if (this.convertDeclaration(tree, id, node, parsed) < 0) return -1;
        break;
      case K_AT_RULE:
        if (this.convertAtRule(tree, id, node, parsed) < 0) return -1;
        break;
      default:
        break;
    }

    // `calculateLocEnd`
    const textLen = this.originalLen;
    if (node.start > textLen) node.start = textLen;
    const rawEnd = f[o + F_END] | 0;
    let end: number;
    if ((f[o + F_INLINE] | 0) !== 0) {
      // `skipEverythingButNewLine`
      let e = textLen;
      for (let i = node.start; i < textLen; i++) {
        const c = this.originalText[i] | 0;
        if (c === 10 || c === 13) { e = i; break; }
      }
      end = e;
    } else if (rawEnd >= 0) {
      end = rawEnd;
    } else {
      const lastChild = f[o + F_LAST_CHILD] | 0;
      if (kind === K_AT_RULE && lastChild === 0) {
        end = node.start + 1 + (node.nameE - node.nameS) + (node.afterNameE - node.afterNameS) + (node.rawParamsE - node.rawParamsS);
      } else if (lastChild === 0) {
        end = textLen;
      } else if (kind === K_ROOT) {
        end = this.endOf(tree, lastChild, parsed);
      } else {
        end = this.endOf(tree, lastChild, this.scratchParsed);
      }
    }
    node.end = end < textLen ? end : textLen;
    return 0;
  }

  /** `.a-#{ $b }` is `.a-#{$b}` for oxfmt, in a selector as in a value. Prettier leaves a selector as it is there.
   * Appends to the arena; returns the start. */
  private withoutBlanksAtTheEndsOfInterpolations(s: number, e: number): number {
    const data = this.buf.data;
    const start = this.buf.len;
    // copy first: the arena grows while we read
    const src = new Uint8Array(e - s);
    src.set(data.subarray(s, e));
    const out = this.buf;
    let depth = 0;
    let quote = 0;
    let at = 0;
    const n = src.length;
    while (at < n) {
      const byte = src[at] | 0;
      at = at + 1;
      if (quote !== 0 || (depth === 0 && (byte === 34 || byte === 39))) {
        quote = quote === 0 ? byte : byte === quote ? 0 : quote;
        out.push(byte);
      } else if (depth === 0 && byte === 35 && at < n && (src[at] | 0) === 123) {
        out.push(35);
        out.push(123);
        depth = 1;
        at = at + 1;
        at = at + leadingWhiteSpaceLen(src, at, n);
      } else if (depth > 0 && byte === 123) {
        depth = depth + 1;
        out.push(byte);
      } else if (depth > 0 && byte === 125) {
        depth = depth - 1;
        if (depth === 0) out.len = trimJsWhitespaceEnd(out.data, start, out.len);
        out.push(byte);
      } else {
        out.push(byte);
      }
    }
    return start;
  }

  private convertDeclaration(tree: Tree, id: number, node: CssNode, parsed: Parsed): number {
    const f = tree.f;
    const o = id * NS;
    const rawStart = f[o + F_START] | 0;
    const valueS = f[o + F_VALUE_S] | 0;
    const valueE = f[o + F_VALUE_E] | 0;
    const propLen = node.propE - node.propS;
    // `getValueRootOffset`
    const rootOffset = rawStart + propLen + (node.betweenE - node.betweenS);
    const cleanValueS = f[o + F_CLEAN_VALUE_S] | 0;
    const cleanValueE = f[o + F_CLEAN_VALUE_E] | 0;

    // A custom property set looks like a declaration.
    if (startsWithLit(this.buf.data, node.propS, node.propE, "--") && valueE > valueS && (this.buf.data[valueS] | 0) === 123) {
      let rules: Tree | null = null;
      // `trim_end(raw.clean_value.unwrap_or(value)).ends_with("}")`
      let endsWithBrace: boolean;
      if (cleanValueS >= 0) {
        const te = trimJsWhitespaceEnd(tree.cleans.data, cleanValueS, cleanValueE);
        endsWithBrace = te > cleanValueS && (tree.cleans.data[te - 1] | 0) === 125;
      } else {
        const te = trimJsWhitespaceEnd(this.buf.data, valueS, valueE);
        endsWithBrace = te > valueS && (this.buf.data[te - 1] | 0) === 125;
      }
      const end = f[o + F_END] | 0;
      if (endsWithBrace && end >= 0) {
        const limit = end < this.cssLen ? end : this.cssLen;
        const nested = new PostcssParser();
        const sub = nested.parseText(this.buf.data, limit, this.syntax, rawStart, true, PLACEHOLDER_AT_RULE);
        if (sub !== null) {
          const only = sub.f[F_FIRST_CHILD] | 0;
          if (
            only !== 0 && only === (sub.f[F_LAST_CHILD] | 0) && (sub.f[only * NS + F_KIND] | 0) === K_RULE &&
            // What is in it would not live long enough.
            sub.extraLen === 0 && this.isConvertibleSet(rawStart, sub, only, parsed)
          ) {
            rules = sub;
          }
        }
      }
      parsed.values.clear();
      if (rules !== null) {
        node.valueKind = VAL_RULE;
        node.valueTree = rules;
      } else if (cleanValueS < 0) {
        // Prettier reads `raws.value.raw`, which is only there if the value has comments.
        return noteRefusal(MSG_UNREADABLE_VALUE, rootOffset);
      } else {
        node.valueKind = VAL_PARSED;
        node.valueId = parsed.values.unknown(this.buf.data, valueS, valueE, rootOffset);
      }
      return 0;
    }

    let vs = valueS;
    let ve = valueE;
    const data = this.buf.data;
    if (trimJsWhitespaceStart(data, vs, ve) >= ve) {
      node.valueKind = VAL_TEXT;
      if (cleanValueS >= 0) {
        node.valueS = this.copy(tree.cleans.data, cleanValueS, cleanValueE);
        node.valueE = this.buf.len;
      } else {
        node.valueS = vs;
        node.valueE = ve;
      }
    } else {
      const hasBang = containsByteIn(data, vs, ve, 33);
      if (hasBang) {
        const at = findDirective(data, vs, ve, "!default");
        if (at >= 0) {
          node.scssDefault = true;
          // `Some(&value[at..]).filter(|it| trim(it) != "!default")`
          const ts = trimJsWhitespaceStart(data, at, ve);
          const te = trimJsWhitespaceEnd(data, ts, ve);
          if (eqLit(data, ts, te, "!default")) {
            node.rawScssDefaultS = -1;
          } else {
            node.rawScssDefaultS = at;
            node.rawScssDefaultE = ve;
          }
          ve = at;
        }
        const at2 = findDirective(data, vs, ve, "!global");
        if (at2 >= 0) {
          node.scssGlobal = true;
          const ts = trimJsWhitespaceStart(data, at2, ve);
          const te = trimJsWhitespaceEnd(data, ts, ve);
          if (eqLit(data, ts, te, "!global")) {
            node.rawScssGlobalS = -1;
          } else {
            node.rawScssGlobalS = at2;
            node.rawScssGlobalE = ve;
          }
          ve = at2;
        }
      }
      if (startsWithLit(data, vs, ve, "progid:")) {
        // It stays the string that `postcss` has made of it.
        node.valueKind = VAL_TEXT;
        if (cleanValueS >= 0) {
          node.valueS = this.copy(tree.cleans.data, cleanValueS, cleanValueE);
          node.valueE = this.buf.len;
        } else {
          node.valueS = valueS;
          node.valueE = valueE;
        }
        return 0;
      }
      const root = parsed.values.parse(this.buf.data, vs, ve, this.syntax, rootOffset, parsed.selectors, this.stack);
      if (root < 0) return noteRefusal(MSG_UNREADABLE_VALUE, rootOffset);
      node.valueKind = VAL_PARSED;
      node.valueId = root;
    }

    if (this.syntax === SYNTAX_LESS) {
      // `a +: b`, which merges: `/^\s*\+\s*:/`
      const d = this.buf.data;
      const spaces = leadingWhiteSpaceLen(d, node.betweenS, node.betweenE);
      const p = node.betweenS + spaces;
      if (p < node.betweenE && (d[p] | 0) === 43) {
        const after = trimJsWhitespaceStart(d, p + 1, node.betweenE);
        if (after < node.betweenE && (d[after] | 0) === 58) {
          // `node.prop.to_mut().push(b'+')`, `node.between.to_mut().remove(spaces)`
          const propS = this.copy(d, node.propS, node.propE);
          this.buf.push(43);
          node.propS = propS;
          node.propE = this.buf.len;
          // the between without the char at `spaces`
          const nb = this.buf.len;
          this.buf.append(this.buf.data, node.betweenS, node.betweenS + spaces);
          this.buf.append(this.buf.data, node.betweenS + spaces + 1, node.betweenE);
          node.betweenS = nb;
          node.betweenE = this.buf.len;
        }
      }
      // `&:extend(.a)`
      const d2 = this.buf.data;
      if (startsWithLit(d2, vs, ve, "extend(")) {
        node.extend = node.extend || eqLit(d2, node.betweenS, node.betweenE, ":");
        if (node.extend) {
          node.valueKind = VAL_NONE;
          const selS = vs + 7;
          const selE = ve > selS ? ve - 1 : selS;
          node.selector = parsed.selectors.parse(d2, selS, selE > ve ? ve : selE, this.stack);
        }
      }
    }
    return 0;
  }

  private convertAtRule(tree: Tree, id: number, node: CssNode, parsed: Parsed): number {
    const f = tree.f;
    const o = id * NS;
    const rawStart = f[o + F_START] | 0;
    const data0 = this.buf.data;
    const afterNameS = f[o + F_AFTER_NAME_S] | 0;
    const afterNameE = f[o + F_AFTER_NAME_E] | 0;
    const rawParamsS0 = f[o + F_PARAMS_S] | 0;
    const rawParamsE0 = f[o + F_PARAMS_E] | 0;
    const hasAfterName = trimJsWhitespaceStart(data0, afterNameS, afterNameE) < afterNameE;
    const hasBetween = trimJsWhitespaceStart(data0, node.betweenS, node.betweenE) < node.betweenE;
    // `trim(concat([after_name?, params, between?]))`
    const cs = this.concat3(
      hasAfterName ? afterNameS : 0,
      hasAfterName ? afterNameE : 0,
      rawParamsS0,
      rawParamsE0,
      hasBetween ? node.betweenS : 0,
      hasBetween ? node.betweenE : 0,
    );
    const ce = this.cE;
    const paramsOwned = this.cOwned;
    const data1 = this.buf.data;
    const ps = trimJsWhitespaceStart(data1, cs, ce);
    const pe = trimJsWhitespaceEnd(data1, ps, ce);
    node.rawParamsS = ps;
    node.rawParamsE = pe;
    if (this.syntax === SYNTAX_LESS) {
      const r = this.convertLessAtRule(tree, id, node, parsed);
      if (r < 0) return -1;
      if (r === 1) return 0;
    }
    const nameS = node.nameS;
    const nameE = node.nameE;
    const rootOffset = valueRootOffset(this.buf.data, node);
    const cleanParamsS = f[o + F_CLEAN_PARAMS_S] | 0;
    const cleanParamsE = f[o + F_CLEAN_PARAMS_E] | 0;

    if (this.syntax === SYNTAX_CSS && eqLit(this.buf.data, nameS, nameE, "custom-selector")) {
      // `node.params.match(/:--\S+\s+/)[0].trim()`
      let csS: number;
      let csE: number;
      if (cleanParamsS >= 0) {
        csS = this.copy(tree.cleans.data, cleanParamsS, cleanParamsE);
        csE = this.buf.len;
      } else {
        csS = rawParamsS0;
        csE = rawParamsE0;
      }
      const d = this.buf.data;
      const start = indexOfLit(d, csS, csE, ":--");
      if (start < 0) return noteRefusal(MSG_UNREADABLE_AT_RULE, rawStart);
      let nameLen = -1;
      for (let i = start; i < csE; i++) {
        if (isJsWsByte(d[i] | 0)) { nameLen = i - start; break; }
      }
      if (nameLen < 0) return noteRefusal(MSG_UNREADABLE_AT_RULE, rawStart);
      if (nameLen <= 3) return noteRefusal(MSG_UNREADABLE_AT_RULE, rawStart);
      // `slice(&clean, start, start + name_len)`
      node.customSelectorS = start;
      node.customSelectorE = start + nameLen;
      // `trim(&slice(&clean, name_len, clean.len()))`: note: from `name_len`, not from `start + name_len`
      const rs = csS + nameLen;
      const ts = trimJsWhitespaceStart(d, rs < csE ? rs : csE, csE);
      const te = trimJsWhitespaceEnd(d, ts, csE);
      node.selector = parsed.selectors.parse(d, ts, te, this.stack);
      return 0;
    }
    if (pe <= ps) return 0;
    const d = this.buf.data;
    const nameLower = nameE - nameS;
    void nameLower;
    if (eqLit(d, nameS, nameE, "warn") || eqLit(d, nameS, nameE, "error")) {
      // For oxfmt what they say is an expression like any other.
      let done = false;
      if (this.isOxfmt) {
        const v = parsed.values.parse(this.buf.data, ps, pe, this.syntax, rootOffset, parsed.selectors, this.stack);
        if (v >= 0) {
          node.valueKind = VAL_PARSED;
          node.valueId = v;
          done = true;
        }
      }
      if (!done) {
        node.paramsKind = PAR_UNKNOWN;
        node.paramsS = ps;
        node.paramsE = pe;
      }
    } else if (eqLit(d, nameS, nameE, "extend") || eqLit(d, nameS, nameE, "nest")) {
      node.selector = parsed.selectors.parse(d, ps, pe, this.stack);
    } else if (eqLit(d, nameS, nameE, "at-root")) {
      // `/^\(\s*(?:without|with)\s*:.+\)$/s`
      let isQuery = false;
      if (pe - ps >= 2 && (d[ps] | 0) === 40 && (d[pe - 1] | 0) === 41) {
        const inner = trimJsWhitespaceStart(d, ps + 1, pe - 1);
        let rest = -1;
        if (startsWithLit(d, inner, pe - 1, "without")) rest = inner + 7;
        else if (startsWithLit(d, inner, pe - 1, "with")) rest = inner + 4;
        if (rest >= 0) {
          const after = trimJsWhitespaceStart(d, rest, pe - 1);
          isQuery = after < pe - 1 && (d[after] | 0) === 58 && after + 1 < pe - 1;
        }
      }
      if (isQuery) {
        const v = parsed.values.parse(d, ps, pe, this.syntax, rootOffset, parsed.selectors, this.stack);
        if (v < 0) return noteRefusal(MSG_UNREADABLE_AT_RULE, rawStart);
        node.paramsKind = PAR_VALUE;
        node.paramsId = v;
      } else {
        node.selector = parsed.selectors.parse(d, ps, pe, this.stack);
      }
    } else if (eqLitIgnoreCase(d, nameS, nameE, "import") || eqLitIgnoreCase(d, nameS, nameE, "use") || eqLitIgnoreCase(d, nameS, nameE, "forward")) {
      const v = parsed.values.parse(d, ps, pe, this.syntax, rootOffset, parsed.selectors, this.stack);
      if (v < 0) return noteRefusal(MSG_UNREADABLE_AT_RULE, rawStart);
      node.paramsKind = PAR_VALUE;
      node.paramsId = v;
    } else if (this.isValueAtRule(d, nameS, nameE)) {
      let ts = ps;
      let te = pe;
      const mark = this.buf.len;
      const dots = this.moveSpaceBehindDots(ts, te);
      if (dots >= 0) {
        ts = dots;
        te = this.buf.len;
      }
      const par = this.moveSpaceBehindParenthesis(ts, te);
      if (par >= 0) {
        ts = par;
        te = this.buf.len;
      }
      void mark;
      const v = parsed.values.parse(this.buf.data, ts, te, this.syntax, rootOffset, parsed.selectors, this.stack);
      if (v < 0) return noteRefusal(MSG_UNREADABLE_AT_RULE, rawStart);
      node.valueKind = VAL_PARSED;
      node.valueId = v;
    } else if (eqLitIgnoreCase(d, nameS, nameE, "media") || eqLitIgnoreCase(d, nameS, nameE, "custom-media")) {
      if (indexOfLit(d, ps, pe, "#{") >= 0) {
        // What Prettier makes of it is lost, and the string of `postcss` stays.
        node.paramsKind = PAR_TEXT;
        if (cleanParamsS >= 0) {
          node.paramsS = this.copy(tree.cleans.data, cleanParamsS, cleanParamsE);
          node.paramsE = this.buf.len;
        } else {
          node.paramsS = rawParamsS0;
          node.paramsE = rawParamsE0;
        }
      } else if (!paramsOwned) {
        const root = parseMedia(this.buf.data, ps, pe);
        if (root >= 0) {
          node.paramsKind = PAR_MEDIA;
          node.paramsId = root;
        } else {
          node.paramsKind = PAR_UNKNOWN;
          node.paramsS = ps;
          node.paramsE = pe;
        }
      } else {
        node.paramsKind = PAR_UNKNOWN;
        node.paramsS = ps;
        node.paramsE = pe;
      }
    } else {
      node.paramsKind = PAR_TEXT;
      node.paramsS = ps;
      node.paramsE = pe;
    }
    return 0;
  }

  private isValueAtRule(d: Uint8Array, s: number, e: number): boolean {
    return (
      eqLit(d, s, e, "namespace") || eqLit(d, s, e, "supports") || eqLit(d, s, e, "if") || eqLit(d, s, e, "else") ||
      eqLit(d, s, e, "for") || eqLit(d, s, e, "each") || eqLit(d, s, e, "while") || eqLit(d, s, e, "debug") ||
      eqLit(d, s, e, "mixin") || eqLit(d, s, e, "include") || eqLit(d, s, e, "function") || eqLit(d, s, e, "return") ||
      eqLit(d, s, e, "define-mixin") || eqLit(d, s, e, "add-mixin")
    );
  }

  /** `params.replace(/(\$\S+?)(\s+)?\.{3}/, "$1...$2")`: if it changes, the new text is appended to the arena and its start is
   * returned (the end is `buf.len`), else -1. */
  private moveSpaceBehindDots(s: number, e: number): number {
    const data = this.buf.data;
    let from = s;
    while (true) {
      const dollar = indexOfByteIn(data, from, e, 36);
      if (dollar < 0) return -1;
      // `\S+?` takes as little as it can, and no white space.
      let at = dollar + 1;
      while (at < e && !isJsWsByte(data[at] | 0)) {
        at = at + 1;
        const spaces = leadingWhiteSpaceLen(data, at, e);
        if (startsWithLit(data, at + spaces, e, "...")) {
          if (spaces === 0) return -1;
          const start = this.buf.len;
          this.buf.append(this.buf.data, s, at);
          this.buf.push(46);
          this.buf.push(46);
          this.buf.push(46);
          this.buf.append(this.buf.data, at, at + spaces);
          this.buf.append(this.buf.data, at + spaces + 3, e);
          return start;
        }
      }
      // Another `$` before the white space would be followed by the same, from further on.
      from = at;
    }
  }

  /** `params.replace(/^(?!if)([^"'\s(]+)(\s+)\(/, "$1($2")` */
  private moveSpaceBehindParenthesis(s: number, e: number): number {
    const data = this.buf.data;
    if (startsWithLit(data, s, e, "if")) return -1;
    let nameLen = -1;
    for (let i = s; i < e; i++) {
      const c = data[i] | 0;
      if (c === 34 || c === 39 || c === 40 || isJsWsByte(c)) { nameLen = i - s; break; }
    }
    if (nameLen <= 0) return -1;
    const restS = s + nameLen;
    const spaces = leadingWhiteSpaceLen(data, restS, e);
    if (spaces === 0 || restS + spaces >= e || (data[restS + spaces] | 0) !== 40) return -1;
    const start = this.buf.len;
    this.buf.append(this.buf.data, s, s + nameLen);
    this.buf.push(40);
    this.buf.append(this.buf.data, restS, restS + spaces);
    this.buf.append(this.buf.data, restS + spaces + 1, e);
    return start;
  }

  /** What `parseNestedCSS` does with an at-rule of Less only. Returns 1 if that is all, 0 if not, -1 (refused). */
  private convertLessAtRule(tree: Tree, id: number, node: CssNode, parsed: Parsed): number {
    const f = tree.f;
    const o = id * NS;
    const rawStart = f[o + F_START] | 0;
    const paramsS0 = f[o + F_PARAMS_S] | 0;
    const paramsE0 = f[o + F_PARAMS_E] | 0;
    const cleanParamsS = f[o + F_CLEAN_PARAMS_S] | 0;
    const cleanParamsE = f[o + F_CLEAN_PARAMS_E] | 0;
    // `node.params`
    let cpS: number;
    let cpE: number;
    if (cleanParamsS >= 0) {
      cpS = this.copy(tree.cleans.data, cleanParamsS, cleanParamsE);
      cpE = this.buf.len;
    } else {
      cpS = paramsS0;
      cpE = paramsE0;
    }
    // For `postcss-less` it is a variable, and `node.value` is a string.
    if ((f[o + F_VARIABLE] | 0) !== 0) {
      const skip = f[o + F_VALUE_SKIPS] | 0;
      const vs = cpS + skip < cpE ? cpS + skip : cpE;
      let ve = cpE;
      const d = this.buf.data;
      if (trimJsWhitespaceStart(d, vs, ve) < ve) {
        let at = findDirective(d, vs, ve, "!default");
        if (at >= 0) ve = at;
        at = findDirective(d, vs, ve, "!global");
        if (at >= 0) ve = at;
        const v = parsed.values.parse(this.buf.data, vs, ve, this.syntax, valueRootOffset(this.buf.data, node), parsed.selectors, this.stack);
        if (v < 0) return noteRefusal(MSG_UNREADABLE_AT_RULE, rawStart);
        node.valueKind = VAL_PARSED;
        node.valueId = v;
      }
    }

    if ((f[o + F_MIXIN] | 0) !== 0) {
      // `raws.identifier + name + raws.afterName + raws.params`
      const start = this.buf.len;
      const d = this.buf.data;
      this.buf.append(d, f[o + F_IDENTIFIER_S] | 0, f[o + F_IDENTIFIER_E] | 0);
      this.buf.append(this.buf.data, node.nameS, node.nameE);
      this.buf.append(this.buf.data, node.afterNameS, node.afterNameE);
      this.buf.append(this.buf.data, node.rawParamsS, node.rawParamsE);
      node.selector = parsed.selectors.parse(this.buf.data, start, this.buf.len, this.stack);
      return 1;
    }
    if ((f[o + F_FUNCTION] | 0) !== 0) {
      node.paramsKind = PAR_TEXT;
      node.paramsS = cpS;
      node.paramsE = cpE;
      return 1;
    }

    // `@color:blue;`
    const d = this.buf.data;
    const colon = indexOfByteIn(d, node.nameS, node.nameE, 58);
    if (colon >= 0) {
      node.variable = true;
      const restS = colon + 1;
      const restE = node.nameE;
      node.nameE = colon;
      let vs: number;
      let ve: number;
      if (cpE <= cpS) {
        vs = restS;
        ve = restE;
      } else if (node.afterNameE <= node.afterNameS && cleanParamsS < 0) {
        vs = colon + 1;
        ve = f[o + F_PARAMS_E] | 0;
      } else {
        vs = this.buf.len;
        this.buf.append(this.buf.data, restS, restE);
        this.buf.append(this.buf.data, cpS, cpE);
        ve = this.buf.len;
      }
      const v = parsed.values.parse(this.buf.data, vs, ve, this.syntax, valueRootOffset(this.buf.data, node), parsed.selectors, this.stack);
      if (v < 0) return noteRefusal(MSG_UNREADABLE_AT_RULE, rawStart);
      node.valueKind = VAL_PARSED;
      node.valueId = v;
    }
    // `@color :blue;`
    const dd = this.buf.data;
    if (
      !(eqLit(dd, node.nameS, node.nameE, "page") || eqLit(dd, node.nameS, node.nameE, "nest") || eqLit(dd, node.nameS, node.nameE, "keyframes")) &&
      cpE > cpS && (dd[cpS] | 0) === 58
    ) {
      node.variable = true;
      const rawAfterNameS = f[o + F_AFTER_NAME_S] | 0;
      const rawAfterNameE = f[o + F_AFTER_NAME_E] | 0;
      if (rawAfterNameE <= rawAfterNameS) {
        node.afterNameS = paramsS0;
        node.afterNameE = paramsS0 + 1;
      } else {
        node.afterNameS = rawAfterNameS;
        node.afterNameE = rawAfterNameE + 1;
      }
      if (cpE - cpS > 1) {
        const v = parsed.values.parse(this.buf.data, cpS + 1, cpE, this.syntax, valueRootOffset(this.buf.data, node), parsed.selectors, this.stack);
        if (v < 0) return noteRefusal(MSG_UNREADABLE_AT_RULE, rawStart);
        node.valueKind = VAL_PARSED;
        node.valueId = v;
      }
    }
    return node.variable ? 1 : 0;
  }
}

void K_COMMENT;
void K_DECL;
void SK_UNKNOWN;
void mediaTree;
void isAsciiDigit;
void lowerByte;
void endsWithLit;
