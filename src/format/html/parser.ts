// Port of vendor/bun/src/format/html/parser.rs: `angular-html-parser` 10.12 `ml_parser/parser.ts`.
import { I32Vec } from "../../base/i32vec.ts";
import { Stack } from "../../base/stack.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  A_STRIDE,
  AF_HAS_VSP,
  AF_NAME_E,
  AF_NAME_S,
  AF_NSP_E,
  AF_NSP_S,
  AF_NS_E,
  AF_NS_S,
  AF_SPAN_E,
  AF_SPAN_S,
  AF_VSP_E,
  AF_VSP_S,
  F_ATTR_E,
  F_ATTR_S,
  F_DEF,
  F_NAME_E,
  F_NAME_S,
  F_NSP_E,
  F_NSP_S,
  F_NS_E,
  F_NS_S,
  F_SPAN_E,
  F_SPAN_S,
  F_TC_E,
  F_TC_S,
  F_VAL_E,
  F_VAL_S,
  HTree,
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
  K_ROOT,
  K_TEXT,
  STRIDE,
  TC_STRIDE,
  TCF_SINGLE,
  TCF_SPAN_E,
  TCF_SPAN_S,
  TCF_VAL_E,
  TCF_VAL_S,
  addAttr,
  addNode,
  addStartTagComment,
  appendChild,
  hasChildren,
  kindOf,
  nameStart,
  nameEnd,
  nsEnd,
  nsStart,
  nGet,
  nSet,
  setEndSpan,
  clearEndSpan,
  setName,
  setNamespace,
  setParameters,
  setStartSpan,
  setValue,
  poolAppend,
  internLit,
} from "./ast.ts";
import {
  DEF_DEFAULT,
  defCanSelfClose,
  defClosedByParent,
  defIgnoreFirstLf,
  defImplicitNamespace,
  defIsClosedByChild,
  defIsVoid,
  defPreventNamespaceInheritance,
  eqLit,
  tagDefinition,
} from "./data.ts";
import {
  EK_END_TAG_OF_VOID_ELEMENT,
  EK_ICU_WITHOUT_CLOSING_BRACE,
  EK_ICU_WITHOUT_OPENING_BRACE,
  EK_INCOMPLETE_BLOCK,
  EK_INCOMPLETE_LET,
  EK_LET_NOT_TERMINATED,
  EK_LET_WITHOUT_VALUE,
  EK_OPENING_TAG_NOT_TERMINATED,
  EK_SELF_CLOSED,
  EK_TEXT_BEHIND_NUL,
  EK_UNCLOSED_BLOCK,
  EK_UNEXPECTED_CLOSING_BLOCK,
  EK_UNEXPECTED_CLOSING_TAG,
  ErrorList,
  NAME_NULL,
} from "./error.ts";
import {
  PK_COMMENT,
  PK_DEFAULT_NEVER,
  PK_ELSE_IF,
  PK_NAME,
  PK_NONE,
  PK_VALUE,
  RAW_NONE,
  TKF_END,
  TKF_KIND,
  TKF_P0,
  TKF_P1,
  TKF_P2,
  TKF_P3,
  TKF_PK,
  TKF_START,
  TK_STRIDE,
  TT_ATTR_NAME,
  TT_ATTR_QUOTE,
  TT_ATTR_VALUE_INTERPOLATION,
  TT_ATTR_VALUE_TEXT,
  TT_BLOCK_CLOSE,
  TT_BLOCK_OPEN_END,
  TT_BLOCK_OPEN_START,
  TT_BLOCK_PARAMETER,
  TT_CDATA_END,
  TT_CDATA_START,
  TT_COMMENT_END,
  TT_COMMENT_START,
  TT_DOC_TYPE_END,
  TT_DOC_TYPE_START,
  TT_ENCODED_ENTITY,
  TT_EOF,
  TT_ESCAPABLE_RAW_TEXT,
  TT_EXPANSION_CASE_EXP_END,
  TT_EXPANSION_CASE_EXP_START,
  TT_EXPANSION_CASE_VALUE,
  TT_EXPANSION_FORM_END,
  TT_EXPANSION_FORM_START,
  TT_INCOMPLETE_BLOCK_OPEN,
  TT_INCOMPLETE_LET,
  TT_INCOMPLETE_TAG_OPEN,
  TT_INTERPOLATION,
  TT_IN_ELEMENT_COMMENT,
  TT_LET_END,
  TT_LET_START,
  TT_LET_VALUE,
  TT_RAW_TEXT,
  TT_TAG_CLOSE,
  TT_TAG_OPEN_END,
  TT_TAG_OPEN_END_VOID,
  TT_TAG_OPEN_START,
  TT_TEXT,
  lx,
  tokenize,
} from "./lexer.ts";

