// Port of vendor/bun/src/format/handlebars/parser.rs: the grammar of `@handlebars/parser` (`src/handlebars.yy`,
// `lib/helpers.js`).
//
// Statements go to a list of their own (`Statements`), for `tokenizer.ts` to make the tree of. Expressions go to the
// tree as `@glimmer/syntax` has them (`HandlebarsNodeVisitors`). What it refuses is only refused when it gets to see
// the statement, which it does not in an HTML comment: `valid`.
//
// Rust `Result<_, Error>` is an int: >= 0 ok, -1 a syntax error (noted with `noteRefusal`), -2 nested too deeply.
// An `Expression` is the slots `ex*` of the parser, filled by `expression()`, `path()` and `subExpression()`.
import { bytesToString, indexOfByte } from "../../base/bytes.ts";
import { Stack } from "../../base/stack.ts";
import {
  MSG_EXPECTED_CLOSING_PARENTHESIS,
  MSG_EXPECTED_END_OF_MUSTACHE,
  MSG_EXPECTED_NAME,
  MSG_INVALID_PATH,
  MSG_UNCLOSED_BLOCK,
  MSG_UNEXPECTED_END,
  MSG_UNEXPECTED_TOKEN,
  MSG_WRONG_NAME_AT_END_OF_BLOCK,
  noteRefusal,
} from "../syntax_error.ts";
import { I32Vec } from "../../base/i32vec.ts";
import {
  CHAINED,
  CLOSE_CLOSE,
  CLOSE_OPEN,
  H_AT,
  H_THIS,
  H_VAR,
  INVERSE_CLOSE,
  INVERSE_OPEN,
  K_BLOCK_STATEMENT,
  K_BOOLEAN,
  K_HASH_PAIR,
  K_MUSTACHE,
  K_NULL,
  K_NUMBER,
  K_PATH,
  K_STRING,
  K_SUB_EXPRESSION,
  K_UNDEFINED,
  NOTHING,
  OPEN_CLOSE,
  OPEN_OPEN,
  Tree,
} from "./ast.ts";
import {
  TK_CLOSE,
  TK_CLOSE_BLOCK_PARAMS,
  TK_CLOSE_RAW_BLOCK,
  TK_CLOSE_SEXPR,
  TK_CLOSE_UNESCAPED,
  TK_COMMENT,
  TK_CONTENT,
  TK_DATA,
  TK_END_RAW_BLOCK,
  TK_EOF,
  TK_EQUALS,
  TK_BOOLEAN,
  TK_ID,
  TK_INVERSE,
  TK_NULL,
  TK_NUMBER,
  TK_OPEN,
  TK_OPEN_BLOCK,
  TK_OPEN_BLOCK_PARAMS,
  TK_OPEN_END_BLOCK,
  TK_OPEN_INVERSE,
  TK_OPEN_INVERSE_CHAIN,
  TK_OPEN_PARTIAL,
  TK_OPEN_PARTIAL_BLOCK,
  TK_OPEN_RAW_BLOCK,
  TK_OPEN_SEXPR,
  TK_OPEN_UNESCAPED,
  TK_PRIVATE_SEP,
  TK_SEP,
  TK_STRING,
  TK_UNDEFINED,
  Tokens,
  idLen,
} from "./lexer.ts";

export const SK_CONTENT: number = 0; // from `start` to `end` is its value
export const SK_COMMENT: number = 1; // `a`, `b`: value (text)
export const SK_MUSTACHE: number = 2; // `a`: node; flags SF_VALID, SF_WRITTEN
// The statements of what follows `{{#a}}` come next, up to `b` (`first_end`), then those of what follows `{{else}}`, up
// to `next`. `a`: node; flags; `bpS`, `bpL`: block params.
export const SK_BLOCK: number = 3;
// Partials and decorators.
export const SK_UNSUPPORTED: number = 4;

export const SF_HAS_SECOND: number = 1;
// `{{^a}}`
export const SF_INVERTED: number = 2;
export const SF_VALID: number = 4;
// See `Node::is_as_written`.
export const SF_WRITTEN: number = 8;

export class Statements {
  kind: Uint8Array;
  flags: Uint8Array;
  start: Int32Array;
  end: Int32Array;
  // The statement behind it and all that is in it.
  next: Int32Array;
  a: Int32Array;
  b: Int32Array;
  bpS: Int32Array;
  bpL: Int32Array;
  n: number;
  constructor() {
    this.kind = new Uint8Array(64);
    this.flags = new Uint8Array(64);
    this.start = new Int32Array(64);
    this.end = new Int32Array(64);
    this.next = new Int32Array(64);
    this.a = new Int32Array(64);
    this.b = new Int32Array(64);
    this.bpS = new Int32Array(64);
    this.bpL = new Int32Array(64);
    this.n = 0;
  }
  clear(): void {
    this.n = 0;
  }
  grow(): void {
    const cap = this.kind.length * 2;
    let u = new Uint8Array(cap);
    u.set(this.kind);
    this.kind = u;
    u = new Uint8Array(cap);
    u.set(this.flags);
    this.flags = u;
    let a = new Int32Array(cap);
    a.set(this.start);
    this.start = a;
    a = new Int32Array(cap);
    a.set(this.end);
    this.end = a;
    a = new Int32Array(cap);
    a.set(this.next);
    this.next = a;
    a = new Int32Array(cap);
    a.set(this.a);
    this.a = a;
    a = new Int32Array(cap);
    a.set(this.b);
    this.b = a;
    a = new Int32Array(cap);
    a.set(this.bpS);
    this.bpS = a;
    a = new Int32Array(cap);
    a.set(this.bpL);
    this.bpL = a;
  }
  add(kind: number, start: number, end: number): number {
    const i = this.n;
    if (i === this.kind.length) this.grow();
    this.kind[i] = kind | 0;
    this.flags[i] = 0;
    this.start[i] = start | 0;
    this.end[i] = end | 0;
    this.next[i] = (i + 1) | 0;
    this.a[i] = 0;
    this.b[i] = 0;
    this.bpS[i] = 0;
    this.bpL[i] = 0;
    this.n = i + 1;
    return i;
  }
}

// `original` of a path or a literal.
const OK_TEXT: number = 0;
const OK_NUMBER: number = 1;
const OK_BOOLEAN: number = 2;
const OK_UNDEFINED: number = 3;
const OK_NULL: number = 4;

// `Class` of an expression.
const C_PATH: number = 0;
const C_SUB_EXPRESSION: number = 1;
const C_LITERAL: number = 2;
// `(a=b)`
const C_HASH_LITERAL: number = 3;

// `Prefix`
const PFX_NONE: number = 0;
const PFX_DATA: number = 1;
const PFX_SUB_EXPRESSION: number = 2;

