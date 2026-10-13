// Port of vendor/bun/src/format/graphql/parser.rs: the lexer and the parser of graphql-js 17, which is what Prettier parses
// with, with `experimentalFragmentArguments`.
//
// The tree is flat (struct of arrays). A node has its kind, where it is in the text, and its children in source order, which
// are all the nodes that graphql-js has in it. What a child is to its parent is told from its kind and its place among the
// others. Nodes are numbered in the order they are finished (children before their parent): the root is the last.
//
// Rust `Result<T, Refused>` is an int here: `0` (or the value) is ok, `-1` is a refusal that has been noted with
// `noteRefusal(MSG_*, offset)` (syntax_error.ts). The top level reads `refusalMessage()` / `refusalOffset()`.
import { eqAscii } from "../../base/bytes.ts";
import { Stack } from "../../base/stack.ts";
import {
  MSG_EMPTY_EXTENSION,
  MSG_EXPECTED_CLOSING_BRACKET,
  MSG_EXPECTED_COLON,
  MSG_EXPECTED_DEFINITION,
  MSG_EXPECTED_DIGIT,
  MSG_EXPECTED_DIRECTIVE_LOCATION,
  MSG_EXPECTED_NAME,
  MSG_EXPECTED_OPENING_BRACE,
  MSG_EXPECTED_VALUE,
  MSG_INVALID_ESCAPE_SEQUENCE,
  MSG_INVALID_NUMBER,
  MSG_NESTED_TOO_DEEPLY,
  MSG_TOO_LARGE,
  MSG_UNCLOSED_STRING,
  MSG_UNEXPECTED_CHARACTER,
  MSG_UNEXPECTED_END,
  MSG_UNEXPECTED_TOKEN,
  noteRefusal,
} from "../syntax_error.ts";

// ---------------------------------------------------------------------------------------------- Kind

export const K_NAME: number = 0;
export const K_DOCUMENT: number = 1;
export const K_OPERATION_DEFINITION: number = 2;
export const K_VARIABLE_DEFINITION: number = 3;
export const K_VARIABLE: number = 4;
export const K_SELECTION_SET: number = 5;
export const K_FIELD: number = 6;
export const K_ARGUMENT: number = 7;
export const K_FRAGMENT_ARGUMENT: number = 8;
export const K_FRAGMENT_SPREAD: number = 9;
export const K_INLINE_FRAGMENT: number = 10;
export const K_FRAGMENT_DEFINITION: number = 11;
export const K_INT_VALUE: number = 12;
export const K_FLOAT_VALUE: number = 13;
export const K_STRING_VALUE: number = 14;
export const K_BOOLEAN_VALUE: number = 15;
export const K_NULL_VALUE: number = 16;
export const K_ENUM_VALUE: number = 17;
export const K_LIST_VALUE: number = 18;
export const K_OBJECT_VALUE: number = 19;
export const K_OBJECT_FIELD: number = 20;
export const K_DIRECTIVE: number = 21;
export const K_NAMED_TYPE: number = 22;
export const K_LIST_TYPE: number = 23;
export const K_NON_NULL_TYPE: number = 24;
export const K_SCHEMA_DEFINITION: number = 25;
export const K_OPERATION_TYPE_DEFINITION: number = 26;
export const K_SCALAR_TYPE_DEFINITION: number = 27;
export const K_OBJECT_TYPE_DEFINITION: number = 28;
export const K_FIELD_DEFINITION: number = 29;
export const K_INPUT_VALUE_DEFINITION: number = 30;
export const K_INTERFACE_TYPE_DEFINITION: number = 31;
export const K_UNION_TYPE_DEFINITION: number = 32;
export const K_ENUM_TYPE_DEFINITION: number = 33;
export const K_ENUM_VALUE_DEFINITION: number = 34;
export const K_INPUT_OBJECT_TYPE_DEFINITION: number = 35;
export const K_DIRECTIVE_DEFINITION: number = 36;
export const K_SCHEMA_EXTENSION: number = 37;
export const K_DIRECTIVE_EXTENSION: number = 38;
export const K_SCALAR_TYPE_EXTENSION: number = 39;
export const K_OBJECT_TYPE_EXTENSION: number = 40;
export const K_INTERFACE_TYPE_EXTENSION: number = 41;
export const K_UNION_TYPE_EXTENSION: number = 42;
export const K_ENUM_TYPE_EXTENSION: number = 43;
export const K_INPUT_OBJECT_TYPE_EXTENSION: number = 44;

// `Kind::is_type`
export function isTypeKind(k: number): boolean {
  return k === K_NAMED_TYPE || k === K_LIST_TYPE || k === K_NON_NULL_TYPE;
}

// `Kind::is_value`
export function isValueKind(k: number): boolean {
  return k === K_VARIABLE || (k >= K_INT_VALUE && k <= K_OBJECT_VALUE);
}

// Set by `attach` (comments.ts) on a node that has comments; the other bits of `flags` are the ones below.
export const F_COMMENT: number = 128; // in `flags`; bit 15 of the word
// Of a `Field`: its first child is the alias.
export const HAS_ALIAS: number = 1;
// Of a `StringValue`: `""" .. """`
export const IS_BLOCK: number = 1;
// Of a `DirectiveDefinition`
export const IS_REPEATABLE: number = 1;
// Of an `OperationDefinition` and an `OperationTypeDefinition`
export const QUERY: number = 0;
export const MUTATION: number = 1;
export const SUBSCRIPTION: number = 2;
// Of an `OperationDefinition`: it is only a selection set.
export const IS_SHORTHAND: number = 3;

// ---------------------------------------------------------------------------------------------- Tree

// A node is 8 words of `Tree.nodes` (32 bytes: the words of a node are in one cache line): its kind and flags, where it
// starts and ends, and its children (`children[first, first + count)`).
export const N_STRIDE_SHIFT: number = 3;
export const N_KIND_FLAGS: number = 0; // kind | flags << 8
export const N_START: number = 1;
export const N_END: number = 2;
export const N_FIRST: number = 3;
export const N_COUNT: number = 4;

export class Tree {
  nodes: Int32Array;
  nodeCount: number;
  /** The children of all nodes, one run per node. */
  children: Int32Array;
  childCount: number;
  /** The nodes that wait for their parent. */
  pending: Int32Array;
  pendingLen: number;
  /** From the `#` to the end of the line. */
  cStart: Int32Array;
  cEnd: Int32Array;
  commentCount: number;

  constructor() {
    this.nodes = new Int32Array(256 << N_STRIDE_SHIFT);
    this.nodeCount = 0;
    this.children = new Int32Array(256);
    this.childCount = 0;
    this.pending = new Int32Array(64);
    this.pendingLen = 0;
    this.cStart = new Int32Array(16);
    this.cEnd = new Int32Array(16);
    this.commentCount = 0;
  }