/** The options of `parse`. */
export class ParseOptions {
  /** Prettier's `ParseOptions.name`: a `P_*`. */
  name: number = 0;
  normalizeTagName: boolean = false;
  normalizeAttributeName: boolean = false;
  isTagNameCaseSensitive: boolean = false;
  tokenizeAngularBlocks: boolean = false;
  tokenizeLet: boolean = false;
  canSelfClose: boolean = false;
  allowHtmComponentClosingTags: boolean = false;
  allowStartTagComments: boolean = false;
  copy(): ParseOptions {
    const o = new ParseOptions();
    o.name = this.name;
    o.normalizeTagName = this.normalizeTagName;
    o.normalizeAttributeName = this.normalizeAttributeName;
    o.isTagNameCaseSensitive = this.isTagNameCaseSensitive;
    o.tokenizeAngularBlocks = this.tokenizeAngularBlocks;
    o.tokenizeLet = this.tokenizeLet;
    o.canSelfClose = this.canSelfClose;
    o.allowHtmComponentClosingTags = this.allowHtmComponentClosingTags;
    o.allowStartTagComments = this.allowStartTagComments;
    return o;
  }
}

export class ParseResult {
  /** Its children are the `rootNodes`. */
  root: number = 0;
  errors: ErrorList = new ErrorList();
  isNestedTooDeeply: boolean = false;
}

/** `advance_if` found nothing. */
const NO_TOKEN = -2;
/** The token that stands for the end: the one at `eof*`. */
const EOF_TOKEN = -1;

/** `definition_of(name, is_case_sensitive)`: the definition id of the name `buf[s, e)`. */
let lowerScratch = new Uint8Array(64);
export function definitionOf(buf: Uint8Array, s: number, e: number, isCaseSensitive: boolean): number {
  if (isCaseSensitive) return tagDefinition(buf, s, e);
  let hasUpper = false;
  for (let i = s; i < e; i++) {
    const b = buf[i] | 0;
    if (b >= 65 && b <= 90) {
      hasUpper = true;
      break;
    }
  }
  if (!hasUpper) return tagDefinition(buf, s, e);
  const n = e - s;
  if (lowerScratch.length < n) lowerScratch = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const b = buf[s + i] | 0;
    lowerScratch[i] = b >= 65 && b <= 90 ? b + 32 : b;
  }
  return tagDefinition(lowerScratch, 0, n);
}

class Shared {
  /** Where the cases of ICU expressions end that have been passed on the way to the end of one around them: by the index of their first
   * token, the index of the token that ends them. */
  caseEnds: Map<number, number> = new Map<number, number>();
  stack: Stack = Stack.forTree();
}

class TreeBuilder {
  t: HTree;
  text: Uint8Array;
  tokens: Int32Array;
  index: number;
  /** Where the tokens end that this is about, and what comes in the place of the token there. */
  end: number;
  eofStart: number;
  eofEnd: number;
  containerStack: I32Vec;
  /** What is in no container goes here. */
  root: number;
  errors: ErrorList;
  canSelfClose: boolean;
  allowHtmComponentClosingTags: boolean;
  isTagNameCaseSensitive: boolean;
  isNestedTooDeeply: boolean;
  shared: Shared;
  // `full_name`'s result
  fnPrefixS: number = 0;
  fnPrefixE: number = 0;
  fnNameS: number = 0;
  fnNameE: number = 0;
  fnDef: number = 0;
  // `block`'s result
  blkSpanS: number = 0;
  blkSpanE: number = 0;
  blkNameSpanS: number = 0;
  blkNameSpanE: number = 0;
  blkNameS: number = 0;
  blkNameE: number = 0;
  blkParams: number = -1;
  elseIfAt: number = -1;
  defaultNeverAt: number = -1;

  constructor(t: HTree, text: Uint8Array, tokens: Int32Array, index: number, end: number, eofStart: number, eofEnd: number, root: number, shared: Shared) {
    this.t = t;
    this.text = text;
    this.tokens = tokens;
    this.index = index;
    this.end = end;
    this.eofStart = eofStart;
    this.eofEnd = eofEnd;
    this.containerStack = new I32Vec(16);
    this.root = root;
    this.errors = new ErrorList();
    this.canSelfClose = false;
    this.allowHtmComponentClosingTags = false;
    this.isTagNameCaseSensitive = false;
    this.isNestedTooDeeply = false;
    this.shared = shared;
  }

  // ───────────────────────────── tokens ─────────────────────────────

  /** The index of the token that is next, or `EOF_TOKEN`. */
  peekT(): number {
    if (this.index < this.end && this.index < lx.tokenCount) return this.index;
    return EOF_TOKEN;
  }

  tkKind(ti: number): number {
    return ti === EOF_TOKEN ? TT_EOF : this.tokens[ti * TK_STRIDE + TKF_KIND] | 0;
  }
  tkStart(ti: number): number {
    return ti === EOF_TOKEN ? this.eofStart : this.tokens[ti * TK_STRIDE + TKF_START] | 0;
  }
  tkEnd(ti: number): number {
    return ti === EOF_TOKEN ? this.eofEnd : this.tokens[ti * TK_STRIDE + TKF_END] | 0;
  }
  tkPk(ti: number): number {
    return ti === EOF_TOKEN ? PK_NONE : this.tokens[ti * TK_STRIDE + TKF_PK] | 0;
  }
  tkP(ti: number, k: number): number {
    return ti === EOF_TOKEN ? 0 : this.tokens[ti * TK_STRIDE + TKF_P0 + k] | 0;
  }