// `helperName expr* hash? blockParams?` and what closes it.
class Header {
  oKind: number = 0;
  oA: number = 0;
  oB: number = 0;
  oNum: number = 0;
  path: number = 0;
  ps: number = 0;
  pl: number = 0;
  qs: number = 0;
  ql: number = 0;
  valid: boolean = false;
  written: boolean = false;
  bpS: number = 0;
  bpL: number = 0;
  stripOpen: boolean = false;
  stripClose: boolean = false;
}

function stripFlags(open: boolean, close: boolean, openMask: number, closeMask: number): number {
  return (open ? openMask : 0) | (close ? closeMask : 0);
}

// Whether the bytes `buf[a, b)` contain a line break of JavaScript.
function containsJsLineBreak(buf: Uint8Array, a: number, b: number): boolean {
  for (let i = a; i < b; i++) {
    const c = buf[i] | 0;
    if (c === 10 || c === 13) return true;
    if (c === 0xe2 && i + 2 < b && (buf[i + 1] | 0) === 0x80) {
      const d = buf[i + 2] | 0;
      if (d === 0xa8 || d === 0xa9) return true;
    }
  }
  return false;
}

// `/^this(?:\..+)?$/u` for `buf[a, b)`
function isThisPath(buf: Uint8Array, a: number, b: number): boolean {
  if (b - a < 4) return false;
  if ((buf[a] | 0) !== 116 || (buf[a + 1] | 0) !== 104 || (buf[a + 2] | 0) !== 105 || (buf[a + 3] | 0) !== 115) return false;
  if (b - a === 4) return true;
  if ((buf[a + 4] | 0) !== 46) return false;
  return b - a > 5 && !containsJsLineBreak(buf, a + 5, b);
}

// What is said where there is no token of `kind`.
function expected(kind: number): number {
  if (kind === TK_CLOSE || kind === TK_CLOSE_UNESCAPED || kind === TK_CLOSE_RAW_BLOCK) return MSG_EXPECTED_END_OF_MUSTACHE;
  if (kind === TK_CLOSE_SEXPR) return MSG_EXPECTED_CLOSING_PARENTHESIS;
  if (kind === TK_ID) return MSG_EXPECTED_NAME;
  return MSG_UNEXPECTED_TOKEN;
}

function canStartExpression(kind: number): boolean {
  return (
    kind === TK_OPEN_SEXPR ||
    kind === TK_ID ||
    kind === TK_DATA ||
    kind === TK_STRING ||
    kind === TK_NUMBER ||
    kind === TK_BOOLEAN ||
    kind === TK_UNDEFINED ||
    kind === TK_NULL
  );
}

class Parser {
  source: Uint8Array;
  srcLen: number;
  tk: Tokens;
  tkKind: Uint8Array;
  tkStart: Int32Array;
  tkEnd: Int32Array;
  nTokens: number;
  at: number;
  tree: Tree;
  st: Statements;
  // The parameters and pairs of the calls that are being parsed.
  pending: I32Vec;
  // The (start, len) of the names of block parameters.
  namePairs: I32Vec;
  stack: Stack;
  // Something of what has been parsed since this was last `false` is in no node.
  hasDropped: boolean;

  // `Expression`
  exNode: number;
  exClass: number;
  exValid: boolean;
  exSplat: boolean;
  exOKind: number;
  exOA: number;
  exOB: number;
  exONum: number;

  // `call()`
  callPath: number;
  callPS: number;
  callPL: number;
  callQS: number;
  callQL: number;

  // `id()`
  idS: number;
  idL: number;
  idLit: boolean;

  // `Strip` of `closeBlock`
  cbOpen: boolean;
  cbClose: boolean;

  // `Inverse`
  invPresent: boolean;
  invOpen: boolean;
  invClose: boolean;
  invChained: number;
  invWritten: boolean;

  // The result of `blockParams()`
  bpS: number;
  bpL: number;

  // The result of `partial()`: the original of its name
  pOKind: number;
  pOA: number;
  pOB: number;
  pONum: number;

  // The pool of headers: one for each block that is open.
  headers: Header[];
  headerTop: number;

  // The segments of the path that is being parsed (`path()` does not call itself).
  segPartS: Int32Array;
  segPartL: Int32Array;
  segLit: Uint8Array;
  segSep: Int32Array;
  segTok: Int32Array;
  // The parts of that path.
  partS: Int32Array;
  partL: Int32Array;

  constructor() {
    this.source = new Uint8Array(0);
    this.srcLen = 0;
    this.tk = new Tokens();
    this.tkKind = this.tk.kind;
    this.tkStart = this.tk.start;
    this.tkEnd = this.tk.end;
    this.nTokens = 0;
    this.at = 0;
    this.tree = new Tree();
    this.st = new Statements();
    this.pending = new I32Vec(64);
    this.namePairs = new I32Vec(16);
    this.stack = Stack.forTree();
    this.hasDropped = false;
    this.exNode = 0;
    this.exClass = 0;
    this.exValid = false;
    this.exSplat = false;
    this.exOKind = 0;
    this.exOA = 0;
    this.exOB = 0;
    this.exONum = 0;
    this.callPath = 0;
    this.callPS = 0;
    this.callPL = 0;
    this.callQS = 0;
    this.callQL = 0;
    this.idS = 0;
    this.idL = 0;
    this.idLit = false;
    this.cbOpen = false;
    this.cbClose = false;
    this.invPresent = false;
    this.invOpen = false;
    this.invClose = false;
    this.invChained = -1;
    this.invWritten = false;
    this.bpS = 0;
    this.bpL = 0;
    this.pOKind = 0;
    this.pOA = 0;
    this.pOB = 0;
    this.pONum = 0;
    this.headers = [];
    this.headerTop = 0;
    this.segPartS = new Int32Array(16);
    this.segPartL = new Int32Array(16);
    this.segLit = new Uint8Array(16);
    this.segSep = new Int32Array(16);
    this.segTok = new Int32Array(16);
    this.partS = new Int32Array(16);
    this.partL = new Int32Array(16);
  }

  acquire(): Header {
    if (this.headerTop === this.headers.length) this.headers.push(new Header());
    const h = this.headers[this.headerTop];
    this.headerTop = this.headerTop + 1;
    return h;
  }

  release(): void {
    this.headerTop = this.headerTop - 1;
  }

  // ----------------------------------------------------------------------------------------- tokens

  // The kind of the token `ahead` tokens on.
  kindAt(ahead: number): number {
    const i = this.at + ahead;
    return i < this.nTokens ? this.tkKind[i] | 0 : TK_EOF;
  }