  clear(): void {
    this.nodeCount = 0;
    this.childCount = 0;
    this.pendingLen = 0;
    this.commentCount = 0;
  }

  /** The `Document` (0 if there is no node). */
  root(): number {
    const n = this.nodeCount;
    return n > 0 ? n - 1 : 0;
  }

  kindOf(id: number): number {
    return this.nodes[id << N_STRIDE_SHIFT] & 255;
  }
  flagsOf(id: number): number {
    return (this.nodes[id << N_STRIDE_SHIFT] >> 8) & 127;
  }
  startOf(id: number): number {
    return this.nodes[(id << N_STRIDE_SHIFT) + N_START] | 0;
  }
  endOf(id: number): number {
    return this.nodes[(id << N_STRIDE_SHIFT) + N_END] | 0;
  }
  firstOf(id: number): number {
    return this.nodes[(id << N_STRIDE_SHIFT) + N_FIRST] | 0;
  }
  countOf(id: number): number {
    return this.nodes[(id << N_STRIDE_SHIFT) + N_COUNT] | 0;
  }

  growNodes(): void {
    const a = new Int32Array(this.nodes.length * 2);
    a.set(this.nodes);
    this.nodes = a;
  }

  growChildren(need: number): void {
    let cap = this.children.length;
    while (cap < need) cap = cap * 2;
    const a = new Int32Array(cap);
    a.set(this.children);
    this.children = a;
  }

  growPending(need: number): void {
    let cap = this.pending.length;
    while (cap < need) cap = cap * 2;
    const a = new Int32Array(cap);
    a.set(this.pending);
    this.pending = a;
  }

  growComments(): void {
    const cap = this.cStart.length * 2;
    const s = new Int32Array(cap);
    s.set(this.cStart);
    this.cStart = s;
    const e = new Int32Array(cap);
    e.set(this.cEnd);
    this.cEnd = e;
  }
}

// ---------------------------------------------------------------------------------------------- tokens

const TK_SOF: number = 0;
const TK_EOF: number = 1;
const TK_BANG: number = 2;
const TK_DOLLAR: number = 3;
const TK_AMP: number = 4;
const TK_PAREN_L: number = 5;
const TK_PAREN_R: number = 6;
const TK_SPREAD: number = 7;
const TK_COLON: number = 8;
const TK_EQUALS: number = 9;
const TK_AT: number = 10;
const TK_BRACKET_L: number = 11;
const TK_BRACKET_R: number = 12;
const TK_BRACE_L: number = 13;
const TK_PIPE: number = 14;
const TK_BRACE_R: number = 15;
const TK_NAME: number = 16;
const TK_INT: number = 17;
const TK_FLOAT: number = 18;
const TK_STRING: number = 19;
const TK_BLOCK_STRING: number = 20;

// ---------------------------------------------------------------------------------------------- escapes

// How many bytes the escape read by the last `readEscape` takes.
let escLen = 0;
export function escapeLen(): number {
  return escLen;
}

function hexValue(b: number): number {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  if (b >= 65 && b <= 70) return b - 55;
  return -1;
}

// Four hex digits at text[at..], or -1.
function hex4(text: Uint8Array, at: number, end: number): number {
  if (at + 4 > end) return -1;
  const a = hexValue(text[at] | 0);
  const b = hexValue(text[at + 1] | 0);
  const c = hexValue(text[at + 2] | 0);
  const d = hexValue(text[at + 3] | 0);
  if (a < 0 || b < 0 || c < 0 || d < 0) return -1;
  return (a << 12) | (b << 8) | (c << 4) | d;
}

function isScalarValue(code: number): boolean {
  return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
}

/**
 * Rust `read_escape`: the escape sequence that `text[at..end)` starts with (a `\`): the code point that it stands for, or -1,
 * and its length in bytes in `escapeLen()`.
 */
export function readEscape(text: Uint8Array, at: number, end: number): number {
  if (at + 1 >= end) return -1;
  const b = text[at + 1] | 0;
  switch (b) {
    case 34:
      escLen = 2;
      return 34;
    case 92:
      escLen = 2;
      return 92;
    case 47:
      escLen = 2;
      return 47;
    case 98:
      escLen = 2;
      return 8;
    case 102:
      escLen = 2;
      return 12;
    case 110:
      escLen = 2;
      return 10;
    case 114:
      escLen = 2;
      return 13;
    case 116:
      escLen = 2;
      return 9;
    case 117:
      break;
    default:
      return -1;
  }
  // `\u{1F600}`
  if (at + 2 < end && (text[at + 2] | 0) === 123) {
    let code = 0;
    for (let size = 3; size < 12; size++) {
      if (at + size >= end) return -1;
      const c = text[at + size] | 0;
      if (c === 125) {
        if (size >= 4 && isScalarValue(code)) {
          escLen = size + 1;
          return code;
        }
        return -1;
      }
      const h = hexValue(c);
      if (h < 0) return -1;
      // `checked_shl(4)` only fails for a shift of 32 or more: the high bits are lost.
      code = (((code << 4) >>> 0) | h) >>> 0;
    }
    return -1;
  }
  const code = hex4(text, at + 2, end);
  if (code < 0) return -1;
  if (isScalarValue(code)) {
    escLen = 6;
    return code;
  }
  // Two halves of a character.
  if (code < 0xd800 || code > 0xdbff) return -1;
  if (at + 8 > end || (text[at + 6] | 0) !== 92 || (text[at + 7] | 0) !== 117) return -1;
  const trailing = hex4(text, at + 8, end);
  if (trailing < 0xdc00 || trailing > 0xdfff) return -1;
  escLen = 12;
  return 0x10000 + ((code - 0xd800) << 10) + (trailing - 0xdc00);
}

// ---------------------------------------------------------------------------------------------- the parser

// What `many` / `any` / `delimitedMany` read for an item.
const ITEM_DEFINITION = 0;
const ITEM_SELECTION = 1;
const ITEM_VARIABLE_DEFINITION = 2;
const ITEM_ARGUMENT = 3;
const ITEM_CONST_ARGUMENT = 4;
const ITEM_FRAGMENT_ARGUMENT = 5;
const ITEM_VALUE = 6;
const ITEM_CONST_VALUE = 7;
const ITEM_OBJECT_FIELD = 8;
const ITEM_CONST_OBJECT_FIELD = 9;
const ITEM_OPERATION_TYPE_DEFINITION = 10;
const ITEM_FIELD_DEFINITION = 11;
const ITEM_INPUT_VALUE_DEFINITION = 12;
const ITEM_ENUM_VALUE_DEFINITION = 13;
const ITEM_NAMED_TYPE = 14;
const ITEM_DIRECTIVE_LOCATION = 15;