  peekKind(): number {
    return this.tkKind(this.peekT());
  }

  advance(): number {
    const token = this.peekT();
    if (this.index < this.end) this.index = this.index + 1;
    return token;
  }

  advanceIf(kind: number): number {
    return this.peekKind() === kind ? this.advance() : NO_TOKEN;
  }

  /** `_getTagDefinition(node)`: the definition of an element, -1 for the others. */
  definitionOfNode(id: number): number {
    return kindOf(this.t, id) === K_ELEMENT ? nGet(this.t, id, F_DEF) : -1;
  }

  error(at: number, kind: number, nameS: number, nameE: number): void {
    this.errors.push(at, kind, 0, 0, nameS, nameE, false);
  }

  /** The same for a message with the name of an element in it. */
  errorAbout(at: number, kind: number, prefixS: number, prefixE: number, nameS: number, nameE: number): void {
    this.errors.push(at, kind, prefixS, prefixE, nameS, nameE, false);
  }

  build(): void {
    const t = this.t;
    while (this.peekKind() !== TT_EOF && !this.isNestedTooDeeply) {
      const kind = this.peekKind();
      if (
        kind === TT_TAG_CLOSE ||
        kind === TT_CDATA_START ||
        kind === TT_COMMENT_START ||
        kind === TT_TEXT ||
        kind === TT_RAW_TEXT ||
        kind === TT_ESCAPABLE_RAW_TEXT ||
        kind === TT_BLOCK_OPEN_START ||
        kind === TT_BLOCK_CLOSE ||
        kind === TT_INCOMPLETE_BLOCK_OPEN ||
        kind === TT_LET_START ||
        kind === TT_INCOMPLETE_LET
      ) {
        this.closeVoidElement();
      }
      const token = this.advance();
      switch (kind) {
        case TT_TAG_OPEN_START:
        case TT_INCOMPLETE_TAG_OPEN:
          this.consumeElementStartTag(token);
          break;
        case TT_TAG_CLOSE:
          this.consumeElementEndTag(token);
          break;
        case TT_CDATA_START:
          this.consumeCdata(token);
          break;
        case TT_COMMENT_START:
          this.consumeComment(token);
          break;
        case TT_TEXT:
        case TT_RAW_TEXT:
        case TT_ESCAPABLE_RAW_TEXT:
          this.consumeText(token);
          break;
        case TT_EXPANSION_FORM_START:
          this.consumeExpansion(token);
          break;
        case TT_BLOCK_OPEN_START:
          this.consumeBlockOpen(token);
          break;
        case TT_BLOCK_CLOSE:
          this.consumeBlockClose(token);
          break;
        case TT_INCOMPLETE_BLOCK_OPEN:
          this.consumeIncompleteBlock(token);
          break;
        case TT_LET_START:
          this.consumeLet(token);
          break;
        case TT_DOC_TYPE_START:
          this.consumeDocType(token);
          break;
        case TT_INCOMPLETE_LET: {
          let s = 0;
          let e = 0;
          if (this.tkPk(token) === PK_VALUE) {
            s = this.tkP(token, 0);
            e = this.tkP(token, 1);
          }
          this.error(this.tkStart(token), EK_INCOMPLETE_LET, s, e);
          break;
        }
        default:
          break;
      }
    }
    const stack = this.containerStack;
    for (let i = 0; i < stack.len; i++) {
      const container = stack.data[i] | 0;
      if (kindOf(t, container) === K_ANGULAR_CONTROL_FLOW_BLOCK) {
        // `full_name_of(container).name`: a borrowed name.
        this.error(nGet(t, container, F_SPAN_S), EK_UNCLOSED_BLOCK, nameStart(t, container), nameEnd(t, container));
      }
    }
  }

  /** The container that is open, -1: none. */
  container(): number {
    const v = this.containerStack;
    return v.len > 0 ? v.data[v.len - 1] | 0 : -1;
  }

  closestElementLikeParent(): number {
    const v = this.containerStack;
    for (let i = v.len - 1; i >= 0; i--) {
      const id = v.data[i] | 0;
      if (kindOf(this.t, id) === K_ELEMENT) return id;
    }
    return -1;
  }

  /** Adds `id`, which is a node that is nowhere, to the container. */
  addToParent(id: number): number {
    const c = this.container();
    appendChild(this.t, c >= 0 ? c : this.root, id);
    return id;
  }

  /** Whether a line feed at the start of a text in `parent` does not count. */
  ignoresFirstLf(parent: number): boolean {
    if (parent < 0) return false;
    if (hasChildren(this.t, parent)) return false;
    const d = this.definitionOfNode(parent);
    return d >= 0 && defIgnoreFirstLf(d);
  }

  consumeCdata(startToken: number): void {
    const text = this.advance();
    let vs = this.tkStart(text);
    const ve = this.tkEnd(text);
    if (vs < ve && (this.text[vs] | 0) === 10 && this.ignoresFirstLf(this.closestElementLikeParent())) vs = vs + 1;
    const endToken = this.advanceIf(TT_CDATA_END);
    const end = endToken !== NO_TOKEN ? this.tkEnd(endToken) : this.tkEnd(text);
    const id = addNode(this.t, K_CDATA, this.tkStart(startToken), end);
    setValue(this.t, id, vs, ve);
    this.addToParent(id);
  }

