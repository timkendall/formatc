// Port of vendor/bun/src/format/toml/tree.rs. Tokens to tree.
//
// The tree is the one that taplo's parser makes of a document without errors, without its white space: where a comment or
// a run of line breaks is in it decides what becomes of it. It is a table of elements in the order of the text: a node is
// followed by what is in it. `el` has 4 ints per element (index `i << 2`): kind, start, end, next (the index of the element
// after this one and all that is in it).
import { Stack } from "../../base/stack.ts";
import { FORMAT_NESTED_TOO_DEEPLY, FORMAT_OK } from "../errors.ts";
import {
  TT_ARRAY_CLOSE,
  TT_ARRAY_OPEN,
  TT_COMMA,
  TT_DOT,
  TT_INLINE_CLOSE,
  TT_INLINE_OPEN,
  TT_KEY,
  tomlTokenCount,
  tomlTokenEnds,
  tomlTokenKinds,
  tomlTokenStarts,
} from "../../parsers/toml.ts";

/** `[a]` or `[[a]]` */
export const K_HEADER = 0;
/** `a = 1` */
export const K_ENTRY = 1;
export const K_KEY = 2;
export const K_VALUE = 3;
export const K_ARRAY = 4;
export const K_INLINE_TABLE = 5;
/** A token that is written as it is. */
export const K_TEXT = 6;
/** `[` of an array, `{` */
export const K_OPEN = 7;
/** `]` of an array, `}` */
export const K_CLOSE = 8;
export const K_COMMA = 9;
export const K_COMMENT = 10;
/** `\n` or `\r\n`, any number of times. */
export const K_LINE_BREAKS = 11;

export class TomlTree {
  el: Int32Array = new Int32Array(4 * 64);
  count: number = 0;

  // The builder.
  text: Uint8Array = new Uint8Array(0);
  n: number = 0;
  kinds: Uint8Array = new Uint8Array(0);
  starts: Int32Array = new Int32Array(0);
  ends: Int32Array = new Int32Array(0);
  nTokens: number = 0;
  /** The index of the next token. */
  tok: number = 0;
  /** Behind the last token. */
  at: number = 0;
  stack: Stack = Stack.forTree();

  push(kind: number, start: number, end: number): void {
    const index = this.count;
    const b = index << 2;
    if (b + 4 > this.el.length) {
      const ne = new Int32Array(this.el.length * 2);
      ne.set(this.el);
      this.el = ne;
    }
    this.el[b] = kind | 0;
    this.el[b + 1] = start | 0;
    this.el[b + 2] = end | 0;
    this.el[b + 3] = (index + 1) | 0;
    this.count = index + 1;
  }

  start(kind: number): number {
    this.push(kind, this.at, this.at);
    return this.count - 1;
  }

  finish(node: number): void {
    this.el[(node << 2) + 3] = this.count | 0;
  }

  /** The kind of the next token, -1 if there is none. */
  peek(): number {
    return this.tok < this.nTokens ? this.kinds[this.tok] | 0 : -1;
  }

  /** The next token, as `kind`. */
  token(kind: number): void {
    if (this.tok < this.nTokens) {
      const s = this.starts[this.tok] | 0;
      const e = this.ends[this.tok] | 0;
      this.tok = this.tok + 1;
      this.push(kind, s, e);
      this.at = e;
    }
  }

  /** Where the next token starts. */
  gapEnd(): number {
    return this.tok < this.nTokens ? this.starts[this.tok] | 0 : this.n;
  }

  skipBlanks(): void {
    const t = this.text;
    let at = this.at;
    while (at < this.n && ((t[at] | 0) === 32 || (t[at] | 0) === 9)) at = at + 1;
    this.at = at;
  }

  /** taplo's `step`: a comment behind a token, on its line, is in the node that the token is in. */
  commentOnTheLine(): void {
    this.skipBlanks();
    const t = this.text;
    if (this.at < this.gapEnd() && (t[this.at] | 0) === 35) {
      let len = 0;
      const rest = this.n - this.at;
      while (len < rest) {
        const c = t[this.at + len] | 0;
        if (c === 13 || c === 10) break;
        len = len + 1;
      }
      this.push(K_COMMENT, this.at, this.at + len);
      this.at = this.at + len;
    }
  }