  startOf(token: number): number {
    return token >= 0 && token < this.nTokens ? this.tkStart[token] | 0 : this.srcLen;
  }

  endOf(token: number): number {
    return token >= 0 && token < this.nTokens ? this.tkEnd[token] | 0 : this.srcLen;
  }

  kindOf(token: number): number {
    return token >= 0 && token < this.nTokens ? this.tkKind[token] | 0 : TK_EOF;
  }

  // Takes the next token. Returns its index.
  next(): number {
    const t = this.at;
    this.at = t + 1;
    return t;
  }

  // `message`, where the token is that has been taken last. Returns -1.
  error(message: number): number {
    const i = this.at > 0 ? this.at - 1 : 0;
    const kind = i < this.nTokens ? this.tkKind[i] | 0 : TK_EOF;
    const start = i < this.nTokens ? this.tkStart[i] | 0 : this.srcLen;
    return noteRefusal(kind === TK_EOF ? MSG_UNEXPECTED_END : message, start);
  }

  // Takes the next token if it is of `kind`: its index, else -1 (the error is noted).
  expect(kind: number): number {
    const t = this.next();
    if (this.kindOf(t) === kind) return t;
    return this.error(expected(kind));
  }

  // The first byte of the token, or -1.
  byteAt(token: number, offset: number): number {
    const s = this.startOf(token) + offset;
    return s < this.endOf(token) ? this.source[s] | 0 : -1;
  }

  // `stripFlags`: whether `open` has `~` after its two braces.
  stripOpenOf(open: number): boolean {
    return this.byteAt(open, 2) === 126;
  }

  // Whether `close` has `~` as its third byte from the end.
  stripCloseOf(close: number): boolean {
    const s = this.startOf(close);
    const e = this.endOf(close);
    return e - s >= 3 && (this.source[e - 3] | 0) === 126;
  }

  addStatement(kind: number, start: number, end: number): number {
    return this.st.add(kind, start, end);
  }

  // The statement `index` ends with the last token, and has all the statements in it that follow it.
  endStatement(index: number, kind: number): void {
    const st = this.st;
    const next = st.n;
    const end = this.at - 1 >= 0 && this.at - 1 < this.nTokens ? this.tkEnd[this.at - 1] | 0 : 0;
    st.kind[index] = kind | 0;
    st.end[index] = end | 0;
    st.next[index] = next | 0;
  }

  // ----------------------------------------------------------------------------------------- expressions

  // `text.replace(from, to)`, where `from` is a backslash and one of `esc1`, `esc2` (-1: none), and `to` the latter.
  // The text is in `tree.rs`, `tree.rl`.
  unescape(start: number, end: number, esc1: number, esc2: number): void {
    const src = this.source;
    const tree = this.tree;
    let any = false;
    for (let i = start; i + 1 < end; i++) {
      if ((src[i] | 0) === 92) {
        const c = src[i + 1] | 0;
        if (c === esc1 || c === esc2) {
          any = true;
          break;
        }
      }
    }
    if (!any) {
      tree.rs = start;
      tree.rl = end > start ? end - start : 0;
      return;
    }
    const owned = tree.startText();
    let at = start;
    let copied = start;
    while (at < end) {
      if ((src[at] | 0) === 92 && at + 1 < end && ((src[at + 1] | 0) === esc1 || (src[at + 1] | 0) === esc2)) {
        tree.write(src, copied, at);
        copied = at + 1;
        at = at + 2;
      } else {
        at = at + 1;
      }
    }
    tree.write(src, copied, end);
    tree.endText(owned);
  }

  // `yy.id(token)`, and whether that is not the token: `idS`, `idL`, `idLit`.
  id(token: number): void {
    const start = this.startOf(token);
    const end = this.endOf(token);
    const tree = this.tree;
    let s = start;
    let l = end > start ? end - start : 0;
    // `id_text`
    if (start < this.srcLen && (this.source[start] | 0) === 91) {
      this.unescape(start, end, 92, 93);
      s = tree.rs;
      l = tree.rl;
    }
    this.idLit = false;
    if (l >= 2) {
      const buf = tree.buf;
      const a = s;
      if ((buf[a] | 0) === 91 && (buf[a + l - 1] | 0) === 93 && !containsJsLineBreak(buf, a + 1, a + l - 1)) {
        s = s + 1;
        l = l - 2;
        this.idLit = true;
      }
    }
    this.idS = s;
    this.idL = l;
  }

  isAtHash(): boolean {
    return this.kindAt(0) === TK_ID && this.kindAt(1) === TK_EQUALS;
  }

  literal(kind: number, f0: number, f1: number, oKind: number, oA: number, oB: number, oNum: number, isSplat: boolean): void {
    const token = this.next();
    const tree = this.tree;
    const node = tree.add2(kind, this.startOf(token), this.endOf(token), f0, f1);
    this.exNode = node;
    this.exClass = C_LITERAL;
    this.exValid = true;
    this.exOKind = oKind;
    this.exOA = oA;
    this.exOB = oB;
    this.exONum = oNum;
    this.exSplat = isSplat;
  }

  // `expr`
  expression(): number {
    const token = this.at;
    const kind = this.kindAt(0);
    if (kind === TK_OPEN_SEXPR) {
      const r = this.subExpression();
      if (r < 0) return r;
      const k = this.kindAt(0);
      if (k === TK_SEP || k === TK_PRIVATE_SEP) {
        this.next();
        return this.path(PFX_SUB_EXPRESSION, this.startOf(token), -1);
      }
      return 0;
    }
    if (kind === TK_ID) {
      // One name that is not a bracket, `.`, `..` or `this`: the common path.
      const k1 = this.kindAt(1);
      if (k1 !== TK_SEP && k1 !== TK_PRIVATE_SEP) {
        const s = this.tkStart[token] | 0;
        const e = this.tkEnd[token] | 0;
        const src = this.source;
        const c0 = src[s] | 0;
        if (c0 !== 91 && c0 !== 46 && !(e - s === 4 && c0 === 116 && (src[s + 1] | 0) === 104 && (src[s + 2] | 0) === 105 && (src[s + 3] | 0) === 115)) {
          this.at = token + 1;
          const tree = this.tree;
          const node = tree.add(K_PATH, s, e);
          tree.f0[node] = H_VAR;
          tree.f1[node] = s;
          tree.f2[node] = e - s;
          tree.f3[node] = 0;
          tree.f4[node] = 0;
          this.exNode = node;
          this.exClass = C_PATH;
          this.exValid = true;
          this.exOKind = OK_TEXT;
          this.exOA = s;
          this.exOB = e - s;
          this.exSplat = false;
          return 0;
        }
      }
      return this.path(PFX_NONE, 0, -1);
    }
    if (kind === TK_DATA) {
      this.next();
      return this.path(PFX_DATA, 0, token);
    }
    if (kind === TK_STRING) {
      const quote = this.byteAt(token, 0) >= 0 ? this.byteAt(token, 0) : 34;
      this.unescape(this.startOf(token) + 1, this.endOf(token) - 1, quote, -1);
      const vs = this.tree.rs;
      const vl = this.tree.rl;
      const isSplat = this.tree.textIs(vs, vl, "...attributes");
      this.literal(K_STRING, vs, vl, OK_TEXT, vs, vl, 0, isSplat);
      return 0;
    }
    if (kind === TK_NUMBER) {
      const s = this.startOf(token);
      const e = this.endOf(token);
      const value = Number(bytesToString(this.source, s, e));
      this.literal(K_NUMBER, s, e - s, OK_NUMBER, 0, 0, value, false);
      return 0;
    }
    if (kind === TK_BOOLEAN) {
      const value = this.byteAt(token, 0) === 116 ? 1 : 0;
      this.literal(K_BOOLEAN, value, 0, OK_BOOLEAN, value, 0, 0, false);
      return 0;
    }
    if (kind === TK_UNDEFINED) {
      this.literal(K_UNDEFINED, 0, 0, OK_UNDEFINED, 0, 0, 0, false);
      return 0;
    }
    if (kind === TK_NULL) {
      this.literal(K_NULL, 0, 0, OK_NULL, 0, 0, 0, false);
      return 0;
    }
    return this.error(MSG_UNEXPECTED_TOKEN);
  }