  consumeComment(token: number): void {
    this.advanceIf(TT_RAW_TEXT);
    const endToken = this.advanceIf(TT_COMMENT_END);
    const end = endToken !== NO_TOKEN ? this.tkEnd(endToken) : this.tkEnd(token);
    this.addToParent(addNode(this.t, K_COMMENT, this.tkStart(token), end));
  }

  consumeDocType(startToken: number): void {
    const text = this.advanceIf(TT_RAW_TEXT);
    const endToken = this.advanceIf(TT_DOC_TYPE_END);
    let end: number;
    if (endToken !== NO_TOKEN) end = this.tkEnd(endToken);
    else if (text !== NO_TOKEN) end = this.tkEnd(text);
    else end = this.tkEnd(startToken);
    const id = addNode(this.t, K_DOC_TYPE, this.tkStart(startToken), end);
    if (text !== NO_TOKEN) {
      const s = trimJsWhitespaceStart(this.text, this.tkStart(text), this.tkEnd(text));
      const e = trimJsWhitespaceEnd(this.text, s, this.tkEnd(text));
      setValue(this.t, id, s, e);
    }
    this.addToParent(id);
  }

  /** `value_of(token)` into `voS`, `voE`. */
  voS: number = 0;
  voE: number = 0;
  valueOf(token: number): void {
    const pk = this.tkPk(token);
    if (pk === PK_VALUE) {
      this.voS = this.tkP(token, 0);
      this.voE = this.tkP(token, 1);
    } else if (pk === PK_ELSE_IF) {
      if (this.elseIfAt < 0) this.elseIfAt = internLit(this.t, "else if");
      this.voS = this.elseIfAt;
      this.voE = this.elseIfAt + 7;
    } else if (pk === PK_DEFAULT_NEVER) {
      if (this.defaultNeverAt < 0) this.defaultNeverAt = internLit(this.t, "default never");
      this.voS = this.defaultNeverAt;
      this.voE = this.defaultNeverAt + 13;
    } else {
      this.voS = this.tkStart(token);
      this.voE = this.tkEnd(token);
    }
  }

  consumeExpansion(token: number): void {
    const switchValue = this.advance();
    const kind = this.advance();
    const expansion = addNode(this.t, K_ANGULAR_ICU_EXPRESSION, this.tkStart(token), this.tkEnd(token));
    while (this.peekKind() === TT_EXPANSION_CASE_VALUE) {
      const c = this.parseExpansionCase();
      if (c < 0) return;
      appendChild(this.t, expansion, c);
    }
    if (this.peekKind() !== TT_EXPANSION_FORM_END) {
      this.error(this.tkStart(this.peekT()), EK_ICU_WITHOUT_CLOSING_BRACE, 0, 0);
      return;
    }
    const end = this.tkEnd(this.advance());
    nSet(this.t, expansion, F_SPAN_E, end);
    setValue(this.t, expansion, this.tkStart(switchValue), this.tkEnd(switchValue));
    setName(this.t, expansion, this.tkStart(kind), this.tkEnd(kind));
    const c = this.container();
    appendChild(this.t, c >= 0 ? c : this.root, expansion);
  }

  /** Returns the case, or -1. */
  parseExpansionCase(): number {
    const value = this.advance();
    if (this.peekKind() !== TT_EXPANSION_CASE_EXP_START) {
      this.error(this.tkStart(this.peekT()), EK_ICU_WITHOUT_OPENING_BRACE, 0, 0);
      return -1;
    }
    const start = this.advance();
    const first = this.index;
    if (!this.skipExpansionExpTokens(start)) return -1;
    const last = this.index;
    const end = this.advance();
    if (!this.shared.stack.enter()) {
      this.isNestedTooDeeply = true;
      return -1;
    }
    const id = addNode(this.t, K_ANGULAR_ICU_CASE, this.tkStart(value), this.tkEnd(end));
    this.valueOf(value);
    setValue(this.t, id, this.voS, this.voE);
    const builder = new TreeBuilder(this.t, this.text, this.tokens, first, last, this.tkStart(end), this.tkEnd(end), id, this.shared);
    builder.canSelfClose = this.canSelfClose;
    builder.allowHtmComponentClosingTags = this.allowHtmComponentClosingTags;
    builder.isTagNameCaseSensitive = this.isTagNameCaseSensitive;
    builder.build();
    this.shared.stack.leave();
    if (builder.isNestedTooDeeply) this.isNestedTooDeeply = true;
    if (builder.errors.count > 0) {
      appendErrors(this.errors, builder.errors);
      return -1;
    }
    return id;
  }