const LOCATIONS: string[] = [
  "QUERY",
  "MUTATION",
  "SUBSCRIPTION",
  "FIELD",
  "FRAGMENT_DEFINITION",
  "FRAGMENT_SPREAD",
  "INLINE_FRAGMENT",
  "VARIABLE_DEFINITION",
  "FRAGMENT_VARIABLE_DEFINITION",
  "SCHEMA",
  "SCALAR",
  "OBJECT",
  "FIELD_DEFINITION",
  "ARGUMENT_DEFINITION",
  "INTERFACE",
  "UNION",
  "ENUM",
  "ENUM_VALUE",
  "INPUT_OBJECT",
  "INPUT_FIELD_DEFINITION",
  "DIRECTIVE_DEFINITION",
];

// How deep GraphQL can be nested. A door of the parser is a few small frames (measured, scriptc, 8 MiB: lists nest 30,000
// deep, selection sets 20,000 and more), a fraction of what a door of the JavaScript formatter is, so there is room for
// many more than `Stack`'s default of 1000.
let parserDoors = 16000;

/** For tests: how many nested doors the parser allows. */
export function setParserDoors(n: number): void {
  parserDoors = n;
}

class Parser {
  text: Uint8Array;
  n: number;
  tree: Tree;
  stack: Stack;
  // The current token.
  tokKind: number;
  tokStart: number;
  tokEnd: number;
  // The token after it, if it has been looked at.
  hasNext: boolean;
  nextKind: number;
  nextStart: number;
  nextEnd: number;
  // Where the token before the current one ends.
  lastEnd: number;
  // The result of `readToken` and `readNumber`.
  rtKind: number;
  rtStart: number;
  rtEnd: number;

  constructor() {
    this.text = new Uint8Array(0);
    this.n = 0;
    this.tree = new Tree();
    this.stack = new Stack(parserDoors);
    this.tokKind = TK_SOF;
    this.tokStart = 0;
    this.tokEnd = 0;
    this.hasNext = false;
    this.nextKind = 0;
    this.nextStart = 0;
    this.nextEnd = 0;
    this.lastEnd = 0;
    this.rtKind = 0;
    this.rtStart = 0;
    this.rtEnd = 0;
  }

  // ───────────────────────────── the lexer ─────────────────────────────