  // `helperName`: an expression that is not all in parentheses.
  helperName(): number {
    const r = this.expression();
    if (r < 0) return r;
    if (this.exClass === C_SUB_EXPRESSION || this.exClass === C_HASH_LITERAL) return this.error(MSG_UNEXPECTED_TOKEN);
    return 0;
  }

  // `hashSegment+`, to `pending`. Returns 1 if all values are valid, else 0 (or a negative error).
  hash(): number {
    let isValid = true;
    const tree = this.tree;
    while (this.isAtHash()) {
      const token = this.next();
      this.id(token);
      let ks = this.idS;
      let kl = this.idL;
      const isLiteral = this.idLit;
      // Prettier prints it without the brackets that it needs.
      const nbuf = tree.buf;
      const na = ks;
      const isName = kl > 0 && idLen(nbuf, na, na + kl) === kl;
      if (!(isName || (!isLiteral && !(kl > 0 && (nbuf[na] | 0) === 91)))) {
        ks = this.startOf(token);
        const e = this.endOf(token);
        kl = e > ks ? e - ks : 0;
      }
      this.next();
      const r = this.expression();
      if (r < 0) return r;
      isValid = isValid && this.exValid && this.exClass !== C_HASH_LITERAL;
      const value = this.exNode;
      const end = this.at - 1 < this.nTokens ? this.tkEnd[this.at - 1] | 0 : 0;
      const pair = tree.add3(K_HASH_PAIR, this.startOf(token), end, ks, kl, value);
      this.pending.push(pair);
    }
    return isValid ? 1 : 0;
  }

  // `expr* hash?` behind a path (`pathNode`, `pathClass`, `pathValid`), and `acceptCallNodes` of `@glimmer/syntax`.
  // The call is in `callPath`..`callQL`. Returns 1 if it is valid, else 0 (or a negative error).
  call(pathNode: number, pathClass: number, pathValid: boolean): number {
    const tree = this.tree;
    const pending = this.pending;
    const base = pending.len;
    let isValid = true;
    while (canStartExpression(this.kindAt(0)) && !this.isAtHash()) {
      const r = this.expression();
      if (r < 0) return r;
      isValid = isValid && this.exValid && this.exClass !== C_HASH_LITERAL;
      pending.push(this.exNode);
    }
    const pl = pending.len - base;
    const ps = tree.addListFrom(pending.data, base, pl);
    pending.truncate(base);
    const h = this.hash();
    if (h < 0) return h;
    isValid = isValid && h === 1;
    const ql = pending.len - base;
    const qs = tree.addListFrom(pending.data, base, ql);
    pending.truncate(base);
    let node = NOTHING;
    let isPathValid = false;
    if (pathClass === C_PATH || pathClass === C_SUB_EXPRESSION) {
      node = pathNode;
      isPathValid = pathValid;
    } else if (pathClass === C_LITERAL) {
      node = pathNode;
      isPathValid = false;
    } else {
      // It is taken for `undefined`, which only matters where its position is asked for.
      node = NOTHING;
      isPathValid = pl > 0;
    }
    if (pathClass === C_HASH_LITERAL) this.hasDropped = true;
    this.callPath = node;
    this.callPS = ps;
    this.callPL = pl;
    this.callQS = qs;
    this.callQL = ql;
    return isValid && isPathValid ? 1 : 0;
  }

  // `sexpr`
  subExpression(): number {
    if (!this.stack.enter()) return -2;
    const tree = this.tree;
    const open = this.next();
    if (this.isAtHash()) {
      const base = this.pending.len;
      const h = this.hash();
      if (h < 0) return h;
      this.pending.truncate(base);
      const c = this.expect(TK_CLOSE_SEXPR);
      if (c < 0) return c;
      this.exNode = NOTHING;
      this.exClass = C_HASH_LITERAL;
      this.exValid = false;
      this.exOKind = OK_UNDEFINED;
      this.exSplat = false;
    } else {
      let r = this.expression();
      if (r < 0) return r;
      const pNode = this.exNode;
      const pClass = this.exClass;
      const pValid = this.exValid;
      r = this.call(pNode, pClass, pValid);
      if (r < 0) return r;
      const isValid = r === 1;
      const close = this.expect(TK_CLOSE_SEXPR);
      if (close < 0) return close;
      const node = tree.add(K_SUB_EXPRESSION, this.startOf(open), this.endOf(close));
      tree.f0[node] = this.callPath | 0;
      tree.f1[node] = this.callPS | 0;
      tree.f2[node] = this.callPL | 0;
      tree.f3[node] = this.callQS | 0;
      tree.f4[node] = this.callQL | 0;
      this.exNode = node;
      this.exClass = C_SUB_EXPRESSION;
      this.exValid = isValid;
      this.exOKind = OK_UNDEFINED;
      this.exSplat = false;
    }
    this.stack.leave();
    return 0;
  }