  /** `_collectExpansionExpTokens`: goes on to the token that ends the case. Returns whether it has. */
  skipExpansionExpTokens(start: number): boolean {
    const caseEnds = this.shared.caseEnds;
    // It is in a case that has been gone through, and nothing was wrong in that.
    const known = caseEnds.get(this.index);
    if (known !== undefined) {
      this.index = known;
      return true;
    }
    // What is open, and the index of the first token in it.
    const stack = new I32Vec(8);
    stack.push(TT_EXPANSION_CASE_EXP_START);
    stack.push(this.index);
    for (;;) {
      const kind = this.peekKind();
      if (kind === TT_EXPANSION_FORM_START || kind === TT_EXPANSION_CASE_EXP_START) {
        stack.push(kind);
        stack.push(this.index + 1);
      }
      if (kind === TT_EXPANSION_CASE_EXP_END) {
        if (stack.len === 0 || (stack.data[stack.len - 2] | 0) !== TT_EXPANSION_CASE_EXP_START) {
          this.error(this.tkStart(start), EK_ICU_WITHOUT_CLOSING_BRACE, 0, 0);
          return false;
        }
        caseEnds.set(stack.data[stack.len - 1] | 0, this.index);
        stack.len = stack.len - 2;
        if (stack.len === 0) return true;
      }
      if (kind === TT_EXPANSION_FORM_END) {
        if (stack.len === 0 || (stack.data[stack.len - 2] | 0) !== TT_EXPANSION_FORM_START) {
          this.error(this.tkStart(start), EK_ICU_WITHOUT_CLOSING_BRACE, 0, 0);
          return false;
        }
        stack.len = stack.len - 2;
      }
      if (kind === TT_EOF) {
        this.error(this.tkStart(start), EK_ICU_WITHOUT_CLOSING_BRACE, 0, 0);
        return false;
      }
      this.advance();
    }
  }

  consumeText(token: number): void {
    const start = this.tkStart(token);
    let end = this.tkEnd(token);
    let len = end - start;
    if (len > 0 && (this.text[start] | 0) === 10 && this.ignoresFirstLf(this.container())) len = len - 1;
    for (;;) {
      const k = this.peekKind();
      if (k !== TT_INTERPOLATION && k !== TT_TEXT && k !== TT_ENCODED_ENTITY) break;
      const tk = this.advance();
      len = len + (this.tkEnd(tk) - this.tkStart(tk));
      end = this.tkEnd(tk);
    }
    if (len > 0) this.addToParent(addNode(this.t, K_TEXT, start, end));
  }

  closeVoidElement(): void {
    const c = this.container();
    if (c < 0) return;
    const d = this.definitionOfNode(c);
    if (d >= 0 && defIsVoid(d)) this.containerStack.pop();
  }

  /** `_getElementFullName`, and the definition of what has that name, `:prefix:name`: there is none with a colon in the name. */
  fullName(token: number, parent: number): void {
    if (this.tkPk(token) !== PK_NAME) {
      this.fnPrefixS = 0;
      this.fnPrefixE = 0;
      this.fnNameS = 0;
      this.fnNameE = 0;
      this.fnDef = DEF_DEFAULT;
      return;
    }
    const prefixS = this.tkP(token, 0);
    const prefixE = this.tkP(token, 1);
    const nameS = this.tkP(token, 2);
    const nameE = this.tkP(token, 3);
    this.fnNameS = nameS;
    this.fnNameE = nameE;
    if (prefixE > prefixS) {
      this.fnPrefixS = prefixS;
      this.fnPrefixE = prefixE;
      this.fnDef = DEF_DEFAULT;
      return;
    }
    const definition = definitionOf(this.text, nameS, nameE, this.isTagNameCaseSensitive);
    let ps = 0;
    let pe = 0;
    const implicit = defImplicitNamespace(definition);
    let hasPrefix = false;
    if (implicit.length > 0) {
      // A literal prefix: "svg" or "math"; it is a name in the pool.
      const at = internLit(this.t, implicit);
      ps = at;
      pe = at + implicit.length;
      hasPrefix = true;
    }
    if (!hasPrefix && parent >= 0) {
      const pnsS = nsStart(this.t, parent);
      const pnsE = nsEnd(this.t, parent);
      if (pnsE > pnsS) {
        // `definition_of(parent.name, ..).prevent_namespace_inheritance`
        const pd = definitionOf(this.t.pool.data, nameStart(this.t, parent), nameEnd(this.t, parent), this.isTagNameCaseSensitive);
        if (!defPreventNamespaceInheritance(pd)) {
          ps = pnsS;
          pe = pnsE;
          hasPrefix = true;
        }
      }
    }
    this.fnPrefixS = ps;
    this.fnPrefixE = pe;
    this.fnDef = hasPrefix ? DEF_DEFAULT : definition;
  }

