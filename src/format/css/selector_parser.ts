// Port of vendor/bun/src/format/css/selector_parser.rs: `postcss-selector-parser` 2.2.3 (`dist/tokenize.js`,
// `dist/parser.js`), and Prettier's `parse/parse-selector.js`.
//
// `Selectors` is the arena of everything parsed so far: the texts (copied), the nodes (SoA), reused for the next node of
// the style sheet (`clear()`). A node is an id (0: none).
import { selectorAtEnd, selectorWordEnd } from "./charsets.ts";
import { Stack } from "../../base/stack.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import { ByteBuf } from "../../base/bytebuf.ts";
import { indexOfByteIn, indexOfLit, isAsciiWhitespace } from "./misc.ts";

// token kinds; a control character is `256 + byte`
const T_SPACE = 0;
const T_COMBINATOR = 1;
const T_STRING = 3;
const T_ATWORD = 4;
const T_WORD = 5;
const T_COMMENT = 6;
const C_STAR = 256 + 42;
const C_AMP = 256 + 38;
const C_COMMA = 256 + 44;
const C_LBRACKET = 256 + 91;
const C_RBRACKET = 256 + 93;
const C_COLON = 256 + 58;
const C_SEMI = 256 + 59;
const C_LPAREN = 256 + 40;
const C_RPAREN = 256 + 41;


// `SelectorKind`
export const SK_ROOT = 0;
export const SK_SELECTOR = 1;
export const SK_TAG = 2;
export const SK_CLASS = 3;
export const SK_ID = 4;
export const SK_ATTRIBUTE = 5;
export const SK_PSEUDO = 6;
export const SK_UNIVERSAL = 7;
export const SK_COMBINATOR = 8;
export const SK_NESTING = 9;
export const SK_STRING = 10;
export const SK_COMMENT = 11;
export const SK_UNKNOWN = 12;

// `Namespace`
export const NS_NONE = 0;
/** `true` */
export const NS_EMPTY = 1;
export const NS_NAME = 2;

function nestingOf(kind: number): number {
  if (kind === C_LPAREN) return 1;
  if (kind === C_RPAREN) return -1;
  return 0;
}

export class Selectors {
  text: ByteBuf;
  // nodes (SoA); 0 is the dummy
  kind: Uint8Array;
  vs: Int32Array;
  ve: Int32Array;
  nsKind: Uint8Array;
  nsS: Int32Array;
  nsE: Int32Array;
  parent: Int32Array;
  firstChild: Int32Array;
  lastChild: Int32Array;
  childCount: Int32Array;
  nextSibling: Int32Array;
  attrS: Int32Array;
  attrE: Int32Array;
  // operator: opS < 0: none
  opS: Int32Array;
  opE: Int32Array;
  hasValue: Uint8Array;
  insensitive: Uint8Array;
  n: number;
  // tokens: kind, start, end
  tokens: Int32Array;
  nTokens: number;
  // the parser
  base: number;
  position: number;
  current: number;
  stack: Stack;

  constructor() {
    this.text = new ByteBuf(256);
    this.kind = new Uint8Array(64);
    this.vs = new Int32Array(64);
    this.ve = new Int32Array(64);
    this.nsKind = new Uint8Array(64);
    this.nsS = new Int32Array(64);
    this.nsE = new Int32Array(64);
    this.parent = new Int32Array(64);
    this.firstChild = new Int32Array(64);
    this.lastChild = new Int32Array(64);
    this.childCount = new Int32Array(64);
    this.nextSibling = new Int32Array(64);
    this.attrS = new Int32Array(64);
    this.attrE = new Int32Array(64);
    this.opS = new Int32Array(64);
    this.opE = new Int32Array(64);
    this.hasValue = new Uint8Array(64);
    this.insensitive = new Uint8Array(64);
    this.n = 0;
    this.tokens = new Int32Array(192);
    this.nTokens = 0;
    this.base = 0;
    this.position = 0;
    this.current = 0;
    this.stack = Stack.create();
  }