  /** The token at or after `start` goes to `rtKind`, `rtStart`, `rtEnd`. Comments on the way are noted. -1: refused. */
  readToken(start: number): number {
    const text = this.text;
    const n = this.n;
    let pos = start | 0;
    while (true) {
      // White space and commas: a loop of its own, whose variable is nothing but an index.
      let w = pos;
      while (w < n) {
        const d = text[w] | 0;
        if (d === 32 || d === 10 || d === 44 || d === 9 || d === 13) w = ((w | 0) + 1) | 0;
        else break;
      }
      pos = w;
      if (pos >= n) {
        this.rtKind = TK_EOF;
        this.rtStart = n;
        this.rtEnd = n;
        return 0;
      }
      const c = text[pos] | 0;
      // A name: the most frequent token.
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95) {
        let e = ((pos | 0) + 1) | 0;
        while (e < n) {
          const d = text[e] | 0;
          if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90) || (d >= 48 && d <= 57) || d === 95) e = ((e | 0) + 1) | 0;
          else break;
        }
        this.rtKind = TK_NAME;
        this.rtStart = pos;
        this.rtEnd = e;
        return 0;
      }
      let kind = 0;
      switch (c) {
        case 123:
          kind = TK_BRACE_L;
          break;
        case 125:
          kind = TK_BRACE_R;
          break;
        case 40:
          kind = TK_PAREN_L;
          break;
        case 41:
          kind = TK_PAREN_R;
          break;
        case 58:
          kind = TK_COLON;
          break;
        case 33:
          kind = TK_BANG;
          break;
        case 36:
          kind = TK_DOLLAR;
          break;
        case 38:
          kind = TK_AMP;
          break;
        case 61:
          kind = TK_EQUALS;
          break;
        case 64:
          kind = TK_AT;
          break;
        case 91:
          kind = TK_BRACKET_L;
          break;
        case 93:
          kind = TK_BRACKET_R;
          break;
        case 124:
          kind = TK_PIPE;
          break;
        case 35: {
          // A comment, to the end of the line.
          let e = ((pos | 0) + 1) | 0;
          while (e < n) {
            const d = text[e] | 0;
            if (d === 10 || d === 13) break;
            e = ((e | 0) + 1) | 0;
          }
          const tree = this.tree;
          let cc = tree.commentCount;
          if (cc === tree.cStart.length) tree.growComments();
          tree.cStart[cc] = pos | 0;
          tree.cEnd[cc] = e | 0;
          tree.commentCount = cc + 1;
          pos = e;
          continue;
        }
        case 34: {
          if (pos + 2 < n && (text[pos + 1] | 0) === 34 && (text[pos + 2] | 0) === 34) {
            const end = this.readBlockString(pos);
            if (end < 0) return -1;
            this.rtKind = TK_BLOCK_STRING;
            this.rtStart = pos;
            this.rtEnd = end;
            return 0;
          }
          const end = this.readString(pos);
          if (end < 0) return -1;
          this.rtKind = TK_STRING;
          this.rtStart = pos;
          this.rtEnd = end;
          return 0;
        }
        case 46:
          if (pos + 2 < n && (text[pos + 1] | 0) === 46 && (text[pos + 2] | 0) === 46) {
            this.rtKind = TK_SPREAD;
            this.rtStart = pos;
            this.rtEnd = pos + 3;
            return 0;
          }
          return noteRefusal(MSG_UNEXPECTED_CHARACTER, pos);
        case 0xef:
          if (pos + 2 < n && (text[pos + 1] | 0) === 0xbb && (text[pos + 2] | 0) === 0xbf) {
            pos = pos + 3;
            continue;
          }
          return noteRefusal(MSG_UNEXPECTED_CHARACTER, pos);
        default:
          if ((c >= 48 && c <= 57) || c === 45) {
            const end = this.readNumber(pos);
            if (end < 0) return -1;
            this.rtStart = pos;
            this.rtEnd = end;
            return 0;
          }
          return noteRefusal(MSG_UNEXPECTED_CHARACTER, pos);
      }
      this.rtKind = kind;
      this.rtStart = pos;
      this.rtEnd = ((pos | 0) + 1) | 0;
      return 0;
    }
  }

  /** Where the digits at `pos` end. There has to be one. -1: refused. */
  readDigits(pos: number): number {
    const text = this.text;
    const n = this.n;
    let e = pos;
    while (e < n) {
      const c = text[e] | 0;
      if (c < 48 || c > 57) break;
      e = ((e | 0) + 1) | 0;
    }
    if (e === pos) return noteRefusal(MSG_EXPECTED_DIGIT, pos);
    return e;
  }

  /** Where the number that starts at `start` ends (its kind is `rtKind`). -1: refused. */
  readNumber(start: number): number {
    const text = this.text;
    const n = this.n;
    let pos = start;
    let kind = TK_INT;
    if (pos < n && (text[pos] | 0) === 45) pos = pos + 1;
    if (pos < n && (text[pos] | 0) === 48) {
      pos = pos + 1;
      if (pos < n) {
        const c = text[pos] | 0;
        if (c >= 48 && c <= 57) return noteRefusal(MSG_INVALID_NUMBER, start);
      }
    } else {
      pos = this.readDigits(pos);
      if (pos < 0) return -1;
    }
    if (pos < n && (text[pos] | 0) === 46) {
      kind = TK_FLOAT;
      pos = this.readDigits(pos + 1);
      if (pos < 0) return -1;
    }
    if (pos < n) {
      const c = text[pos] | 0;
      if (c === 69 || c === 101) {
        kind = TK_FLOAT;
        pos = pos + 1;
        if (pos < n) {
          const s = text[pos] | 0;
          if (s === 43 || s === 45) pos = pos + 1;
        }
        pos = this.readDigits(pos);
        if (pos < 0) return -1;
      }
    }
    if (pos < n) {
      const c = text[pos] | 0;
      if (c === 46 || (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95) return noteRefusal(MSG_INVALID_NUMBER, start);
    }
    this.rtKind = kind;
    return pos;
  }

  /** Where the string that starts at `start` ends. -1: refused. */
  readString(start: number): number {
    const text = this.text;
    const n = this.n;
    let pos = start + 1;
    while (true) {
      while (pos < n) {
        const d = text[pos] | 0;
        if (d === 34 || d === 92 || d === 10 || d === 13) break;
        pos = ((pos | 0) + 1) | 0;
      }
      if (pos >= n) return noteRefusal(MSG_UNCLOSED_STRING, start);
      const c = text[pos] | 0;
      if (c === 34) return pos + 1;
      if (c === 92) {
        if (readEscape(text, pos, n) < 0) return noteRefusal(MSG_INVALID_ESCAPE_SEQUENCE, pos);
        pos = pos + escLen;
      } else {
        return noteRefusal(MSG_UNCLOSED_STRING, start);
      }
    }
  }

  readBlockString(start: number): number {
    const text = this.text;
    const n = this.n;
    let pos = start + 3;
    while (true) {
      // The next `"""`.
      let found = -1;
      let i = pos;
      const last = n - 3;
      while (i <= last) {
        if ((text[i] | 0) === 34 && (text[i + 1] | 0) === 34 && (text[i + 2] | 0) === 34) {
          found = i;
          break;
        }
        i = ((i | 0) + 1) | 0;
      }
      if (found < 0) return noteRefusal(MSG_UNCLOSED_STRING, start);
      pos = found;
      // `\"""` is not the end.
      if (pos > start + 3 && (text[pos - 1] | 0) === 92) pos = pos + 3;
      else return pos + 3;
    }
  }

  advance(): number {
    this.lastEnd = this.tokEnd;
    if (this.tokKind === TK_EOF) {
      this.hasNext = false;
      return 0;
    }
    if (this.hasNext) {
      this.tokKind = this.nextKind;
      this.tokStart = this.nextStart;
      this.tokEnd = this.nextEnd;
    } else {
      if (this.readToken(this.tokEnd) < 0) return -1;
      this.tokKind = this.rtKind;
      this.tokStart = this.rtStart;
      this.tokEnd = this.rtEnd;
    }
    this.hasNext = false;
    return 0;
  }

  /** Reads the token after the current one into `rtKind`, `rtStart`, `rtEnd`. -1: refused. */
  lookahead(): number {
    if (this.tokKind === TK_EOF) {
      this.rtKind = this.tokKind;
      this.rtStart = this.tokStart;
      this.rtEnd = this.tokEnd;
      return 0;
    }
    if (!this.hasNext) {
      if (this.readToken(this.tokEnd) < 0) return -1;
      this.hasNext = true;
      this.nextKind = this.rtKind;
      this.nextStart = this.rtStart;
      this.nextEnd = this.rtEnd;
    } else {
      this.rtKind = this.nextKind;
      this.rtStart = this.nextStart;
      this.rtEnd = this.nextEnd;
    }
    return 0;
  }

  textIs(start: number, end: number, lit: string): boolean {
    return end - start === lit.length && eqAscii(this.text, start, lit);
  }

  peek(kind: number): boolean {
    return this.tokKind === kind;
  }

  /** `message`, where the current token is. Returns -1. */
  unexpected(message: number): number {
    return noteRefusal(this.tokKind === TK_EOF ? MSG_UNEXPECTED_END : message, this.tokStart);
  }

  expect(kind: number): number {
    if (this.tokKind !== kind) {
      let message = MSG_UNEXPECTED_TOKEN;
      if (kind === TK_NAME) message = MSG_EXPECTED_NAME;
      else if (kind === TK_COLON) message = MSG_EXPECTED_COLON;
      else if (kind === TK_BRACE_L) message = MSG_EXPECTED_OPENING_BRACE;
      else if (kind === TK_BRACKET_R) message = MSG_EXPECTED_CLOSING_BRACKET;
      return this.unexpected(message);
    }
    return this.advance();
  }

  /** 1 if it was there (and has been read), 0 if not, -1: refused. */
  eat(kind: number): number {
    if (this.tokKind !== kind) return 0;
    if (this.advance() < 0) return -1;
    return 1;
  }

  expectKeyword(keyword: string): number {
    const r = this.eatKeyword(keyword);
    if (r < 0) return -1;
    if (r === 0) return this.unexpected(MSG_UNEXPECTED_TOKEN);
    return 0;
  }

  eatKeyword(keyword: string): number {
    if (this.tokKind !== TK_NAME || !this.textIs(this.tokStart, this.tokEnd, keyword)) return 0;
    if (this.advance() < 0) return -1;
    return 1;
  }

  // ───────────────────────────── nodes ─────────────────────────────

  /** The node that started at `start` (with `firstPending` nodes waiting before it) ends before the current token. */
  finish(kind: number, flags: number, start: number, firstPending: number): void {
    const t = this.tree;
    const firstChild = t.childCount;
    const pl = t.pendingLen;
    const fp = firstPending > pl ? pl : firstPending;
    const taken = pl - fp;
    if (firstChild + taken > t.children.length) t.growChildren(firstChild + taken);
    const children = t.children;
    const pending = t.pending;
    for (let i = 0; i < taken; i++) children[firstChild + i] = pending[fp + i] | 0;
    t.childCount = firstChild + taken;
    const id = t.nodeCount;
    if ((id << N_STRIDE_SHIFT) === t.nodes.length) t.growNodes();
    if (fp + 1 > t.pending.length) t.growPending(fp + 1);
    t.pending[fp] = id | 0;
    t.pendingLen = fp + 1;
    const nodes = t.nodes;
    const b = id << N_STRIDE_SHIFT;
    nodes[b] = (kind | (flags << 8)) | 0;
    nodes[b + 1] = start | 0;
    const e = this.lastEnd;
    nodes[b + 2] = (e > start ? e : start) | 0;
    nodes[b + 3] = firstChild | 0;
    nodes[b + 4] = taken | 0;
    t.nodeCount = id + 1;
  }

  /** The current token is all of a node. */
  tokenAs(kind: number, flags: number): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.advance() < 0) return -1;
    this.finish(kind, flags, start, fp);
    return 0;
  }

  checkDepth(): number {
    if (this.stack.enter()) return 0;
    return noteRefusal(MSG_NESTED_TOO_DEEPLY, this.tokStart);
  }

  parseItem(item: number): number {
    switch (item) {
      case ITEM_DEFINITION:
        return this.parseDefinition();
      case ITEM_SELECTION:
        return this.tokKind === TK_SPREAD ? this.parseFragment() : this.parseField();
      case ITEM_VARIABLE_DEFINITION:
        return this.parseVariableDefinition();
      case ITEM_ARGUMENT:
        return this.parseNamedValue(K_ARGUMENT, false);
      case ITEM_CONST_ARGUMENT:
        return this.parseNamedValue(K_ARGUMENT, true);
      case ITEM_FRAGMENT_ARGUMENT:
        return this.parseNamedValue(K_FRAGMENT_ARGUMENT, false);
      case ITEM_VALUE:
        return this.parseValueLiteral(false);
      case ITEM_CONST_VALUE:
        return this.parseValueLiteral(true);
      case ITEM_OBJECT_FIELD:
        return this.parseNamedValue(K_OBJECT_FIELD, false);
      case ITEM_CONST_OBJECT_FIELD:
        return this.parseNamedValue(K_OBJECT_FIELD, true);
      case ITEM_OPERATION_TYPE_DEFINITION:
        return this.parseOperationTypeDefinition();
      case ITEM_FIELD_DEFINITION:
        return this.parseFieldDefinition();
      case ITEM_INPUT_VALUE_DEFINITION:
        return this.parseInputValueDefinition();
      case ITEM_ENUM_VALUE_DEFINITION:
        return this.parseEnumValueDefinition();
      case ITEM_NAMED_TYPE:
        return this.parseNamedType();
      default:
        return this.parseDirectiveLocation();
    }
  }

  /** `open item+ close` */
  many(open: number, item: number, close: number): number {
    if (this.expect(open) < 0) return -1;
    while (true) {
      if (this.parseItem(item) < 0) return -1;
      const r = this.eat(close);
      if (r !== 0) return r < 0 ? -1 : 0;
    }
  }

  /** The same, if it is there. Returns whether it is (1), 0, or -1: refused. */
  optionalMany(open: number, item: number, close: number): number {
    if (this.tokKind !== open) return 0;
    if (this.many(open, item, close) < 0) return -1;
    return 1;
  }

  /** `open item* close` */
  any(open: number, item: number, close: number): number {
    if (this.expect(open) < 0) return -1;
    while (true) {
      const r = this.eat(close);
      if (r < 0) return -1;
      if (r === 1) return 0;
      if (this.parseItem(item) < 0) return -1;
    }
  }

  /** `delimiter? item (delimiter item)*` */
  delimitedMany(delimiter: number, item: number): number {
    if (this.eat(delimiter) < 0) return -1;
    while (true) {
      if (this.parseItem(item) < 0) return -1;
      const r = this.eat(delimiter);
      if (r < 0) return -1;
      if (r === 0) return 0;
    }
  }

  // ───────────────────────────── the grammar ─────────────────────────────

  parseName(): number {
    if (this.tokKind === TK_NAME) return this.tokenAs(K_NAME, 0);
    return this.unexpected(MSG_EXPECTED_NAME);
  }

  parseDocument(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.many(TK_SOF, ITEM_DEFINITION, TK_EOF) < 0) return -1;
    this.finish(K_DOCUMENT, 0, start, fp);
    return 0;
  }

  parseDefinition(): number {
    if (this.tokKind === TK_BRACE_L) return this.parseOperationDefinition();
    const hasDescription = this.tokKind === TK_STRING || this.tokKind === TK_BLOCK_STRING;
    let kwKind = this.tokKind;
    let kwStart = this.tokStart;
    let kwEnd = this.tokEnd;
    if (hasDescription) {
      if (this.lookahead() < 0) return -1;
      kwKind = this.rtKind;
      kwStart = this.rtStart;
      kwEnd = this.rtEnd;
    }
    if (kwKind !== TK_NAME) return this.unexpected(MSG_EXPECTED_DEFINITION);
    const len = kwEnd - kwStart;
    const text = this.text;
    const c0 = text[kwStart] | 0;
    // schema scalar type interface union enum input directive query mutation subscription fragment extend
    if (c0 === 115) {
      if (this.textIs(kwStart, kwEnd, "schema")) return this.parseSchemaDefinition();
      if (this.textIs(kwStart, kwEnd, "scalar")) return this.parseScalarTypeDefinition();
      if (this.textIs(kwStart, kwEnd, "subscription")) return this.parseOperationDefinition();
    } else if (c0 === 116) {
      if (this.textIs(kwStart, kwEnd, "type")) return this.parseObjectLikeDefinition("type", K_OBJECT_TYPE_DEFINITION);
    } else if (c0 === 105) {
      if (this.textIs(kwStart, kwEnd, "interface")) return this.parseObjectLikeDefinition("interface", K_INTERFACE_TYPE_DEFINITION);
      if (this.textIs(kwStart, kwEnd, "input")) return this.parseInputObjectTypeDefinition();
    } else if (c0 === 117) {
      if (this.textIs(kwStart, kwEnd, "union")) return this.parseUnionTypeDefinition();
    } else if (c0 === 101) {
      if (this.textIs(kwStart, kwEnd, "enum")) return this.parseEnumTypeDefinition();
      if (len === 6 && this.textIs(kwStart, kwEnd, "extend") && !hasDescription) return this.parseTypeSystemExtension();
    } else if (c0 === 100) {
      if (this.textIs(kwStart, kwEnd, "directive")) return this.parseDirectiveDefinition();
    } else if (c0 === 113) {
      if (this.textIs(kwStart, kwEnd, "query")) return this.parseOperationDefinition();
    } else if (c0 === 109) {
      if (this.textIs(kwStart, kwEnd, "mutation")) return this.parseOperationDefinition();
    } else if (c0 === 102) {
      if (this.textIs(kwStart, kwEnd, "fragment")) return this.parseFragmentDefinition();
    }
    return this.unexpected(MSG_EXPECTED_DEFINITION);
  }

  parseOperationDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    let flags = IS_SHORTHAND;
    if (this.tokKind !== TK_BRACE_L) {
      if (this.parseDescription() < 0) return -1;
      flags = this.parseOperationType();
      if (flags < 0) return -1;
      if (this.tokKind === TK_NAME) {
        if (this.parseName() < 0) return -1;
      }
      if (this.optionalMany(TK_PAREN_L, ITEM_VARIABLE_DEFINITION, TK_PAREN_R) < 0) return -1;
      if (this.parseDirectivesOf(false) < 0) return -1;
    }
    if (this.parseSelectionSet() < 0) return -1;
    this.finish(K_OPERATION_DEFINITION, flags, start, fp);
    return 0;
  }

  /** `query`, `mutation` or `subscription`, which is not a node but a flag of the node it is in. -1: refused. */
  parseOperationType(): number {
    const s = this.tokStart;
    const e = this.tokEnd;
    if (this.expect(TK_NAME) < 0) return -1;
    if (this.textIs(s, e, "query")) return QUERY;
    if (this.textIs(s, e, "mutation")) return MUTATION;
    if (this.textIs(s, e, "subscription")) return SUBSCRIPTION;
    return noteRefusal(MSG_EXPECTED_DEFINITION, s);
  }

  parseVariableDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.parseVariable() < 0) return -1;
    if (this.expect(TK_COLON) < 0) return -1;
    if (this.parseTypeReference() < 0) return -1;
    const r = this.eat(TK_EQUALS);
    if (r < 0) return -1;
    if (r === 1) {
      if (this.parseValueLiteral(true) < 0) return -1;
    }
    if (this.parseDirectivesOf(true) < 0) return -1;
    this.finish(K_VARIABLE_DEFINITION, 0, start, fp);
    return 0;
  }

  parseVariable(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.expect(TK_DOLLAR) < 0) return -1;
    if (this.parseName() < 0) return -1;
    this.finish(K_VARIABLE, 0, start, fp);
    return 0;
  }

  parseSelectionSet(): number {
    if (this.checkDepth() < 0) return -1;
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.many(TK_BRACE_L, ITEM_SELECTION, TK_BRACE_R) < 0) return -1;
    this.finish(K_SELECTION_SET, 0, start, fp);
    this.stack.leave();
    return 0;
  }

  parseField(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseName() < 0) return -1;
    const alias = this.eat(TK_COLON);
    if (alias < 0) return -1;
    if (alias === 1) {
      if (this.parseName() < 0) return -1;
    }
    if (this.optionalMany(TK_PAREN_L, ITEM_ARGUMENT, TK_PAREN_R) < 0) return -1;
    if (this.parseDirectivesOf(false) < 0) return -1;
    if (this.tokKind === TK_BRACE_L) {
      if (this.parseSelectionSet() < 0) return -1;
    }
    this.finish(K_FIELD, alias === 1 ? HAS_ALIAS : 0, start, fp);
    return 0;
  }

  /** `name: value` */
  parseNamedValue(kind: number, isConst: boolean): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseName() < 0) return -1;
    if (this.expect(TK_COLON) < 0) return -1;
    if (this.parseValueLiteral(isConst) < 0) return -1;
    this.finish(kind, 0, start, fp);
    return 0;
  }

  parseFragment(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.expect(TK_SPREAD) < 0) return -1;
    const hasTypeCondition = this.eatKeyword("on");
    if (hasTypeCondition < 0) return -1;
    if (hasTypeCondition === 0 && this.tokKind === TK_NAME) {
      if (this.parseFragmentName() < 0) return -1;
      if (this.optionalMany(TK_PAREN_L, ITEM_FRAGMENT_ARGUMENT, TK_PAREN_R) < 0) return -1;
      if (this.parseDirectivesOf(false) < 0) return -1;
      this.finish(K_FRAGMENT_SPREAD, 0, start, fp);
      return 0;
    }
    if (hasTypeCondition === 1) {
      if (this.parseNamedType() < 0) return -1;
    }
    if (this.parseDirectivesOf(false) < 0) return -1;
    if (this.parseSelectionSet() < 0) return -1;
    this.finish(K_INLINE_FRAGMENT, 0, start, fp);
    return 0;
  }

  parseFragmentDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.expectKeyword("fragment") < 0) return -1;
    if (this.parseFragmentName() < 0) return -1;
    if (this.optionalMany(TK_PAREN_L, ITEM_VARIABLE_DEFINITION, TK_PAREN_R) < 0) return -1;
    if (this.expectKeyword("on") < 0) return -1;
    if (this.parseNamedType() < 0) return -1;
    if (this.parseDirectivesOf(false) < 0) return -1;
    if (this.parseSelectionSet() < 0) return -1;
    this.finish(K_FRAGMENT_DEFINITION, 0, start, fp);
    return 0;
  }

  parseFragmentName(): number {
    if (this.tokKind === TK_NAME && this.textIs(this.tokStart, this.tokEnd, "on")) return this.unexpected(MSG_EXPECTED_NAME);
    return this.parseName();
  }

  parseValueLiteral(isConst: boolean): number {
    const kind = this.tokKind;
    switch (kind) {
      case TK_BRACKET_L: {
        if (this.checkDepth() < 0) return -1;
        const start = this.tokStart;
        const fp = this.tree.pendingLen;
        if (this.any(TK_BRACKET_L, isConst ? ITEM_CONST_VALUE : ITEM_VALUE, TK_BRACKET_R) < 0) return -1;
        this.finish(K_LIST_VALUE, 0, start, fp);
        this.stack.leave();
        return 0;
      }
      case TK_BRACE_L: {
        if (this.checkDepth() < 0) return -1;
        const start = this.tokStart;
        const fp = this.tree.pendingLen;
        if (this.any(TK_BRACE_L, isConst ? ITEM_CONST_OBJECT_FIELD : ITEM_OBJECT_FIELD, TK_BRACE_R) < 0) return -1;
        this.finish(K_OBJECT_VALUE, 0, start, fp);
        this.stack.leave();
        return 0;
      }
      case TK_INT:
        return this.tokenAs(K_INT_VALUE, 0);
      case TK_FLOAT:
        return this.tokenAs(K_FLOAT_VALUE, 0);
      case TK_STRING:
        return this.tokenAs(K_STRING_VALUE, 0);
      case TK_BLOCK_STRING:
        return this.tokenAs(K_STRING_VALUE, IS_BLOCK);
      case TK_NAME: {
        const s = this.tokStart;
        const e = this.tokEnd;
        let k = K_ENUM_VALUE;
        if (this.textIs(s, e, "true") || this.textIs(s, e, "false")) k = K_BOOLEAN_VALUE;
        else if (this.textIs(s, e, "null")) k = K_NULL_VALUE;
        return this.tokenAs(k, 0);
      }
      case TK_DOLLAR:
        if (!isConst) return this.parseVariable();
        return this.unexpected(MSG_EXPECTED_VALUE);
      default:
        return this.unexpected(MSG_EXPECTED_VALUE);
    }
  }

  /** The directives, if there are some. Returns whether there are (1), 0, or -1: refused. */
  parseDirectivesOf(isConst: boolean): number {
    const isThere = this.tokKind === TK_AT ? 1 : 0;
    while (this.tokKind === TK_AT) {
      const start = this.tokStart;
      const fp = this.tree.pendingLen;
      if (this.advance() < 0) return -1;
      if (this.parseName() < 0) return -1;
      if (this.optionalMany(TK_PAREN_L, isConst ? ITEM_CONST_ARGUMENT : ITEM_ARGUMENT, TK_PAREN_R) < 0) return -1;
      this.finish(K_DIRECTIVE, 0, start, fp);
    }
    return isThere;
  }

  parseTypeReference(): number {
    if (this.checkDepth() < 0) return -1;
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    const bracket = this.eat(TK_BRACKET_L);
    if (bracket < 0) return -1;
    if (bracket === 1) {
      if (this.parseTypeReference() < 0) return -1;
      if (this.expect(TK_BRACKET_R) < 0) return -1;
      this.finish(K_LIST_TYPE, 0, start, fp);
    } else {
      if (this.parseNamedType() < 0) return -1;
    }
    const bang = this.eat(TK_BANG);
    if (bang < 0) return -1;
    if (bang === 1) this.finish(K_NON_NULL_TYPE, 0, start, fp);
    this.stack.leave();
    return 0;
  }

  parseNamedType(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseName() < 0) return -1;
    this.finish(K_NAMED_TYPE, 0, start, fp);
    return 0;
  }

  parseDescription(): number {
    if (this.tokKind === TK_STRING) return this.tokenAs(K_STRING_VALUE, 0);
    if (this.tokKind === TK_BLOCK_STRING) return this.tokenAs(K_STRING_VALUE, IS_BLOCK);
    return 0;
  }

  parseSchemaDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.expectKeyword("schema") < 0) return -1;
    if (this.parseDirectivesOf(true) < 0) return -1;
    if (this.many(TK_BRACE_L, ITEM_OPERATION_TYPE_DEFINITION, TK_BRACE_R) < 0) return -1;
    this.finish(K_SCHEMA_DEFINITION, 0, start, fp);
    return 0;
  }

  parseOperationTypeDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    const operation = this.parseOperationType();
    if (operation < 0) return -1;
    if (this.expect(TK_COLON) < 0) return -1;
    if (this.parseNamedType() < 0) return -1;
    this.finish(K_OPERATION_TYPE_DEFINITION, operation, start, fp);
    return 0;
  }

  parseScalarTypeDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.expectKeyword("scalar") < 0) return -1;
    if (this.parseName() < 0) return -1;
    if (this.parseDirectivesOf(true) < 0) return -1;
    this.finish(K_SCALAR_TYPE_DEFINITION, 0, start, fp);
    return 0;
  }

  /** `type A implements B @c { .. }`, `interface A ..` */
  parseObjectLikeDefinition(keyword: string, kind: number): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.expectKeyword(keyword) < 0) return -1;
    if (this.parseName() < 0) return -1;
    if (this.parseImplementsInterfaces() < 0) return -1;
    if (this.parseDirectivesOf(true) < 0) return -1;
    if (this.optionalMany(TK_BRACE_L, ITEM_FIELD_DEFINITION, TK_BRACE_R) < 0) return -1;
    this.finish(kind, 0, start, fp);
    return 0;
  }

  parseImplementsInterfaces(): number {
    const isThere = this.eatKeyword("implements");
    if (isThere < 0) return -1;
    if (isThere === 1) {
      if (this.delimitedMany(TK_AMP, ITEM_NAMED_TYPE) < 0) return -1;
    }
    return isThere;
  }

  parseFieldDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.parseName() < 0) return -1;
    if (this.optionalMany(TK_PAREN_L, ITEM_INPUT_VALUE_DEFINITION, TK_PAREN_R) < 0) return -1;
    if (this.expect(TK_COLON) < 0) return -1;
    if (this.parseTypeReference() < 0) return -1;
    if (this.parseDirectivesOf(true) < 0) return -1;
    this.finish(K_FIELD_DEFINITION, 0, start, fp);
    return 0;
  }

  parseInputValueDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.parseName() < 0) return -1;
    if (this.expect(TK_COLON) < 0) return -1;
    if (this.parseTypeReference() < 0) return -1;
    const eq = this.eat(TK_EQUALS);
    if (eq < 0) return -1;
    if (eq === 1) {
      if (this.parseValueLiteral(true) < 0) return -1;
    }
    if (this.parseDirectivesOf(true) < 0) return -1;
    this.finish(K_INPUT_VALUE_DEFINITION, 0, start, fp);
    return 0;
  }

  parseUnionTypeDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.expectKeyword("union") < 0) return -1;
    if (this.parseName() < 0) return -1;
    if (this.parseDirectivesOf(true) < 0) return -1;
    if (this.parseUnionMemberTypes() < 0) return -1;
    this.finish(K_UNION_TYPE_DEFINITION, 0, start, fp);
    return 0;
  }

  parseUnionMemberTypes(): number {
    const isThere = this.eat(TK_EQUALS);
    if (isThere < 0) return -1;
    if (isThere === 1) {
      if (this.delimitedMany(TK_PIPE, ITEM_NAMED_TYPE) < 0) return -1;
    }
    return isThere;
  }

  parseEnumTypeDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.expectKeyword("enum") < 0) return -1;
    if (this.parseName() < 0) return -1;
    if (this.parseDirectivesOf(true) < 0) return -1;
    if (this.optionalMany(TK_BRACE_L, ITEM_ENUM_VALUE_DEFINITION, TK_BRACE_R) < 0) return -1;
    this.finish(K_ENUM_TYPE_DEFINITION, 0, start, fp);
    return 0;
  }

  parseEnumValueDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    const s = this.tokStart;
    const e = this.tokEnd;
    if (this.textIs(s, e, "true") || this.textIs(s, e, "false") || this.textIs(s, e, "null")) return this.unexpected(MSG_EXPECTED_NAME);
    if (this.parseName() < 0) return -1;
    if (this.parseDirectivesOf(true) < 0) return -1;
    this.finish(K_ENUM_VALUE_DEFINITION, 0, start, fp);
    return 0;
  }

  parseInputObjectTypeDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.expectKeyword("input") < 0) return -1;
    if (this.parseName() < 0) return -1;
    if (this.parseDirectivesOf(true) < 0) return -1;
    if (this.optionalMany(TK_BRACE_L, ITEM_INPUT_VALUE_DEFINITION, TK_BRACE_R) < 0) return -1;
    this.finish(K_INPUT_OBJECT_TYPE_DEFINITION, 0, start, fp);
    return 0;
  }

  /** `extend ..`. An extension has to add something. */
  parseTypeSystemExtension(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.expectKeyword("extend") < 0) return -1;
    const ks = this.tokStart;
    const ke = this.tokEnd;
    if (this.expect(TK_NAME) < 0) return -1;
    let kind = 0;
    let addsSomething = 0;
    if (this.textIs(ks, ke, "schema")) {
      const hasDirectives = this.parseDirectivesOf(true);
      if (hasDirectives < 0) return -1;
      const hasTypes = this.optionalMany(TK_BRACE_L, ITEM_OPERATION_TYPE_DEFINITION, TK_BRACE_R);
      if (hasTypes < 0) return -1;
      kind = K_SCHEMA_EXTENSION;
      addsSomething = hasDirectives | hasTypes;
    } else if (this.textIs(ks, ke, "scalar")) {
      if (this.parseName() < 0) return -1;
      const d = this.parseDirectivesOf(true);
      if (d < 0) return -1;
      kind = K_SCALAR_TYPE_EXTENSION;
      addsSomething = d;
    } else if (this.textIs(ks, ke, "type") || this.textIs(ks, ke, "interface")) {
      kind = this.textIs(ks, ke, "type") ? K_OBJECT_TYPE_EXTENSION : K_INTERFACE_TYPE_EXTENSION;
      if (this.parseName() < 0) return -1;
      const hasInterfaces = this.parseImplementsInterfaces();
      if (hasInterfaces < 0) return -1;
      const hasDirectives = this.parseDirectivesOf(true);
      if (hasDirectives < 0) return -1;
      const hasFields = this.optionalMany(TK_BRACE_L, ITEM_FIELD_DEFINITION, TK_BRACE_R);
      if (hasFields < 0) return -1;
      addsSomething = hasInterfaces | hasDirectives | hasFields;
    } else if (this.textIs(ks, ke, "union")) {
      if (this.parseName() < 0) return -1;
      const hasDirectives = this.parseDirectivesOf(true);
      if (hasDirectives < 0) return -1;
      const hasTypes = this.parseUnionMemberTypes();
      if (hasTypes < 0) return -1;
      kind = K_UNION_TYPE_EXTENSION;
      addsSomething = hasDirectives | hasTypes;
    } else if (this.textIs(ks, ke, "enum")) {
      if (this.parseName() < 0) return -1;
      const hasDirectives = this.parseDirectivesOf(true);
      if (hasDirectives < 0) return -1;
      const hasValues = this.optionalMany(TK_BRACE_L, ITEM_ENUM_VALUE_DEFINITION, TK_BRACE_R);
      if (hasValues < 0) return -1;
      kind = K_ENUM_TYPE_EXTENSION;
      addsSomething = hasDirectives | hasValues;
    } else if (this.textIs(ks, ke, "input")) {
      if (this.parseName() < 0) return -1;
      const hasDirectives = this.parseDirectivesOf(true);
      if (hasDirectives < 0) return -1;
      const hasFields = this.optionalMany(TK_BRACE_L, ITEM_INPUT_VALUE_DEFINITION, TK_BRACE_R);
      if (hasFields < 0) return -1;
      kind = K_INPUT_OBJECT_TYPE_EXTENSION;
      addsSomething = hasDirectives | hasFields;
    } else if (this.textIs(ks, ke, "directive")) {
      if (this.expect(TK_AT) < 0) return -1;
      if (this.parseName() < 0) return -1;
      const d = this.parseDirectivesOf(true);
      if (d < 0) return -1;
      kind = K_DIRECTIVE_EXTENSION;
      addsSomething = d;
    } else {
      return this.unexpected(MSG_EXPECTED_DEFINITION);
    }
    if (addsSomething === 0) return noteRefusal(MSG_EMPTY_EXTENSION, this.lastEnd);
    this.finish(kind, 0, start, fp);
    return 0;
  }

  parseDirectiveDefinition(): number {
    const start = this.tokStart;
    const fp = this.tree.pendingLen;
    if (this.parseDescription() < 0) return -1;
    if (this.expectKeyword("directive") < 0) return -1;
    if (this.expect(TK_AT) < 0) return -1;
    if (this.parseName() < 0) return -1;
    if (this.optionalMany(TK_PAREN_L, ITEM_INPUT_VALUE_DEFINITION, TK_PAREN_R) < 0) return -1;
    if (this.parseDirectivesOf(true) < 0) return -1;
    const isRepeatable = this.eatKeyword("repeatable");
    if (isRepeatable < 0) return -1;
    if (this.expectKeyword("on") < 0) return -1;
    if (this.delimitedMany(TK_PIPE, ITEM_DIRECTIVE_LOCATION) < 0) return -1;
    this.finish(K_DIRECTIVE_DEFINITION, isRepeatable === 1 ? IS_REPEATABLE : 0, start, fp);
    return 0;
  }

  parseDirectiveLocation(): number {
    const s = this.tokStart;
    const e = this.tokEnd;
    for (let i = 0; i < LOCATIONS.length; i++) {
      if (this.textIs(s, e, LOCATIONS[i])) return this.parseName();
    }
    return this.unexpected(MSG_EXPECTED_DIRECTIVE_LOCATION);
  }
}

const parser = new Parser();

/**
 * Fills `tree` with the syntax of `text`. Returns 0, or -1: refused (`refusalMessage()` / `refusalOffset()`; the message
 * `MSG_NESTED_TOO_DEEPLY` is the stack running out).
 */
export function parse(text: Uint8Array, tree: Tree): number {
  tree.clear();
  if (text.length > 134217728) return noteRefusal(MSG_TOO_LARGE, 0);
  const p = parser;
  p.text = text;
  p.n = text.length;
  p.tree = tree;
  p.stack.limit = parserDoors;
  p.stack.reset();
  p.tokKind = TK_SOF;
  p.tokStart = 0;
  p.tokEnd = 0;
  p.hasNext = false;
  p.lastEnd = 0;
  const r = p.parseDocument();
  // Do not keep the text and the tree alive.
  p.text = EMPTY;
  return r;
}

const EMPTY = new Uint8Array(0);