  consumeElementStartTag(startTagToken: number): void {
    const t = this.t;
    const firstAttr = t.attrCount;
    const firstComment = t.commentCount;
    for (;;) {
      const k = this.peekKind();
      if (k === TT_ATTR_NAME) {
        const name = this.advance();
        this.consumeAttr(name);
      } else if (k === TT_IN_ELEMENT_COMMENT) {
        const token = this.advance();
        if (this.tkPk(token) === PK_COMMENT) {
          const c = addStartTagComment(t);
          const b = c * TC_STRIDE;
          t.c[b + TCF_SPAN_S] = this.tkStart(token);
          t.c[b + TCF_SPAN_E] = this.tkEnd(token);
          t.c[b + TCF_VAL_S] = this.tkP(token, 0);
          t.c[b + TCF_VAL_E] = this.tkP(token, 1);
          t.c[b + TCF_SINGLE] = this.tkP(token, 2);
        }
      } else {
        break;
      }
    }
    this.fullName(startTagToken, this.closestElementLikeParent());
    const prefixS = this.fnPrefixS;
    const prefixE = this.fnPrefixE;
    const nameS = this.fnNameS;
    const nameE = this.fnNameE;
    const definition = this.fnDef;
    let isSelfClosing = false;
    if (this.peekKind() === TT_TAG_OPEN_END_VOID) {
      this.advance();
      isSelfClosing = true;
      if (!(this.canSelfClose || defCanSelfClose(definition) || prefixE > prefixS || defIsVoid(definition))) {
        this.errorAbout(this.tkStart(startTagToken), EK_SELF_CLOSED, 0, 0, nameS, nameE);
      }
    } else if (this.peekKind() === TT_TAG_OPEN_END) {
      this.advance();
    }
    const spanS = this.tkStart(startTagToken);
    const spanE = this.tkStart(this.peekT());
    const id = addNode(t, K_ELEMENT, spanS, spanE);
    setStartSpan(t, id, spanS, spanE);
    nSet(t, id, F_NSP_S, this.tkStart(startTagToken) + 1);
    nSet(t, id, F_NSP_E, this.tkEnd(startTagToken));
    setName(t, id, nameS, nameE);
    setNamespace(t, id, prefixS, prefixE);
    nSet(t, id, F_DEF, definition);
    nSet(t, id, F_ATTR_S, firstAttr);
    nSet(t, id, F_ATTR_E, t.attrCount);
    nSet(t, id, F_TC_S, firstComment);
    nSet(t, id, F_TC_E, t.commentCount);
    const c = this.container();
    let isClosedByChild = false;
    if (c >= 0) {
      const d = this.definitionOfNode(c);
      // The full name of the child is asked for: with a namespace, no list has it.
      isClosedByChild = d >= 0 && (defIsVoid(d) || (prefixE === prefixS && defIsClosedByChild(d, this.t.pool.data, nameS, nameE)));
    }
    this.pushContainer(id, isClosedByChild);
    if (isSelfClosing) {
      this.popContainer(true, prefixS, prefixE, nameS, nameE, K_ELEMENT, spanS, spanE, true);
    } else if (this.tkKind(startTagToken) === TT_INCOMPLETE_TAG_OPEN) {
      this.popContainer(true, prefixS, prefixE, nameS, nameE, K_ELEMENT, 0, 0, false);
      this.errorAbout(spanS, EK_OPENING_TAG_NOT_TERMINATED, prefixS, prefixE, nameS, nameE);
    }
  }

  pushContainer(id: number, isClosedByChild: boolean): void {
    if (isClosedByChild) this.containerStack.pop();
    this.addToParent(id);
    this.containerStack.push(id);
  }

  consumeElementEndTag(endTagToken: number): void {
    const hasName = !(this.allowHtmComponentClosingTags && this.tkPk(endTagToken) === PK_NONE);
    const at = this.tkStart(endTagToken);
    let prefixS = 0;
    let prefixE = 0;
    let nameS = 0;
    let nameE = 0;
    let definition = DEF_DEFAULT;
    if (hasName) {
      this.fullName(endTagToken, this.closestElementLikeParent());
      prefixS = this.fnPrefixS;
      prefixE = this.fnPrefixE;
      nameS = this.fnNameS;
      nameE = this.fnNameE;
      definition = this.fnDef;
    }
    if (hasName && defIsVoid(definition)) {
      this.error(at, EK_END_TAG_OF_VOID_ELEMENT, nameS, nameE);
    } else if (!this.popContainer(hasName, prefixS, prefixE, nameS, nameE, K_ELEMENT, this.tkStart(endTagToken), this.tkEnd(endTagToken), true)) {
      if (hasName) this.errorAbout(at, EK_UNEXPECTED_CLOSING_TAG, prefixS, prefixE, nameS, nameE);
      else this.errorAbout(at, EK_UNEXPECTED_CLOSING_TAG, 0, 0, NAME_NULL, NAME_NULL);
    }
  }