  /** Forgets all selectors. */
  clear(): void {
    this.text.len = 0;
    this.n = 0;
  }

  private growNodes(): void {
    const cap = this.kind.length * 2;
    const k = new Uint8Array(cap);
    k.set(this.kind);
    this.kind = k;
    this.vs = growI(this.vs, cap);
    this.ve = growI(this.ve, cap);
    const nk = new Uint8Array(cap);
    nk.set(this.nsKind);
    this.nsKind = nk;
    this.nsS = growI(this.nsS, cap);
    this.nsE = growI(this.nsE, cap);
    this.parent = growI(this.parent, cap);
    this.firstChild = growI(this.firstChild, cap);
    this.lastChild = growI(this.lastChild, cap);
    this.childCount = growI(this.childCount, cap);
    this.nextSibling = growI(this.nextSibling, cap);
    this.attrS = growI(this.attrS, cap);
    this.attrE = growI(this.attrE, cap);
    this.opS = growI(this.opS, cap);
    this.opE = growI(this.opE, cap);
    const hv = new Uint8Array(cap);
    hv.set(this.hasValue);
    this.hasValue = hv;
    const ins = new Uint8Array(cap);
    ins.set(this.insensitive);
    this.insensitive = ins;
  }

  /** `SelectorNode::new` pushed. */
  private pushNode(kind: number, vs: number, ve: number, parent: number): number {
    if (this.n === this.kind.length) this.growNodes();
    const id = this.n;
    this.n = id + 1;
    this.kind[id] = kind | 0;
    this.vs[id] = vs | 0;
    this.ve[id] = ve | 0;
    this.nsKind[id] = NS_NONE;
    this.parent[id] = parent | 0;
    this.firstChild[id] = 0;
    this.lastChild[id] = 0;
    this.childCount[id] = 0;
    this.nextSibling[id] = 0;
    return id;
  }

  private pushToken(kind: number, start: number, end: number): void {
    if ((this.nTokens + 1) * 3 > this.tokens.length) {
      const t = new Int32Array(this.tokens.length * 2);
      t.set(this.tokens);
      this.tokens = t;
    }
    const o = this.nTokens * 3;
    this.tokens[o] = kind | 0;
    this.tokens[o + 1] = start | 0;
    this.tokens[o + 2] = end | 0;
    this.nTokens = this.nTokens + 1;
  }

  // ───────────────────────────── the tokenizer ─────────────────────────────