  growSegments(): void {
    const cap = this.segPartS.length * 2;
    let a = new Int32Array(cap);
    a.set(this.segPartS);
    this.segPartS = a;
    a = new Int32Array(cap);
    a.set(this.segPartL);
    this.segPartL = a;
    const l = new Uint8Array(cap);
    l.set(this.segLit);
    this.segLit = l;
    a = new Int32Array(cap);
    a.set(this.segSep);
    this.segSep = a;
    a = new Int32Array(cap);
    a.set(this.segTok);
    this.segTok = a;
    a = new Int32Array(cap);
    a.set(this.partS);
    this.partS = a;
    a = new Int32Array(cap);
    a.set(this.partL);
    this.partL = a;
  }

  // `pathSegments`, `preparePath`, and `PathExpression` of `@glimmer/syntax`. `dataToken`: the `@` of `PFX_DATA`;
  // `subStart`: where the `(` of `PFX_SUB_EXPRESSION` is.
  path(prefix: number, subStart: number, dataToken: number): number {
    const tree = this.tree;
    const src = this.source;
    let nSeg = 0;
    let token = this.expect(TK_ID);
    if (token < 0) return token;
    let start = 0;
    let isData = false;
    // `original` is what the template has.
    let isPlain = false;
    if (prefix === PFX_NONE) {
      start = this.startOf(token);
      isPlain = true;
    } else if (prefix === PFX_DATA) {
      start = this.startOf(dataToken);
      isData = true;
      isPlain = this.endOf(dataToken) === this.startOf(token);
    } else {
      start = subStart;
    }
    let separator = -1;
    while (true) {
      this.id(token);
      isPlain = isPlain && this.byteAt(token, 0) !== 91;
      if (nSeg === this.segPartS.length) this.growSegments();
      this.segPartS[nSeg] = this.idS | 0;
      this.segPartL[nSeg] = this.idL | 0;
      this.segLit[nSeg] = this.idLit ? 1 : 0;
      this.segSep[nSeg] = separator | 0;
      this.segTok[nSeg] = token | 0;
      nSeg = nSeg + 1;
      const k = this.kindAt(0);
      if (k !== TK_SEP && k !== TK_PRIVATE_SEP) break;
      const nextSeparator = this.next();
      const nextTok = this.expect(TK_ID);
      if (nextTok < 0) return nextTok;
      isPlain = isPlain && this.endOf(token) === this.startOf(nextSeparator) && this.endOf(nextSeparator) === this.startOf(nextTok);
      separator = nextSeparator;
      token = nextTok;
    }
    const end = this.endOf(token);

    let nParts = 0;
    let dropped = 0;
    let hasPrivateName = false;
    for (let i = 0; i < nSeg; i++) {
      const ps = this.segPartS[i] | 0;
      const pl = this.segPartL[i] | 0;
      if (
        (this.segLit[i] | 0) === 0 &&
        (tree.textIs(ps, pl, "..") || tree.textIs(ps, pl, ".") || tree.textIs(ps, pl, "this"))
      ) {
        if (nParts > 0) return this.error(MSG_INVALID_PATH);
        dropped = dropped + 1;
        continue;
      }
      const sep = this.segSep[i] | 0;
      if (sep >= 0 && this.kindOf(sep) === TK_PRIVATE_SEP) {
        hasPrivateName = true;
        const owned = tree.startText();
        tree.writeByte(35);
        tree.writeText(ps, pl);
        tree.endText(owned);
        this.partS[nParts] = tree.rs | 0;
        this.partL[nParts] = tree.rl | 0;
      } else {
        this.partS[nParts] = ps;
        this.partL[nParts] = pl;
      }
      nParts = nParts + 1;
    }

    // `parts: head ? [head, ...tail] : tail`
    let firstPart = 0;
    if (nParts > 0 && (this.partL[0] | 0) === 0) {
      firstPart = 1;
      dropped = dropped + 2;
    }
    const hasDropped = dropped > 0;

    let os = 0;
    let ol = 0;
    if (isPlain) {
      os = start;
      ol = end > start ? end - start : 0;
    } else {
      const owned = tree.startText();
      if (prefix === PFX_DATA) tree.writeByte(64);
      else if (prefix === PFX_SUB_EXPRESSION) tree.writeAscii("undefined.");
      for (let i = 0; i < nSeg; i++) {
        const sep = this.segSep[i] | 0;
        if (sep >= 0) tree.write(src, this.startOf(sep), this.endOf(sep));
        tree.writeText(this.segPartS[i] | 0, this.segPartL[i] | 0);
      }
      tree.endText(owned);
      os = tree.rs;
      ol = tree.rl;
    }

    const obuf = tree.buf;
    const oa = os;
    const ob = oa + ol;
    let hasSlash = false;
    let hasDot = false;
    for (let i = oa; i < ob; i++) {
      const c = obuf[i] | 0;
      if (c === 47) hasSlash = true;
      else if (c === 46) hasDot = true;
    }
    let isRefused = false;
    if (hasSlash) {
      isRefused =
        (ol >= 2 && (obuf[oa] | 0) === 46 && (obuf[oa + 1] | 0) === 47) ||
        (ol >= 3 && (obuf[oa] | 0) === 46 && (obuf[oa + 1] | 0) === 46 && (obuf[oa + 2] | 0) === 47) ||
        hasDot;
    } else {
      isRefused = ol === 1 && (obuf[oa] | 0) === 46;
    }
    const isThis = isThisPath(obuf, oa, ob);
    const isSplat = tree.textIs(os, ol, "...attributes");
    // Only the `this` that a path starts with comes back. And `[a/b]`, one name, is printed like `a/b`, which is two.
    let isAsWritten = hasPrivateName || dropped !== (isThis ? 1 : 0);
    if (!isAsWritten && hasSlash) {
      for (let i = 0; i < nSeg; i++) {
        if ((this.segLit[i] | 0) !== 0 && tree.textHasByte(this.segPartS[i] | 0, this.segPartL[i] | 0, 47)) {
          isAsWritten = true;
          break;
        }
      }
    }
    // `invalid`
    this.exNode = NOTHING;
    this.exClass = C_PATH;
    this.exValid = false;
    this.exOKind = OK_TEXT;
    this.exOA = os;
    this.exOB = ol;
    this.exSplat = isSplat;
    if (isRefused || prefix === PFX_SUB_EXPRESSION) return 0;

    const head = isThis ? H_THIS : isData ? H_AT : H_VAR;
    let ns = 0;
    let nl = 0;
    let tailFrom = 0;
    let tailLen = 0;
    if (hasSlash) {
      // One part: `path.parts.join("/")`.
      if (hasDropped) {
        const owned = tree.startText();
        if (isData) tree.writeByte(64);
        for (let i = firstPart; i < nParts; i++) {
          if (i > firstPart) tree.writeByte(47);
          tree.writeText(this.partS[i] | 0, this.partL[i] | 0);
        }
        tree.endText(owned);
        ns = tree.rs;
        nl = tree.rl;
      } else {
        ns = os;
        nl = ol;
      }
    } else if (isThis) {
      ns = 0;
      nl = 0;
      tailFrom = firstPart;
      tailLen = nParts - firstPart;
    } else {
      if (nParts - firstPart <= 0) return 0;
      const fs = this.partS[firstPart] | 0;
      const fl = this.partL[firstPart] | 0;
      if (!isData) {
        ns = fs;
        nl = fl;
      } else if (isPlain && !hasDropped) {
        ns = start;
        const e = this.endOf(this.segTok[0] | 0);
        nl = e > start ? e - start : 0;
      } else {
        const owned = tree.startText();
        tree.writeByte(64);
        tree.writeText(fs, fl);
        tree.endText(owned);
        ns = tree.rs;
        nl = tree.rl;
      }
      tailFrom = firstPart + 1;
      tailLen = nParts - firstPart - 1;
    }
    const tailStart = tree.addNamesFrom(this.partS, this.partL, tailFrom, tailLen);
    const node = tree.add(K_PATH, start, end);
    tree.f0[node] = head | 0;
    tree.f1[node] = ns | 0;
    tree.f2[node] = nl | 0;
    tree.f3[node] = tailStart | 0;
    tree.f4[node] = tailLen | 0;
    if (isAsWritten) tree.keepAsWritten(node);
    this.exNode = node;
    this.exValid = true;
    return 0;
  }