  /** The comments and the line breaks up to the next token. */
  trivia(): void {
    const t = this.text;
    const end = this.gapEnd();
    while (true) {
      this.commentOnTheLine();
      if (this.at >= end) return;
      let len = 0;
      if ((t[this.at] | 0) === 10) {
        while (this.at + len < end && (t[this.at + len] | 0) === 10) len = len + 1;
      } else {
        while (this.at + len + 1 < end && (t[this.at + len] | 0) === 13 && (t[this.at + len + 1] | 0) === 10) len = len + 2;
      }
      // Between two tokens there is nothing else.
      if (len === 0) {
        this.at = end;
        return;
      }
      this.push(K_LINE_BREAKS, this.at, this.at + len);
      this.at = this.at + len;
    }
  }

  key(): void {
    const key = this.start(K_KEY);
    while (true) {
      const k = this.peek();
      if (k !== TT_KEY && k !== TT_DOT) break;
      this.token(K_TEXT);
    }
    this.finish(key);
  }

  /** `a = 1` */
  keyAndValue(): number {
    this.key();
    if (this.tok < this.nTokens) {
      this.at = this.ends[this.tok] | 0;
      this.tok = this.tok + 1;
    }
    return this.value();
  }

  value(): number {
    const value = this.start(K_VALUE);
    const k = this.peek();
    if (k === TT_ARRAY_OPEN) {
      if (this.container(K_ARRAY) !== FORMAT_OK) return FORMAT_NESTED_TOO_DEEPLY;
    } else if (k === TT_INLINE_OPEN) {
      if (this.container(K_INLINE_TABLE) !== FORMAT_OK) return FORMAT_NESTED_TOO_DEEPLY;
    } else {
      this.token(K_TEXT);
      this.commentOnTheLine();
    }
    this.finish(value);
    return FORMAT_OK;
  }

  /** An array or an inline table. */
  container(kind: number): number {
    if (!this.stack.enter()) return FORMAT_NESTED_TOO_DEEPLY;
    const container = this.start(kind);
    this.token(K_OPEN);
    while (true) {
      this.trivia();
      const k = this.peek();
      if (k === TT_COMMA) {
        this.token(K_COMMA);
      } else if (k === TT_KEY) {
        const entry = this.start(K_ENTRY);
        if (this.keyAndValue() !== FORMAT_OK) {
          this.stack.leave();
          return FORMAT_NESTED_TOO_DEEPLY;
        }
        this.finish(entry);
      } else if (k === TT_ARRAY_CLOSE || k === TT_INLINE_CLOSE || k === -1) {
        break;
      } else if (this.value() !== FORMAT_OK) {
        this.stack.leave();
        return FORMAT_NESTED_TOO_DEEPLY;
      }
    }
    this.token(K_CLOSE);
    this.finish(container);
    this.stack.leave();
    return FORMAT_OK;
  }
}

/** The tree of this thread. */
export const tomlTree = new TomlTree();

/**
 * Makes the tree of `text`, whose tokens are those of the last `tomlTokens`. Returns `FORMAT_OK` or
 * `FORMAT_NESTED_TOO_DEEPLY`.
 */
export function buildTree(text: Uint8Array, len: number): number {
  const b = tomlTree;
  b.text = text;
  b.n = len;
  b.kinds = tomlTokenKinds();
  b.starts = tomlTokenStarts();
  b.ends = tomlTokenEnds();
  b.nTokens = tomlTokenCount();
  b.tok = 0;
  b.at = len >= 3 && (text[0] | 0) === 0xef && (text[1] | 0) === 0xbb && (text[2] | 0) === 0xbf ? 3 : 0;
  b.count = 0;
  b.stack.reset();
  while (true) {
    b.trivia();
    const kind = b.peek();
    if (kind < 0) return FORMAT_OK;
    if (kind === TT_KEY) {
      const entry = b.start(K_ENTRY);
      if (b.keyAndValue() !== FORMAT_OK) return FORMAT_NESTED_TOO_DEEPLY;
      b.commentOnTheLine();
      b.finish(entry);
    } else {
      const header = b.start(K_HEADER);
      b.token(K_TEXT);
      b.key();
      b.token(K_TEXT);
      b.commentOnTheLine();
      b.finish(header);
    }
  }
}