  /** Tokens of css[s, e); positions are relative to `s`. Returns false on error. */
  private tokenize(css: Uint8Array, s: number, e: number): boolean {
    this.nTokens = 0;
    let pos = 0;
    const length = e - s;
    while (pos < length) {
      const code = css[s + pos] | 0;
      let kind: number;
      let end: number;
      switch (code) {
        case 10: case 32: case 9: case 13: case 12: {
          let at = pos + 1;
          while (at < length && isAsciiWhitespace(css[s + at] | 0)) at = at + 1;
          kind = T_SPACE;
          end = at;
          break;
        }
        case 43: case 62: case 126: case 124: {
          let at = pos + 1;
          while (at < length) {
            const c = css[s + at] | 0;
            if (c === 43 || c === 62 || c === 126 || c === 124) at = at + 1;
            else break;
          }
          kind = T_COMBINATOR;
          end = at;
          break;
        }
        case 42: case 38: case 44: case 91: case 93: case 58: case 59: case 40: case 41:
          kind = 256 + code;
          end = pos + 1;
          break;
        case 39: case 34: {
          let close = pos;
          while (true) {
            close = indexOfByteIn(css, s + close + 1, e, code);
            if (close < 0) return false;
            close = close - s;
            let backslashes = 0;
            while (close - 1 - backslashes >= 0 && (css[s + close - 1 - backslashes] | 0) === 92) backslashes = backslashes + 1;
            if (backslashes % 2 === 0) break;
          }
          kind = T_STRING;
          end = close + 1;
          break;
        }
        case 64: {
          let f = s + pos + 1;
          while (f < e && !selectorAtEnd(css[f] | 0)) f = f + 1;
          if (f >= e) f = -1;
          kind = T_ATWORD;
          end = f < 0 ? length : f - s;
          break;
        }
        case 92: {
          let last = pos;
          let escape = true;
          while (last + 1 < length && (css[s + last + 1] | 0) === 92) {
            last = last + 1;
            escape = !escape;
          }
          const hasAfter = last + 1 < length;
          const after = hasAfter ? css[s + last + 1] | 0 : 0;
          if (escape && after !== 47 && !(hasAfter && isAsciiWhitespace(after))) last = last + 1;
          kind = T_WORD;
          end = last + 1 < length ? last + 1 : length;
          break;
        }
        default: {
          if (code === 47 && pos + 1 < length && (css[s + pos + 1] | 0) === 42) {
            const close = indexOfLit(css, s + pos + 2, e, "*/");
            if (close < 0) return false;
            kind = T_COMMENT;
            end = close - s + 2;
            break;
          }
          let at = pos + 1;
          let found: number;
          while (true) {
            let next = s + at;
            while (next < e && !selectorWordEnd(css[next] | 0)) next = next + 1;
            if (next >= e) next = -1;
            if (next < 0) {
              found = length;
              break;
            }
            at = next - s;
            if ((css[s + at] | 0) !== 47 || (at + 1 < length && (css[s + at + 1] | 0) === 42)) {
              found = at;
              break;
            }
            at = at + 1;
          }
          kind = T_WORD;
          end = found;
          break;
        }
      }
      this.pushToken(kind, pos, end);
      pos = end;
    }
    return true;
  }

  // ───────────────────────────── the parser ─────────────────────────────

  private tkKind(position: number): number {
    // -1: none
    return position >= 0 && position < this.nTokens ? this.tokens[position * 3] | 0 : -1;
  }
  private tkStart(position: number): number {
    return this.tokens[position * 3 + 1] | 0;
  }
  private tkEnd(position: number): number {
    return this.tokens[position * 3 + 2] | 0;
  }

  /** The text of the token at `position` is the single byte `b`. */
  private tokenIsByte(position: number, b: number): boolean {
    return (
      position >= 0 && position < this.nTokens && this.tkEnd(position) - this.tkStart(position) === 1 &&
      (this.text.data[this.base + this.tkStart(position)] | 0) === b
    );
  }

  /** `append`: a node with `value` (relative to base) that is the last child of `parent`. */
  private append(parent: number, kind: number, vs: number, ve: number): number {
    const id = this.pushNode(kind, this.base + vs, this.base + ve, parent);
    this.childCount[parent] = (this.childCount[parent] | 0) + 1;
    const previous = this.lastChild[parent] | 0;
    this.lastChild[parent] = id;
    if (previous === 0) this.firstChild[parent] = id;
    else this.nextSibling[previous] = id;
    return id;
  }

  private newNode(kind: number, vs: number, ve: number, nsKind: number, nsS: number, nsE: number): number {
    const id = this.append(this.current, kind, vs, ve);
    this.nsKind[id] = nsKind;
    this.nsS[id] = nsS;
    this.nsE[id] = nsE;
    return id;
  }

  private lastOfCurrent(): number {
    return this.lastChild[this.current] | 0;
  }