  // ----------------------------------------------------------------------------------------- statements

  // `validateClose`
  closes(oKind: number, oA: number, oB: number, oNum: number, cKind: number, cA: number, cB: number, cNum: number): boolean {
    if (oKind !== cKind) return false;
    if (oKind === OK_TEXT) return this.tree.textEq(oA, oB, cA, cB);
    if (oKind === OK_NUMBER) return oNum === cNum;
    if (oKind === OK_BOOLEAN) return oA === cA;
    return true;
  }

  // `blockParams`: the names are in `tree`, `bpS`, `bpL`.
  blockParams(): number {
    const tree = this.tree;
    this.next();
    const first = this.at;
    let count = 0;
    let firstTok = -1;
    let lastTok = -1;
    while (this.kindAt(0) === TK_ID) {
      const token = this.next();
      if (firstTok < 0) firstTok = token;
      lastTok = token;
      count = count + 1;
    }
    const c = this.expect(TK_CLOSE_BLOCK_PARAMS);
    if (c < 0) return c;
    if (count === 0) return this.error(MSG_EXPECTED_NAME);
    // `yy.id` is given the list. It takes it for a text, and if that is in brackets, fails.
    const src = this.source;
    if (this.byteAt(firstTok, 0) === 91 && (this.endOf(lastTok) > this.startOf(lastTok) ? src[this.endOf(lastTok) - 1] | 0 : -1) === 93) {
      let anyBreak = false;
      for (let t = first; t < first + count; t++) {
        if (containsJsLineBreak(src, this.startOf(t), this.endOf(t))) {
          anyBreak = true;
          break;
        }
      }
      if (!anyBreak) return this.error(MSG_UNEXPECTED_TOKEN);
    }
    const pairs = this.namePairs;
    pairs.reset();
    for (let i = 0; i < count; i++) {
      pairs.push(this.startOf(first + i));
      pairs.push(this.endOf(first + i) - this.startOf(first + i));
    }
    this.bpS = tree.addNamePairs(pairs.data, count);
    this.bpL = count;
    return 0;
  }

  // What is behind `open`: `helperName expr* hash? blockParams?` and `close`.
  header(open: number, closeKind: number, takesBlockParams: boolean, h: Header): number {
    this.hasDropped = false;
    let r = this.helperName();
    if (r < 0) return r;
    h.oKind = this.exOKind;
    h.oA = this.exOA;
    h.oB = this.exOB;
    h.oNum = this.exONum;
    const pNode = this.exNode;
    const pClass = this.exClass;
    const pValid = this.exValid;
    r = this.call(pNode, pClass, pValid);
    if (r < 0) return r;
    h.valid = r === 1;
    h.path = this.callPath;
    h.ps = this.callPS;
    h.pl = this.callPL;
    h.qs = this.callQS;
    h.ql = this.callQL;
    h.bpS = 0;
    h.bpL = 0;
    if (this.kindAt(0) === TK_OPEN_BLOCK_PARAMS && takesBlockParams) {
      r = this.blockParams();
      if (r < 0) return r;
      h.bpS = this.bpS;
      h.bpL = this.bpL;
    }
    const close = this.expect(closeKind);
    if (close < 0) return close;
    h.written = this.hasDropped;
    h.stripOpen = this.stripOpenOf(open);
    h.stripClose = this.stripCloseOf(close);
    return 0;
  }

  // `closeBlock`: the strip of it is in `cbOpen`, `cbClose`.
  closeBlock(oKind: number, oA: number, oB: number, oNum: number): number {
    const first = this.expect(TK_OPEN_END_BLOCK);
    if (first < 0) return first;
    let r = this.helperName();
    if (r < 0) return r;
    const cKind = this.exOKind;
    const cA = this.exOA;
    const cB = this.exOB;
    const cNum = this.exONum;
    const last = this.expect(TK_CLOSE);
    if (last < 0) return last;
    if (!this.closes(oKind, oA, oB, oNum, cKind, cA, cB, cNum)) {
      return noteRefusal(MSG_WRONG_NAME_AT_END_OF_BLOCK, this.startOf(first));
    }
    this.cbOpen = this.stripOpenOf(first);
    this.cbClose = this.stripCloseOf(last);
    return 0;
  }

  // `inverseAndProgram`
  inverseAndProgram(): number {
    const token = this.next();
    const r = this.program();
    if (r < 0) return r;
    this.invPresent = true;
    this.invOpen = this.stripOpenOf(token);
    this.invClose = this.stripCloseOf(token);
    this.invChained = -1;
    this.invWritten = false;
    return 0;
  }

  setCloseStrip(block: number, open: boolean, close: boolean): void {
    const tree = this.tree;
    if (block >= 0 && block < tree.n && (tree.tag[block] | 0) === K_BLOCK_STATEMENT) {
      tree.f7[block] = ((tree.f7[block] | 0) & ~(CLOSE_OPEN | CLOSE_CLOSE)) | stripFlags(open, close, CLOSE_OPEN, CLOSE_CLOSE);
    }
  }