  /** `_popContainer`. `hasExpected`: `expected_name` is `Some`. */
  popContainer(hasExpected: boolean, epS: number, epE: number, enS: number, enE: number, expectedKind: number, endS: number, endE: number, hasEnd: boolean): boolean {
    const t = this.t;
    const buf = t.pool.data;
    let unexpectedCloseTagDetected = false;
    const v = this.containerStack;
    for (let stackIndex = v.len - 1; stackIndex >= 0; stackIndex--) {
      const id = v.data[stackIndex] | 0;
      const kind = kindOf(t, id);
      // The name of a block has no namespace, and is never asked for.
      const nps = nsStart(t, id);
      const npe = nsEnd(t, id);
      const nns = nameStart(t, id);
      const nne = nameEnd(t, id);
      let isExpected: boolean;
      if (kind === K_ELEMENT && npe > nps) {
        isExpected = hasExpected && rangesEq(buf, nps, npe, epS, epE) && rangesEq(buf, nns, nne, enS, enE);
      } else {
        isExpected = (!hasExpected || (kind === K_ELEMENT && rangesEq(buf, nps, npe, epS, epE) && rangesEq(buf, nns, nne, enS, enE))) && kind === expectedKind;
      }
      if (isExpected) {
        if (hasEnd) {
          setEndSpan(t, id, endS, endE);
          nSet(t, id, F_SPAN_E, endE);
        } else {
          clearEndSpan(t, id);
        }
        v.len = stackIndex;
        return !unexpectedCloseTagDetected;
      }
      if (kind === K_ANGULAR_CONTROL_FLOW_BLOCK) {
        unexpectedCloseTagDetected = true;
      } else {
        const d = this.definitionOfNode(id);
        if (!(d >= 0 && defClosedByParent(d))) unexpectedCloseTagDetected = true;
      }
    }
    return false;
  }

  consumeAttr(attrName: number): void {
    const t = this.t;
    let attrEnd = this.tkEnd(attrName);
    const startQuote = this.advanceIf(TT_ATTR_QUOTE);
    let valueStart = -1;
    let valueEnd = -1;
    if (this.peekKind() === TT_ATTR_VALUE_TEXT) {
      valueStart = this.tkStart(this.peekT());
      valueEnd = this.tkEnd(this.peekT());
      for (;;) {
        const k = this.peekKind();
        if (k !== TT_ATTR_VALUE_TEXT && k !== TT_ATTR_VALUE_INTERPOLATION && k !== TT_ENCODED_ENTITY) break;
        attrEnd = this.tkEnd(this.advance());
        valueEnd = attrEnd;
      }
    }
    const quote = this.advanceIf(TT_ATTR_QUOTE);
    if (quote !== NO_TOKEN) {
      attrEnd = this.tkEnd(quote);
      valueEnd = attrEnd;
    }
    const a = addAttr(t);
    const b = a * A_STRIDE;
    t.a[b + AF_SPAN_S] = this.tkStart(attrName);
    t.a[b + AF_SPAN_E] = attrEnd;
    t.a[b + AF_NSP_S] = this.tkStart(attrName);
    t.a[b + AF_NSP_E] = this.tkEnd(attrName);
    if (valueStart >= 0 && valueEnd >= 0) {
      t.a[b + AF_HAS_VSP] = 1;
      t.a[b + AF_VSP_S] = startQuote !== NO_TOKEN ? this.tkStart(startQuote) : valueStart;
      t.a[b + AF_VSP_E] = valueEnd;
    }
    if (this.tkPk(attrName) === PK_NAME) {
      t.a[b + AF_NS_S] = this.tkP(attrName, 0);
      t.a[b + AF_NS_E] = this.tkP(attrName, 1);
      t.a[b + AF_NAME_S] = this.tkP(attrName, 2);
      t.a[b + AF_NAME_E] = this.tkP(attrName, 3);
    }
  }

  /** A block whose start ends where the next token starts, with its parameters: into `blk*`. */
  block(token: number, hasEnd: boolean): void {
    const t = this.t;
    let parameters = -1;
    for (;;) {
      const pt = this.advanceIf(TT_BLOCK_PARAMETER);
      if (pt === NO_TOKEN) break;
      const ps = this.tkStart(pt);
      const pe = this.tkEnd(pt);
      const parameter = addNode(t, K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETER, ps, pe);
      setValue(t, parameter, ps, pe);
      if (parameters < 0) parameters = addNode(t, K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETERS, ps, pe);
      nSet(t, parameters, F_SPAN_E, pe);
      appendChild(t, parameters, parameter);
    }
    if (hasEnd) this.advanceIf(TT_BLOCK_OPEN_END);
    this.blkSpanS = this.tkStart(token);
    this.blkSpanE = this.tkStart(this.peekT());
    this.blkNameSpanS = this.tkStart(token);
    this.blkNameSpanE = this.tkEnd(token);
    this.valueOf(token);
    this.blkNameS = this.voS;
    this.blkNameE = this.voE;
    this.blkParams = parameters;
  }

  pushBlock(): void {
    const t = this.t;
    const id = addNode(t, K_ANGULAR_CONTROL_FLOW_BLOCK, this.blkSpanS, this.blkSpanE);
    setStartSpan(t, id, this.blkSpanS, this.blkSpanE);
    nSet(t, id, F_NSP_S, this.blkNameSpanS);
    nSet(t, id, F_NSP_E, this.blkNameSpanE);
    setName(t, id, this.blkNameS, this.blkNameE);
    const parameters = this.blkParams;
    this.pushContainer(id, false);
    if (parameters >= 0) setParameters(t, this.container(), parameters);
  }

  consumeBlockOpen(token: number): void {
    this.block(token, true);
    this.pushBlock();
  }