  // Returns false on error.
  private parseOne(throwOnParenthesis: boolean): boolean {
    if (this.position >= this.nTokens) return false;
    const kind = this.tkKind(this.position);
    const ts = this.tkStart(this.position);
    const te = this.tkEnd(this.position);
    switch (kind) {
      case T_SPACE:
        return this.space();
      case T_COMMENT:
        this.newNode(SK_COMMENT, ts, te, NS_NONE, 0, 0);
        this.position = this.position + 1;
        return true;
      case C_LPAREN:
        return this.parentheses();
      case C_RPAREN:
        return !throwOnParenthesis;
      case C_LBRACKET:
        return this.attribute();
      case C_RBRACKET:
      case C_SEMI:
        return false;
      case T_ATWORD:
      case T_WORD:
        return this.word(NS_NONE, 0, 0);
      case C_COLON:
        return this.pseudo();
      case C_COMMA:
        if (this.position + 1 !== this.nTokens) {
          const parent = this.parent[this.current] | 0;
          this.current = this.append(parent, SK_SELECTOR, 0, 0);
        }
        this.position = this.position + 1;
        return true;
      case C_STAR:
        return this.universal(NS_NONE, 0, 0);
      case T_COMBINATOR:
        return this.combinator();
      case T_STRING:
        this.newNode(SK_STRING, ts, te, NS_NONE, 0, 0);
        this.position = this.position + 1;
        return true;
      default:
        // `&`
        this.newNode(SK_NESTING, ts, te, NS_NONE, 0, 0);
        this.position = this.position + 1;
        return true;
    }
  }

  private attribute(): boolean {
    this.position = this.position + 1;
    const textLen = this.text.len - this.base;
    const start = this.position < this.nTokens ? this.tkStart(this.position) : textLen;
    while (this.position < this.nTokens && this.tkKind(this.position) !== C_RBRACKET) this.position = this.position + 1;
    // Without a `]`, the parser looks at a token that is not there.
    if (this.position >= this.nTokens) return false;
    const end = this.tkStart(this.position);
    const data = this.text.data;
    // `string` = text[base + start, base + end)
    const sBase = this.base + start;
    const sLen = end - start;
    // `str.split(/((?:[*~^$|]?=))([^]*)/)`
    let equals = -1;
    for (let i = 0; i < sLen; i++) {
      if ((data[sBase + i] | 0) === 61) { equals = i; break; }
    }
    let opStart = -1;
    let opEnd = 0;
    if (equals >= 0) {
      let hasPrefix = false;
      if (equals > 0) {
        const p = data[sBase + equals - 1] | 0;
        hasPrefix = p === 42 || p === 126 || p === 94 || p === 36 || p === 124;
      }
      opStart = equals - (hasPrefix ? 1 : 0);
      opEnd = equals + 1;
    }
    const nameEnd = opStart >= 0 ? opStart : sLen;

    const id = this.newNode(SK_ATTRIBUTE, 0, 0, NS_NONE, 0, 0);
    this.vs[id] = 0;
    this.ve[id] = 0;
    this.opS[id] = -1;
    this.opE[id] = 0;
    this.hasValue[id] = 0;
    this.insensitive[id] = 0;
    // `parts[0].split(/(\|)/g)`
    let pipe = -1;
    for (let i = 0; i < nameEnd; i++) {
      if ((data[sBase + i] | 0) === 124) { pipe = i; break; }
    }
    if (pipe >= 0) {
      let attributeLen = nameEnd - pipe - 1;
      for (let i = pipe + 1; i < nameEnd; i++) {
        if ((data[sBase + i] | 0) === 124) { attributeLen = i - pipe - 1; break; }
      }
      this.attrS[id] = sBase + pipe + 1;
      this.attrE[id] = sBase + pipe + 1 + attributeLen;
      if (pipe === 0) {
        this.nsKind[id] = NS_EMPTY;
      } else {
        this.nsKind[id] = NS_NAME;
        this.nsS[id] = sBase;
        this.nsE[id] = sBase + pipe;
      }
    } else {
      this.attrS[id] = sBase;
      this.attrE[id] = sBase + nameEnd;
    }
    if (opStart >= 0) {
      this.opS[id] = sBase + opStart;
      this.opE[id] = sBase + opEnd;
      const valueStart = sBase + opEnd;
      const valueEnd = sBase + sLen;
      if (valueEnd > valueStart) {
        // `parts[2].split(/(\s+i\s*?)$/)`
        const trimmedEnd = trimJsWhitespaceEnd(data, valueStart, valueEnd);
        let beforeFlagEnd = -1;
        if (trimmedEnd > valueStart && (data[trimmedEnd - 1] | 0) === 105) {
          const restEnd = trimmedEnd - 1;
          if (trimJsWhitespaceEnd(data, valueStart, restEnd) < restEnd) beforeFlagEnd = restEnd;
        }
        let valueLen: number;
        if (beforeFlagEnd >= 0) valueLen = trimJsWhitespaceEnd(data, valueStart, beforeFlagEnd) - valueStart;
        else valueLen = valueEnd - valueStart;
        this.insensitive[id] = beforeFlagEnd >= 0 ? 1 : 0;
        this.vs[id] = valueStart;
        this.ve[id] = valueStart + valueLen;
        this.hasValue[id] = valueLen > 0 ? 1 : 0;
      }
    }
    this.position = this.position + 1;
    return true;
  }