  // `prepareBlock`, for the statement `index`, whose first program ends at `firstEnd`. `close`: `close.strip`.
  endBlock(
    index: number,
    h: Header,
    firstEnd: number,
    hasInverse: boolean,
    invOpen: boolean,
    invClose: boolean,
    invChained: number,
    invWritten: boolean,
    hasClose: boolean,
    closeOpen: boolean,
    closeClose: boolean,
    isInverted: boolean,
  ): number {
    const tree = this.tree;
    if (hasInverse && invChained >= 0) {
      this.setCloseStrip(invChained, hasClose ? closeOpen : false, hasClose ? closeClose : false);
    }
    const strip =
      stripFlags(h.stripOpen, h.stripClose, OPEN_OPEN, OPEN_CLOSE) |
      (hasInverse ? stripFlags(invOpen, invClose, INVERSE_OPEN, INVERSE_CLOSE) : 0) |
      (hasClose ? stripFlags(closeOpen, closeClose, CLOSE_OPEN, CLOSE_CLOSE) : 0);
    const node = tree.add(K_BLOCK_STATEMENT, 0, 0);
    tree.f0[node] = h.path | 0;
    tree.f1[node] = h.ps | 0;
    tree.f2[node] = h.pl | 0;
    tree.f3[node] = h.qs | 0;
    tree.f4[node] = h.ql | 0;
    tree.f5[node] = NOTHING;
    tree.f6[node] = NOTHING;
    tree.f7[node] = strip | 0;
    const st = this.st;
    // Without what follows `{{else}}`, `{{^a}}` has no `program`.
    const valid = h.valid && (!isInverted || hasInverse);
    const written = h.written || (hasInverse && invWritten);
    this.endStatement(index, SK_BLOCK);
    st.a[index] = node;
    st.b[index] = firstEnd;
    st.bpS[index] = h.bpS;
    st.bpL[index] = h.bpL;
    st.flags[index] =
      (hasInverse ? SF_HAS_SECOND : 0) | (isInverted ? SF_INVERTED : 0) | (valid ? SF_VALID : 0) | (written ? SF_WRITTEN : 0);
    return node;
  }

  // `inverseChain?`: `invPresent` says whether there is one.
  inverseChain(): number {
    const open = this.at;
    const kind = this.kindAt(0);
    if (kind === TK_INVERSE) return this.inverseAndProgram();
    if (kind !== TK_OPEN_INVERSE_CHAIN) {
      this.invPresent = false;
      return 0;
    }
    if (!this.stack.enter()) return -2;
    this.next();
    const h = this.acquire();
    let r = this.header(open, TK_CLOSE, true, h);
    if (r < 0) return r;
    const index = this.addStatement(SK_UNSUPPORTED, this.startOf(open), this.endOf(open));
    r = this.program();
    if (r < 0) return r;
    const firstEnd = this.st.n;
    r = this.inverseChain();
    if (r < 0) return r;
    const hasInverse = this.invPresent;
    const invOpen = this.invOpen;
    const invClose = this.invClose;
    const invChained = this.invChained;
    const invWritten = this.invWritten;
    const node = this.endBlock(index, h, firstEnd, hasInverse, invOpen, invClose, invChained, invWritten, hasInverse, invOpen, invClose, false);
    this.tree.f7[node] = (this.tree.f7[node] | 0) | CHAINED;
    this.invPresent = true;
    this.invOpen = h.stripOpen;
    this.invClose = h.stripClose;
    this.invChained = node;
    this.invWritten = h.written || (hasInverse && invWritten);
    this.release();
    this.stack.leave();
    return 0;
  }

  // `block`
  block(): number {
    if (!this.stack.enter()) return -2;
    const open = this.next();
    const isInverted = this.kindOf(open) === TK_OPEN_INVERSE;
    const isDecorator = indexOfByte(this.source, this.startOf(open), this.endOf(open), 42) >= 0;
    const h = this.acquire();
    let r = this.header(open, TK_CLOSE, true, h);
    if (r < 0) return r;
    const index = this.addStatement(SK_UNSUPPORTED, this.startOf(open), this.endOf(open));
    r = this.program();
    if (r < 0) return r;
    const firstEnd = this.st.n;
    let hasInverse = false;
    if (isInverted) {
      if (this.kindAt(0) === TK_INVERSE) {
        r = this.inverseAndProgram();
        if (r < 0) return r;
        hasInverse = true;
      }
    } else {
      r = this.inverseChain();
      if (r < 0) return r;
      hasInverse = this.invPresent;
    }
    const invOpen = this.invOpen;
    const invClose = this.invClose;
    const invChained = this.invChained;
    const invWritten = this.invWritten;
    if (this.kindAt(0) === TK_EOF) return noteRefusal(MSG_UNCLOSED_BLOCK, this.startOf(open));
    r = this.closeBlock(h.oKind, h.oA, h.oB, h.oNum);
    if (r < 0) return r;
    if (isDecorator) {
      if (hasInverse) return this.error(MSG_UNEXPECTED_TOKEN);
      this.endStatement(index, SK_UNSUPPORTED);
    } else {
      this.endBlock(index, h, firstEnd, hasInverse, invOpen, invClose, invChained, invWritten, true, this.cbOpen, this.cbClose, isInverted);
    }
    this.release();
    this.stack.leave();
    return 0;
  }

  // `rawBlock`
  rawBlock(): number {
    const open = this.next();
    // It becomes a block like any other.
    const h = this.acquire();
    let r = this.header(open, TK_CLOSE_RAW_BLOCK, false, h);
    if (r < 0) return r;
    h.stripOpen = false;
    h.stripClose = false;
    h.written = true;
    const index = this.addStatement(SK_UNSUPPORTED, this.startOf(open), this.endOf(open));
    while (this.kindAt(0) === TK_CONTENT) {
      const content = this.next();
      this.addStatement(SK_CONTENT, this.startOf(content), this.endOf(content));
    }
    const close = this.expect(TK_END_RAW_BLOCK);
    if (close < 0) return close;
    const nameStart = this.startOf(close) + 5;
    const nameEnd = this.endOf(close) - 4;
    if (!this.closes(h.oKind, h.oA, h.oB, h.oNum, OK_TEXT, nameStart, nameEnd > nameStart ? nameEnd - nameStart : 0, 0)) {
      return noteRefusal(MSG_WRONG_NAME_AT_END_OF_BLOCK, this.startOf(close));
    }
    const firstEnd = this.st.n;
    this.endBlock(index, h, firstEnd, false, false, false, -1, false, false, false, false, false);
    this.release();
    return 0;
  }