  consumeBlockClose(token: number): void {
    const depth = this.containerStack.len;
    const top = this.container();
    if (!this.popContainer(false, 0, 0, 0, 0, K_ANGULAR_CONTROL_FLOW_BLOCK, this.tkStart(token), this.tkEnd(token), true)) {
      // An element that was open has been closed on the way.
      let ps = 0;
      let pe = 0;
      let ns = 0;
      let ne = 0;
      if (top >= 0 && this.containerStack.len < depth) {
        ps = nsStart(this.t, top);
        pe = nsEnd(this.t, top);
        ns = nameStart(this.t, top);
        ne = nameEnd(this.t, top);
      }
      this.errorAbout(this.tkStart(token), EK_UNEXPECTED_CLOSING_BLOCK, ps, pe, ns, ne);
    }
  }

  consumeIncompleteBlock(token: number): void {
    this.block(token, false);
    const start = this.blkSpanS;
    this.pushBlock();
    this.popContainer(false, 0, 0, 0, 0, K_ANGULAR_CONTROL_FLOW_BLOCK, 0, 0, false);
    this.valueOf(token);
    this.error(start, EK_INCOMPLETE_BLOCK, this.voS, this.voE);
  }

  consumeLet(startToken: number): void {
    const at = this.tkStart(startToken);
    this.valueOf(startToken);
    const nameS = this.voS;
    const nameE = this.voE;
    const valueToken = this.advanceIf(TT_LET_VALUE);
    if (valueToken === NO_TOKEN) {
      this.error(at, EK_LET_WITHOUT_VALUE, nameS, nameE);
      return;
    }
    const endToken = this.advanceIf(TT_LET_END);
    if (endToken === NO_TOKEN) {
      this.error(at, EK_LET_NOT_TERMINATED, nameS, nameE);
      return;
    }
    const t = this.t;
    const id = addNode(t, K_ANGULAR_LET_DECLARATION, this.tkStart(startToken), this.tkEnd(endToken));
    setName(t, id, nameS, nameE);
    nSet(t, id, F_NSP_S, this.tkStart(valueToken));
    nSet(t, id, F_NSP_E, this.tkEnd(valueToken));
    setValue(t, id, this.tkStart(valueToken), this.tkEnd(valueToken));
    this.addToParent(id);
  }
}

function rangesEq(buf: Uint8Array, as: number, ae: number, bs: number, be: number): boolean {
  if (ae - as !== be - bs) return false;
  for (let i = 0; i < ae - as; i++) {
    if ((buf[as + i] | 0) !== (buf[bs + i] | 0)) return false;
  }
  return true;
}

export function appendErrors(into: ErrorList, from: ErrorList): void {
  for (let i = 0; i < from.count; i++) {
    const b = i * 8;
    const d = from.d;
    into.push(d[b] | 0, d[b + 1] | 0, d[b + 2] | 0, d[b + 3] | 0, d[b + 4] | 0, d[b + 5] | 0, (d[b + 6] | 0) !== 0);
  }
}

/**
 * `new HtmlParser().parse(..)`, of the part of `t.pool` (the text) from `start` on, up to `len`. `rawMode`: `RAW_*` (how `shouldParseAsRawText`
 * decides). The tree gets the nodes; `result.root` has the `rootNodes` as its children.
 */
export function parse(t: HTree, len: number, start: number, o: ParseOptions, rawMode: number): ParseResult {
  const text = t.pool.data;
  const isCaseSensitive = o.isTagNameCaseSensitive;
  tokenize(text, len, start, rawMode, isCaseSensitive, o.tokenizeAngularBlocks, o.tokenizeLet, o.canSelfClose, o.allowHtmComponentClosingTags, o.allowStartTagComments);
  const result = new ParseResult();
  appendErrors(result.errors, lx.errors);
  const tokens = lx.tokens;
  const tokenCount = lx.tokenCount;
  const root = addNode(t, K_ROOT, 0, len);
  const end = tokenCount > 0 ? tokenCount - 1 : 0;
  let eofStart = len;
  let eofEnd = len;
  if (tokenCount > 0) {
    eofStart = tokens[(tokenCount - 1) * TK_STRIDE + TKF_START] | 0;
    eofEnd = tokens[(tokenCount - 1) * TK_STRIDE + TKF_END] | 0;
  }
  const shared = new Shared();
  const builder = new TreeBuilder(t, text, tokens, 0, end, eofStart, eofEnd, root, shared);
  builder.canSelfClose = o.canSelfClose;
  builder.allowHtmComponentClosingTags = o.allowHtmComponentClosingTags;
  builder.isTagNameCaseSensitive = isCaseSensitive;
  builder.build();
  appendErrors(result.errors, builder.errors);
  if (eofStart < len) result.errors.push(eofStart, EK_TEXT_BEHIND_NUL, 0, 0, 0, 0, false);
  result.root = root;
  result.isNestedTooDeeply = builder.isNestedTooDeeply;
  return result;
}

void RAW_NONE;
void poolAppend;
void eqLit;
void K_TEXT;
void TT_TAG_OPEN_START;
void TT_COMMENT_START;
void TT_LET_START;