  private combinator(): boolean {
    if (this.position >= this.nTokens) return false;
    if (this.tokenIsByte(this.position, 124)) return this.namespace();
    const id = this.newNode(SK_COMBINATOR, 0, 0, NS_NONE, 0, 0);
    this.vs[id] = 0;
    this.ve[id] = 0;
    while (this.position < this.nTokens) {
      const k = this.tkKind(this.position);
      if (k !== T_SPACE && k !== T_COMBINATOR) break;
      // `a |b`: the parser takes the `|` for the combinator, and Prettier prints `a|b`. It stays as it is written.
      if (this.tokenIsByte(this.position, 124)) return false;
      const nextIsCombinator = this.tkKind(this.position + 1) === T_COMBINATOR;
      const prevIsCombinator = this.tkKind(this.position - 1) === T_COMBINATOR;
      if (!nextIsCombinator && !prevIsCombinator) {
        this.vs[id] = this.base + this.tkStart(this.position);
        this.ve[id] = this.base + this.tkEnd(this.position);
      }
      this.position = this.position + 1;
    }
    return true;
  }

  private isBeforeNamespaceSeparator(): boolean {
    return this.tokenIsByte(this.position + 1, 124);
  }

  /** At a `|`. In `a|b|c`, `b` is the namespace of `c`, and `a` is lost. */
  private namespace(): boolean {
    while (true) {
      // The parser takes whatever is before the `|` for the namespace: of `a,|b` Prettier prints `a, ,|b`.
      let nsKind = NS_EMPTY;
      let nsS = 0;
      let nsE = 0;
      const prevKind = this.tkKind(this.position - 1);
      if (this.position >= 1 && this.tkEnd(this.position - 1) > this.tkStart(this.position - 1) && (prevKind === T_WORD || prevKind === C_STAR)) {
        nsKind = NS_NAME;
        nsS = this.base + this.tkStart(this.position - 1);
        nsE = this.base + this.tkEnd(this.position - 1);
      }
      const kind = this.tkKind(this.position + 1);
      if (kind < 0) return false;
      // The parser stays where it is, and comes here again, without end.
      if (kind !== T_WORD && kind !== C_STAR) return false;
      this.position = this.position + 1;
      if (!this.isBeforeNamespaceSeparator()) {
        return kind === T_WORD ? this.word(nsKind, nsS, nsE) : this.universal(nsKind, nsS, nsE);
      }
      this.position = this.position + 1;
    }
  }