  // `mustache`
  mustache(): number {
    const tree = this.tree;
    const open = this.next();
    let closeKind = TK_CLOSE;
    let isTrusting = false;
    if (this.kindOf(open) === TK_OPEN_UNESCAPED) {
      closeKind = TK_CLOSE_UNESCAPED;
      isTrusting = true;
    } else {
      isTrusting = this.endOf(open) > this.startOf(open) && (this.source[this.endOf(open) - 1] | 0) === 38;
    }
    this.hasDropped = false;
    let hasPath = false;
    let pClass = C_PATH;
    let pSplat = false;
    let cPath = NOTHING;
    let cPS = 0;
    let cPL = 0;
    let cQS = 0;
    let cQL = 0;
    let isValid = false;
    if (this.kindOf(open) === TK_OPEN && this.isAtHash()) {
      const base = this.pending.len;
      const h = this.hash();
      if (h < 0) return h;
      this.pending.truncate(base);
    } else {
      let r = this.expression();
      if (r < 0) return r;
      const pNode = this.exNode;
      pClass = this.exClass;
      const pValid = this.exValid;
      pSplat = this.exSplat;
      hasPath = true;
      r = this.call(pNode, pClass, pValid);
      if (r < 0) return r;
      isValid = r === 1;
      cPath = this.callPath;
      cPS = this.callPS;
      cPL = this.callPL;
      cQS = this.callQS;
      cQL = this.callQL;
    }
    const close = this.expect(closeKind);
    if (close < 0) return close;
    if (indexOfByte(this.source, this.startOf(open), this.endOf(open), 42) >= 0) {
      this.addStatement(SK_UNSUPPORTED, this.startOf(open), this.endOf(close));
      return 0;
    }
    // What follows a literal is dropped unseen.
    if (hasPath && pClass === C_LITERAL) {
      this.hasDropped = cPL > 0 || cQL > 0;
      cPL = 0;
      cQL = 0;
      cPS = 0;
      cQS = 0;
      isValid = true;
    }
    const strip = stripFlags(this.stripOpenOf(open), this.stripCloseOf(close), OPEN_OPEN, OPEN_CLOSE);
    const node = tree.add(K_MUSTACHE, this.startOf(open), this.endOf(close));
    tree.f0[node] = cPath | 0;
    tree.f1[node] = cPS | 0;
    tree.f2[node] = cPL | 0;
    tree.f3[node] = cQS | 0;
    tree.f4[node] = cQL | 0;
    tree.f5[node] = isTrusting ? 1 : 0;
    tree.f6[node] = strip | 0;
    isValid = isValid && !(hasPath && pSplat);
    const index = this.addStatement(SK_MUSTACHE, this.startOf(open), this.endOf(close));
    this.st.a[index] = node;
    this.st.flags[index] = (isValid ? SF_VALID : 0) | (this.hasDropped ? SF_WRITTEN : 0);
    return 0;
  }

  // `partial`, or `openPartialBlock`. The original of the name is in `pOKind`..`pONum`.
  partial(): number {
    this.next();
    let r = this.expression();
    if (r < 0) return r;
    this.pOKind = this.exOKind;
    this.pOA = this.exOA;
    this.pOB = this.exOB;
    this.pONum = this.exONum;
    r = this.call(this.exNode, this.exClass, this.exValid);
    if (r < 0) return r;
    const c = this.expect(TK_CLOSE);
    if (c < 0) return c;
    return 0;
  }

  // `stripComment`: the value is in `tree.rs`, `tree.rl`.
  commentValue(token: number): void {
    const src = this.source;
    const s = this.startOf(token);
    const e = this.endOf(token);
    let start = (s + 2 < e ? src[s + 2] | 0 : -1) === 126 ? 4 : 3;
    // `dashes`
    let d = 0;
    while (d < 2 && s + start + d < e && (src[s + start + d] | 0) === 45) d = d + 1;
    start = start + d;
    let a = s + start;
    let b = e;
    if (a > b) a = b;
    if (b - a >= 2 && (src[b - 2] | 0) === 125 && (src[b - 1] | 0) === 125) b = b - 2;
    if (b > a && (src[b - 1] | 0) === 126) b = b - 1;
    if (b > a && (src[b - 1] | 0) === 45) b = b - 1;
    if (b > a && (src[b - 1] | 0) === 45) b = b - 1;
    this.tree.rs = a;
    this.tree.rl = b - a;
  }

  // `program`
  program(): number {
    while (true) {
      const token = this.at;
      const kind = this.kindAt(0);
      if (kind === TK_CONTENT) {
        this.next();
        this.addStatement(SK_CONTENT, this.startOf(token), this.endOf(token));
      } else if (kind === TK_COMMENT) {
        this.next();
        this.commentValue(token);
        const index = this.addStatement(SK_COMMENT, this.startOf(token), this.endOf(token));
        this.st.a[index] = this.tree.rs;
        this.st.b[index] = this.tree.rl;
      } else if (kind === TK_OPEN || kind === TK_OPEN_UNESCAPED) {
        const r = this.mustache();
        if (r < 0) return r;
      } else if (kind === TK_OPEN_BLOCK || kind === TK_OPEN_INVERSE) {
        const r = this.block();
        if (r < 0) return r;
      } else if (kind === TK_OPEN_RAW_BLOCK) {
        const r = this.rawBlock();
        if (r < 0) return r;
      } else if (kind === TK_OPEN_PARTIAL) {
        const r = this.partial();
        if (r < 0) return r;
        this.addStatement(SK_UNSUPPORTED, this.startOf(token), this.endOf(token));
      } else if (kind === TK_OPEN_PARTIAL_BLOCK) {
        if (!this.stack.enter()) return -2;
        let r = this.partial();
        if (r < 0) return r;
        const oKind = this.pOKind;
        const oA = this.pOA;
        const oB = this.pOB;
        const oNum = this.pONum;
        const index = this.addStatement(SK_UNSUPPORTED, this.startOf(token), this.endOf(token));
        r = this.program();
        if (r < 0) return r;
        r = this.closeBlock(oKind, oA, oB, oNum);
        if (r < 0) return r;
        this.endStatement(index, SK_UNSUPPORTED);
        this.stack.leave();
      } else {
        return 0;
      }
    }
  }
}

const parser = new Parser();

// Writes the statements that `tokens` are to `statements` (which `parse` empties), and their expressions to `tree`.
// 0, -1 (a syntax error is noted) or -2 (nested too deeply).
export function parse(source: Uint8Array, tokens: Tokens, tree: Tree, statements: Statements): number {
  const p = parser;
  p.source = source;
  p.srcLen = source.length;
  p.tk = tokens;
  p.tkKind = tokens.kind;
  p.tkStart = tokens.start;
  p.tkEnd = tokens.end;
  p.nTokens = tokens.n;
  p.at = 0;
  p.tree = tree;
  statements.clear();
  p.st = statements;
  p.pending.reset();
  p.stack = Stack.forTree();
  p.hasDropped = false;
  p.headerTop = 0;
  let r = p.program();
  if (r < 0) return r;
  r = p.expect(TK_EOF);
  return r < 0 ? r : 0;
}