  private parentheses(): boolean {
    const last = this.lastOfCurrent();
    if (last !== 0 && (this.kind[last] | 0) === SK_PSEUDO) {
      if (!this.stack.enter()) return false;
      const selector = this.append(last, SK_SELECTOR, 0, 0);
      const cache = this.current;
      this.current = selector;
      let balanced = 1;
      this.position = this.position + 1;
      while (this.position < this.nTokens && balanced !== 0) {
        balanced = balanced + nestingOf(this.tkKind(this.position));
        if (balanced === 0) {
          this.position = this.position + 1;
        } else if (!this.parseOne(false)) {
          this.stack.leave();
          return false;
        }
      }
      this.stack.leave();
      if (balanced !== 0) return false;
      this.current = cache;
    } else {
      if (last === 0) return false;
      let balanced = 1;
      this.position = this.position + 1;
      while (this.position < this.nTokens && balanced !== 0) {
        const kind = this.tkKind(this.position);
        const ts = this.tkStart(this.position);
        const te = this.tkEnd(this.position);
        balanced = balanced + nestingOf(kind);
        this.position = this.position + 1;
        // Everything up to here is added to the value. It follows what is there, unless that is nothing.
        if ((this.vs[last] | 0) === (this.ve[last] | 0)) this.vs[last] = this.base + (ts > 0 ? ts - 1 : 0);
        this.ve[last] = this.base + te;
      }
      if (balanced !== 0) return false;
    }
    return true;
  }

  private pseudo(): boolean {
    if (this.position >= this.nTokens) return false;
    const start = this.tkStart(this.position);
    while (this.position < this.nTokens && this.tkKind(this.position) === C_COLON) this.position = this.position + 1;
    if (this.position >= this.nTokens) return false;
    if (this.tkKind(this.position) !== T_WORD) return false;
    return this.splitWord(NS_NONE, 0, 0, start);
  }

  private space(): boolean {
    const prev = this.tkKind(this.position - 1);
    const next = this.tkKind(this.position + 1);
    if (this.position === 0 || prev === C_COMMA || prev === C_LPAREN) {
      this.position = this.position + 1;
    } else if (this.position + 1 === this.nTokens || next === C_COMMA || next === C_RPAREN) {
      if (this.lastOfCurrent() === 0) return false;
      this.position = this.position + 1;
    } else {
      return this.combinator();
    }
    return true;
  }

  private universal(nsKind: number, nsS: number, nsE: number): boolean {
    if (this.isBeforeNamespaceSeparator()) {
      this.position = this.position + 1;
      return this.namespace();
    }
    if (this.position >= this.nTokens) return false;
    this.newNode(SK_UNIVERSAL, this.tkStart(this.position), this.tkEnd(this.position), nsKind, nsS, nsE);
    this.position = this.position + 1;
    return true;
  }

  private word(nsKind: number, nsS: number, nsE: number): boolean {
    if (this.isBeforeNamespaceSeparator()) {
      this.position = this.position + 1;
      return this.namespace();
    }
    return this.splitWord(nsKind, nsS, nsE, -1);
  }

  /** `pseudoStart` >= 0: the word follows the colons of a pseudo class, which start there. */
  private splitWord(nsKind: number, nsS: number, nsE: number, pseudoStart: number): boolean {
    if (this.position >= this.nTokens) return false;
    const firstStart = this.tkStart(this.position);
    let end = this.tkEnd(this.position);
    while (this.tkKind(this.position + 1) === T_WORD) {
      this.position = this.position + 1;
      end = this.tkEnd(this.position);
      const nextEndsWithBackslash = (this.text.data[this.base + end - 1] | 0) === 92;
      if (nextEndsWithBackslash && this.tkKind(this.position + 1) === T_SPACE) {
        end = this.tkEnd(this.position + 1);
        this.position = this.position + 1;
      }
    }
    const wordBase = this.base + firstStart;
    const wordLen = end - firstStart;
    let ind = 0;
    while (ind < wordLen || ind === 0) {
      // Where the next part starts behind `ind`.
      let index = wordLen;
      for (let at = ind + 1; at < wordLen; at++) {
        const c = this.text.data[wordBase + at] | 0;
        if (c === 46 || (c === 35 && !(at + 1 < wordLen && (this.text.data[wordBase + at + 1] | 0) === 123))) {
          index = at;
          break;
        }
      }
      const s = firstStart + ind;
      const e = firstStart + index;
      if (ind === 0 && pseudoStart >= 0) {
        this.newNode(SK_PSEUDO, pseudoStart, e, NS_NONE, 0, 0);
        const nextIsParen = this.tkKind(this.position + 1) === C_LPAREN;
        if (index < wordLen && nextIsParen) return false;
      } else {
        const c = ind < wordLen ? this.text.data[wordBase + ind] | 0 : -1;
        if (c === 46) {
          this.newNode(SK_CLASS, s + 1, e, nsKind, nsS, nsE);
        } else if (c === 35 && !(ind + 1 < wordLen && (this.text.data[wordBase + ind + 1] | 0) === 123)) {
          this.newNode(SK_ID, s + 1, e, nsKind, nsS, nsE);
        } else {
          this.newNode(SK_TAG, s, e, nsKind, nsS, nsE);
        }
      }
      ind = index > 1 ? index : 1;
    }
    this.position = this.position + 1;
    return true;
  }

  // ───────────────────────────── queries ─────────────────────────────

  /** `Selectors::text(span)` is `text.data[s .. e)` (the caller reads `selectors.text.data`). */

  /** Prettier's `parseSelector` for `selector[s, e)`: the id of the root. */
  parse(selector: Uint8Array, s: number, e: number, stack: Stack): number {
    if (this.n === 0) this.pushNode(SK_UNKNOWN, 0, 0, 0);
    const base = this.text.len;
    this.text.append(selector, s, e);
    const len = e - s;
    const root = this.n;
    if (hasComment(selector, s, e)) {
      const start = base + (trimJsWhitespaceStart(selector, s, e) - s);
      this.pushNode(SK_UNKNOWN, start, start + (trimJsWhitespaceEnd(selector, trimJsWhitespaceStart(selector, s, e), e) - trimJsWhitespaceStart(selector, s, e)), 0);
      return root;
    }
    let ok = this.tokenize(selector, s, e);
    if (ok) {
      this.pushNode(SK_ROOT, 0, 0, 0);
      this.base = base;
      this.position = 0;
      this.stack = stack;
      this.current = root;
      this.current = this.append(root, SK_SELECTOR, 0, 0);
      while (this.position < this.nTokens) {
        if (!this.parseOne(true)) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) {
      this.n = root;
      this.pushNode(SK_UNKNOWN, base, base + len, 0);
    }
    return root;
  }
}

function growI(a: Int32Array, cap: number): Int32Array {
  const n = new Int32Array(cap);
  n.set(a);
  return n;
}

/** `/\/[/*]/.test(selector.replaceAll(/"[^"]+"|'[^']+'/g, ""))` */
function hasComment(selector: Uint8Array, s: number, e: number): boolean {
  if (indexOfByteIn(selector, s, e, 47) < 0) return false;
  let at = s;
  while (at < e) {
    const byte = selector[at] | 0;
    if (byte === 34 || byte === 39) {
      const close = indexOfByteIn(selector, at + 1, e, byte);
      // There has to be something between the quotes.
      if (close >= 0 && close > at + 1) {
        // What is before and after the string ends up side by side.
        if (at > s && (selector[at - 1] | 0) === 47) {
          const after = close + 1 < e ? selector[close + 1] | 0 : -1;
          if (after === 47 || after === 42) return true;
        }
        at = close + 1;
      } else {
        at = at + 1;
      }
    } else if (byte === 47) {
      const next = at + 1 < e ? selector[at + 1] | 0 : -1;
      if (next === 47 || next === 42) return true;
      at = at + 1;
    } else {
      at = at + 1;
    }
  }
  return false;
}
