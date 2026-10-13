// Port of vendor/bun/src/format/json/parser.rs. Text to tree.
//
// The tree is a table of nodes in the order of the source: a container is followed by what is in it. In an object, names
// and values take turns. There is no recursion, so that nesting is only limited by memory.
//
// What the writer needs to know about a node is found out here, where the text is looked at anyway: how wide it is on one
// line, and whether it can be on one line at all. That is only valid for a document without comments.
//
// Layout: `nodes` is an Int32Array with 8 ints per node (index `i << 3`): start, end, next (the index of the node after
// this one and all that is in it), count (properties or elements), width (columns on one line, or MUST_BREAK), kind,
// flags, (unused). `open`: the containers whose end has not been seen, 8 ints each. `comments`: 8 ints each: start, end,
// is_block, enclosing, preceding, following (owners: see `ownerNode`).
import { ByteBuf } from "../../base/bytebuf.ts";
import { decodeUtf8, utf8Len } from "../../base/utf8.ts";
import { stringWidth } from "../ir/width.ts";
import { QUOTE_NONE, PARSER_JSON5, PARSER_STRINGIFY, Config } from "./config.ts";
import { QUOTE_PROPS_AS_NEEDED, QUOTE_PROPS_CONSISTENT } from "../options.ts";
import {
  MSG_EXPECTED_END_OF_FILE,
  MSG_INVALID_ESCAPE_SEQUENCE,
  MSG_UNCLOSED_COMMENT,
  MSG_TOO_LARGE,
  MSG_UNCLOSED_STRING,
  MSG_UNEXPECTED_END,
  MSG_UNEXPECTED_TOKEN,
  noteRefusal,
} from "../syntax_error.ts";
import { makeString, isNextLineEmpty, jsWhitespaceLen } from "../text.ts";
import { isIdentifierStart, isTypeScriptIdentifierPart } from "../../sema/parser/unicode.ts";
import {
  isCanonicalSimpleNumber,
  isEs5IdentifierName,
  isLineAfterElementEmpty,
  isSimpleNumber,
  numBuf,
  numberToStringIsSame,
  trimmedNumber,
} from "./util.ts";

// ------------------------------------------------------------------------------------------ constants

export const K_OBJECT: number = 0;
export const K_ARRAY: number = 1;
export const K_STRING: number = 2;
export const K_NUMBER: number = 3;
/** `null`, `true`, `false`, `NaN`, `Infinity`, `undefined`. As a name, any identifier. */
export const K_IDENTIFIER: number = 4;
/** A template without substitutions. */
export const K_TEMPLATE: number = 5;
/** `+` or `-`. The next node is the operand. */
export const K_UNARY: number = 6;
/** Nothing, between two commas of an array. */
export const K_HOLE: number = 7;

/** The width of what cannot be on one line. */
export const MUST_BREAK: number = 0x7fffffff;

/** An empty line follows the property or the element, and another one follows that. */
export const BLANK_AFTER: number = 1;
/** What is written is not what is in the source. */
export const REWRITTEN: number = 2;
/** An array of numbers: as many as fit are on each line. */
export const CONCISE: number = 4;
/** With `quoteProps: "consistent"`: a name of the object needs its quotes, so all get them. */
export const QUOTED_NAMES: number = 8;
/** A name that is a string and is written without its quotes. */
export const UNQUOTED: number = 16;
/** A name that is not a string and is written in quotes. */
export const QUOTED: number = 32;
/** There is a line break between the `{` and the first name. */
export const BREAK_AFTER_OPEN: number = 64;
/** An array of more than one object or of more than one array, each with more than one entry. */
export const MATRIX: number = 128;

// Slots of a node.
export const N_START: number = 0;
export const N_END: number = 1;
export const N_NEXT: number = 2;
export const N_COUNT: number = 3;
export const N_WIDTH: number = 4;
export const N_KIND: number = 5;
export const N_FLAGS: number = 6;

/** An owner: a node (`ownerNode(i)`), a property (`ownerProperty(name)`), or nothing. */
export const OWNER_NONE: number = 0x7fffffff;
export function ownerNode(index: number): number {
  return (index << 1) | 0;
}
export function ownerProperty(nameIndex: number): number {
  return ((nameIndex << 1) | 1) | 0;
}
export function ownerIsProperty(owner: number): boolean {
  return owner !== OWNER_NONE && (owner & 1) === 1;
}
export function ownerIndex(owner: number): number {
  return owner >> 1;
}

// Slots of a comment.
export const C_START: number = 0;
export const C_END: number = 1;
export const C_BLOCK: number = 2;
/** The innermost node that it is in. */
export const C_ENCLOSING: number = 3;
/** The children of that node before and after it. */
export const C_PRECEDING: number = 4;
export const C_FOLLOWING: number = 5;

// ElementKinds: what the elements of an array are, as far as they have been read.
const EK_UNKNOWN = 0;
const EK_NUMBERS = 1;
const EK_CONTAINERS = 2;
const EK_MIXED = 3;

// Slots of an open container.
const O_NODE = 0;
const O_COUNT = 1;
/** The sum of the widths of what is in it. */
const O_WIDTH = 2;
/** The last value, if it is not a hole (-1). */
const O_LAST_VALUE = 3;
/** The last property or element that is not a hole (an owner). */
const O_LAST_CHILD = 4;
/** The name of the property that is being read. */
const O_NAME = 5;
const O_FLAGS = 6;
const O_ELEMENTS = 7;
const OF_LAST_HOLE = 1;
const OF_BLANK = 2;
const OF_REQUIRES_QUOTES = 4;

// States.
const S_VALUE = 0;
const S_AFTER_VALUE = 1;
const S_NAME_OR_END = 2;
const S_ELEMENT_OR_END = 3;

/** The place of the first byte of t[from, ...) that is a quote, a backslash or not printable ASCII; -1 if there is none. */
function scanString(t: Uint8Array, from: number, q: number): number {
  for (let i = from; i < t.length; i++) {
    const c = t[i] | 0;
    if (c === q || c === 92 || ((c - 32) >>> 0) > 94) return i;
  }
  return -1;
}

/** The place of the first byte of t[from, ...) that is not a blank or a tab. */
function skipBlanks(t: Uint8Array, from: number): number {
  for (let i = from; i < t.length; i++) {
    const c = t[i] | 0;
    if (c !== 32 && c !== 9) return i;
  }
  return t.length;
}

function satAdd(a: number, b: number): number {
  const s = (a | 0) + (b | 0);
  return s > MUST_BREAK ? MUST_BREAK : s;
}

// ------------------------------------------------------------------------------------------ the tree

/** Bits of a packed `trivia` result: the place, and the number of line breaks (0, 1, 2 for more). */
const AT_MASK = 0x1fffffff;
const LB_SHIFT = 29;

export class Tree {
  text: Uint8Array = new Uint8Array(0);
  n: number = 0;
  cfg: Config = new Config();
  at: number = 0;
  /** A `\r` was seen: the text has to be made to have `\n` and parsed again. */
  sawCr: boolean = false;
  /** The quote that a string is written in if it is not rewritten (a byte), -1 if that depends on the string. */
  qb: number = 34;
  /** U+2028 and U+2029 skipped since it was reset, which end a line for who asks whether the next one is empty. */
  lineSeps: number = 0;
  /** The line breaks and separators between the last `{` and the first name. */
  braceBreaks: number = 0;
  braceSeps: number = 0;
  /** The line breaks in the block comments that one call of `trivia` has skipped. */
  coldBreaks: number = 0;
  /** The comments from this index on do not know what follows them yet. */
  unresolved: number = 0;

  nodes: Int32Array = new Int32Array(8 * 256);
  nodeCount: number = 0;
  comments: Int32Array = new Int32Array(8 * 16);
  commentCount: number = 0;
  open: Int32Array = new Int32Array(8 * 32);
  depth: number = 0;
  /** The node that `close` finished (state `S_AFTER_VALUE`). */
  closed: number = 0;
  nameRequiresQuotes: boolean = false;
  /** For a text that has to be made to know how wide it is. */
  scratch: ByteBuf = new ByteBuf(256);

  // ---------------------------------------------------------------------------------------- tables

  growNodes(): void {
    const nn = new Int32Array(this.nodes.length * 2);
    nn.set(this.nodes);
    this.nodes = nn;
  }

  growComments(): void {
    const nn = new Int32Array(this.comments.length * 2);
    nn.set(this.comments);
    this.comments = nn;
  }

  growOpen(): void {
    const nn = new Int32Array(this.open.length * 2);
    nn.set(this.open);
    this.open = nn;
  }

  /** Appends a node (`end`: where it ends now). Returns its index. */
  push(kind: number, start: number, end: number, width: number, flags: number): number {
    const index = this.nodeCount;
    const b = index << 3;
    if (b + 8 > this.nodes.length) this.growNodes();
    this.nodes[b] = start | 0;
    this.nodes[b + 1] = end | 0;
    this.nodes[b + 2] = (index + 1) | 0;
    this.nodes[b + 3] = 0;
    this.nodes[b + 4] = width | 0;
    this.nodes[b + 5] = kind | 0;
    this.nodes[b + 6] = flags | 0;
    this.nodeCount = index + 1;
    return index;
  }

  // ---------------------------------------------------------------------------------------- entry

  /**
   * Fills the tree from `text`. It has no nodes if there is nothing but white space and comments. Returns 0, or -1 if the
   * text is refused (`refusalMessage()`, `refusalOffset()`). `sawCr`: whether the text has a `\r` where the parser has been.
   */
  parse(text: Uint8Array, cfg: Config): number {
    this.text = text;
    this.n = text.length;
    this.cfg.copyFrom(cfg);
    this.qb = cfg.stringQuote === QUOTE_NONE ? -1 : cfg.stringQuote === 0 ? 34 : 39;
    this.at = 0;
    this.sawCr = false;
    this.lineSeps = 0;
    this.braceBreaks = 0;
    this.braceSeps = 0;
    this.unresolved = 0;
    this.nodeCount = 0;
    this.commentCount = 0;
    this.depth = 0;
    if (text.length >= AT_MASK) {
      noteRefusal(MSG_TOO_LARGE, 0);
      return -1;
    }
    // A node for every six bytes is what minified JSON has.
    const want = ((text.length / 6) | 0) + 16;
    if (want * 8 > this.nodes.length) {
      let cap = this.nodes.length;
      while (cap < want * 8) cap = cap * 2;
      this.nodes = new Int32Array(cap);
    }
    if (this.run() < 0) {
      this.reason();
      return -1;
    }
    return 0;
  }

  /** What is wrong where the reader has stopped: before what it refuses. */
  reason(): void {
    const t = this.text;
    const n = this.n;
    const at = this.at;
    let behindSign = false;
    for (let k = 0; k < 2; k++) {
      const i = this.nodeCount - 1 - k;
      if (i < 0) break;
      if ((this.nodes[(i << 3) + N_KIND] | 0) === K_UNARY && (this.nodes[(i << 3) + N_WIDTH] | 0) === 0) behindSign = true;
    }
    let message = MSG_UNEXPECTED_TOKEN;
    if (at >= n) {
      message = MSG_UNEXPECTED_END;
    } else if (behindSign) {
      message = MSG_UNEXPECTED_TOKEN;
    } else {
      const c = t[at] | 0;
      if (c === 34 || c === 39) {
        let p = at + 1;
        while (p < n && (t[p] | 0) !== 10 && (t[p] | 0) !== c) p = p + 1 + ((t[p] | 0) === 92 ? 1 : 0);
        message = p < n && (t[p] | 0) === c ? MSG_INVALID_ESCAPE_SEQUENCE : MSG_UNCLOSED_STRING;
      } else if (c === 47 && at + 1 < n && (t[at + 1] | 0) === 42) {
        message = MSG_UNCLOSED_COMMENT;
      } else if (this.depth === 0 && this.nodeCount > 0) {
        message = MSG_EXPECTED_END_OF_FILE;
      }
    }
    noteRefusal(message, at);
  }

  // ---------------------------------------------------------------------------------------- the machine

  /** Gives up at `at`. */
  fail(at: number, nc: number, depth: number): number {
    this.at = at;
    this.nodeCount = nc;
    this.depth = depth;
    return -1;
  }

  /**
   * The machine, in one function so that what is usual (a string, a number, a `,`, white space) costs no call. Everything
   * else is done by methods, which are given the state: `at`, `nc` (the number of nodes) and `depth` are locals here and
   * `this.at`, `this.nodeCount` and `this.depth` there.
   */
  run(): number {
    const t = this.text;
    const n = this.n | 0;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const parser = this.cfg.parser | 0;
    const isStringify = parser === PARSER_STRINGIFY;
    const isJson5 = parser === PARSER_JSON5;
    const oxfmt = this.cfg.isOxfmt;
    const qb = this.qb | 0;
    let nodes = this.nodes;
    let open = this.open;
    let at = 0;
    let nc = 0;
    let depth = 0;
    let state = S_VALUE;
    let value = 0;
    let braceBreaks = 0;
    let r = this.trivia(t, 0, OWNER_NONE, OWNER_NONE);
    if (r < 0) return -1;
    at = r & AT_MASK;
    this.at = at;
    if (at === n) return 0;
    while (true) {
      if (state === S_AFTER_VALUE) {
        if (depth === 0) {
          this.at = at;
          this.nodeCount = nc;
          this.depth = depth;
          r = this.trivia(t, at, OWNER_NONE, ownerNode(value));
          if (r < 0) return -1;
          at = r & AT_MASK;
          this.at = at;
          return at === n ? 0 : -1;
        }
        // `value` is complete. It is in a container.
        const vb = value << 3;
        const ob = (depth - 1) << 3;
        const containerNode = open[ob + O_NODE] | 0;
        const isObject = (nodes[(containerNode << 3) + N_KIND] | 0) === K_OBJECT;
        if (!isObject) {
          const nodeKind = nodes[vb + N_KIND] | 0;
          const lastValue = open[ob + O_LAST_VALUE] | 0;
          const isContainer = nodeKind === K_OBJECT || nodeKind === K_ARRAY;
          const isLikePrevious =
            isContainer && (nodes[vb + N_COUNT] | 0) > 1 && (lastValue < 0 || (nodes[(lastValue << 3) + N_KIND] | 0) === nodeKind);
          const isNumber =
            nodeKind === K_NUMBER || (nodeKind === K_UNARY && value + 1 < nc && (nodes[((value + 1) << 3) + N_KIND] | 0) === K_NUMBER);
          const elements = open[ob + O_ELEMENTS] | 0;
          if ((elements === EK_UNKNOWN || elements === EK_NUMBERS) && isNumber) open[ob + O_ELEMENTS] = EK_NUMBERS;
          else if ((elements === EK_UNKNOWN || elements === EK_CONTAINERS) && isLikePrevious) open[ob + O_ELEMENTS] = EK_CONTAINERS;
          else open[ob + O_ELEMENTS] = EK_MIXED;
        }
        open[ob + O_COUNT] = ((open[ob + O_COUNT] | 0) + 1) | 0;
        let w = (open[ob + O_WIDTH] | 0) + (nodes[vb + N_WIDTH] | 0);
        if (w > MUST_BREAK) w = MUST_BREAK;
        open[ob + O_WIDTH] = w | 0;
        open[ob + O_LAST_VALUE] = value | 0;
        const lastChild = isObject ? ownerProperty(open[ob + O_NAME] | 0) : ownerNode(value);
        open[ob + O_LAST_CHILD] = lastChild | 0;
        open[ob + O_FLAGS] = (open[ob + O_FLAGS] | 0) & ~OF_LAST_HOLE;

        this.lineSeps = 0;
        let lb = 0;
        // White space and comments: usually the `,` or the end follows at once.
        while (at < n) {
          const c = t[at] | 0;
          if (c === 32 || c === 9) {
            at = ((at | 0) + 1) | 0;
          } else if (c === 10) {
            at = ((at | 0) + 1) | 0;
            lb = ((lb | 0) + 1) | 0;
          } else {
            break;
          }
        }
        let c = at < n ? t[at] | 0 : -1;
        if (c === 47 || c === 11 || c === 12 || c === 13 || c >= 0x80) {
          this.at = at;
          this.nodeCount = nc;
          this.depth = depth;
          r = this.trivia(t, at, ownerNode(containerNode), lastChild);
          if (r < 0) return -1;
          at = r & AT_MASK;
          lb = ((lb | 0) + (r >> LB_SHIFT)) | 0;
          c = at < n ? t[at] | 0 : -1;
        }
        const end = isObject ? 125 : 93;
        if (c === 44) {
          at = ((at | 0) + 1) | 0;
          if (oxfmt) {
            lb = 0;
            this.lineSeps = 0;
          }
          while (at < n) {
            const c2 = t[at] | 0;
            if (c2 === 32 || c2 === 9) {
              at = ((at | 0) + 1) | 0;
            } else if (c2 === 10) {
              at = ((at | 0) + 1) | 0;
              lb = ((lb | 0) + 1) | 0;
            } else {
              break;
            }
          }
          c = at < n ? t[at] | 0 : -1;
          if (c === 47 || c === 11 || c === 12 || c === 13 || c >= 0x80) {
            this.at = at;
            this.nodeCount = nc;
            this.depth = depth;
            r = this.trivia(t, at, ownerNode(containerNode), lastChild);
            if (r < 0) return -1;
            at = r & AT_MASK;
            lb = ((lb | 0) + (r >> LB_SHIFT)) | 0;
            c = at < n ? t[at] | 0 : -1;
          }
          if (c === end) {
            this.at = at;
            this.nodeCount = nc;
            this.depth = depth;
            this.close();
            at = this.at;
            depth = this.depth;
            value = this.closed;
            continue;
          }
          // What is asked skips any number of commas: those of holes too.
          if ((lb + this.lineSeps > 1 || c === 44 || (oxfmt && this.unresolved !== this.commentCount)) && !isStringify) {
            this.blankAfter(t, value, isObject ? K_OBJECT : K_ARRAY, lb, ob);
          }
          state = isObject ? S_NAME_OR_END : S_ELEMENT_OR_END;
          continue;
        }
        if (c === end) {
          this.at = at;
          this.nodeCount = nc;
          this.depth = depth;
          this.close();
          at = this.at;
          depth = this.depth;
          value = this.closed;
          continue;
        }
        return this.fail(at, nc, depth);
      }

      // `at` is where a name, an element or a value starts.
      if (at >= n) return this.fail(at, nc, depth);
      const c = t[at] | 0;
      let isName = false;
      if (state === S_NAME_OR_END) {
        if (c === 125) {
          this.at = at;
          this.nodeCount = nc;
          this.depth = depth;
          this.close();
          at = this.at;
          depth = this.depth;
          value = this.closed;
          state = S_AFTER_VALUE;
          continue;
        }
        const ob = (depth - 1) << 3;
        if ((open[ob + O_COUNT] | 0) === 0 && (braceBreaks > 0 || (this.lineSeps > 0 && oxfmt))) {
          const nb = ((open[ob + O_NODE] | 0) << 3) + N_FLAGS;
          nodes[nb] = (nodes[nb] | 0) | BREAK_AFTER_OPEN;
        }
        if (this.unresolved !== this.commentCount) this.resolveFollowing(ownerProperty(nc));
        isName = true;
      } else {
        if (state === S_ELEMENT_OR_END) {
          if (c === 93) {
            this.at = at;
            this.nodeCount = nc;
            this.depth = depth;
            this.close();
            at = this.at;
            depth = this.depth;
            value = this.closed;
            state = S_AFTER_VALUE;
            continue;
          }
          if (c === 44) {
            // `JSON.stringify` writes `null`.
            this.nodeCount = nc;
            this.push(K_HOLE, at, at, 0, 0);
            nc = this.nodeCount;
            nodes = this.nodes;
            const ob = (depth - 1) << 3;
            open[ob + O_COUNT] = ((open[ob + O_COUNT] | 0) + 1) | 0;
            open[ob + O_LAST_VALUE] = -1;
            open[ob + O_FLAGS] = (open[ob + O_FLAGS] | 0) | OF_LAST_HOLE;
            open[ob + O_ELEMENTS] = EK_MIXED;
            this.at = at;
            this.nodeCount = nc;
            this.depth = depth;
            r = this.trivia(t, at + 1, ownerNode(open[ob + O_NODE] | 0), open[ob + O_LAST_CHILD] | 0);
            if (r < 0) return -1;
            at = r & AT_MASK;
            continue;
          }
        }
        // value()
        if (this.unresolved !== this.commentCount) this.resolveFollowing(ownerNode(nc));
      }

      // A scalar, or the start of a container.
      let v = -1;
      let kind = K_STRING;
      let end = 0;
      let width = 0;
      let flags = 0;
      if (c === 34 || c === 39) {
        // Printable ASCII up to the quote, eight bytes at a time (a byte of `x` is zero if the byte is a quote or a
        // backslash; the lowest flag is exact).
        let i = ((at | 0) + 1) | 0;
        const q4 = Math.imul(c, 0x01010101) | 0;
        const end8 = (n - 8) | 0;
        let found = -1;
        while (i <= end8) {
          const w0 = dv.getInt32(i, true) | 0;
          const x1 = w0 ^ q4;
          const x2 = w0 ^ 0x5c5c5c5c;
          const f1 = (((x1 - 0x01010101) & ~x1) | ((x2 - 0x01010101) & ~x2) | ((w0 - 0x20202020) & ~w0) | w0) & 0x80808080;
          if (f1 !== 0) {
            found = (i + ((31 - Math.clz32(f1 & -f1)) >> 3)) | 0;
            break;
          }
          const w1 = dv.getInt32(((i | 0) + 4) | 0, true) | 0;
          const y1 = w1 ^ q4;
          const y2 = w1 ^ 0x5c5c5c5c;
          const f2 = (((y1 - 0x01010101) & ~y1) | ((y2 - 0x01010101) & ~y2) | ((w1 - 0x20202020) & ~w1) | w1) & 0x80808080;
          if (f2 !== 0) {
            found = (i + 4 + ((31 - Math.clz32(f2 & -f2)) >> 3)) | 0;
            break;
          }
          i = ((i | 0) + 8) | 0;
        }
        if (found < 0) {
          for (; i < n; i++) {
            const ch = t[i] | 0;
            if (ch === c || ch === 92 || ((ch - 32) >>> 0) > 94) {
              found = i;
              break;
            }
          }
          if (found < 0) return this.fail(at, nc, depth);
        }
        // Nothing but printable ASCII, in the quotes that it is written in: as many columns as bytes.
        if ((t[found] | 0) === c && c === qb) {
          kind = K_STRING;
          end = ((found | 0) + 1) | 0;
          width = ((found | 0) - (at | 0) + 1) | 0;
        } else {
          this.at = at;
          this.nodeCount = nc;
          this.depth = depth;
          v = this.stringFrom(t, found, c);
          if (v < 0) return -1;
          at = this.at;
          nc = this.nodeCount;
          nodes = this.nodes;
        }
      } else if (!isName && c === 123) {
        // {
        this.at = at;
        this.nodeCount = nc;
        this.depth = depth;
        const object = this.openContainer(K_OBJECT);
        this.lineSeps = 0;
        r = this.trivia(t, this.at, ownerNode(object), OWNER_NONE);
        if (r < 0) return -1;
        at = r & AT_MASK;
        braceBreaks = r >> LB_SHIFT;
        nc = this.nodeCount;
        depth = this.depth;
        nodes = this.nodes;
        open = this.open;
        state = S_NAME_OR_END;
        continue;
      } else if (!isName && c === 91) {
        // [
        this.at = at;
        this.nodeCount = nc;
        this.depth = depth;
        const array = this.openContainer(K_ARRAY);
        r = this.trivia(t, this.at, ownerNode(array), OWNER_NONE);
        if (r < 0) return -1;
        at = r & AT_MASK;
        nc = this.nodeCount;
        depth = this.depth;
        nodes = this.nodes;
        open = this.open;
        state = S_ELEMENT_OR_END;
        continue;
      } else if (c >= 48 && c <= 57) {
        // The usual numbers: 1, 25, 0, 100000, followed by what ends a value.
        let i = ((at | 0) + 1) | 0;
        while (i < n) {
          const ch = t[i] | 0;
          if (ch < 48 || ch > 57) break;
          i = ((i | 0) + 1) | 0;
        }
        const after = i < n ? t[i] | 0 : 44;
        if ((c !== 48 || i === at + 1) && (after === 44 || after === 10 || after === 32 || after === 9 || after === 93 || after === 125)) {
          kind = K_NUMBER;
          end = i;
          width = ((i | 0) - (at | 0)) | 0;
        } else {
          this.at = at;
          this.nodeCount = nc;
          this.depth = depth;
          v = this.number(t);
          if (v < 0) return -1;
          at = this.at;
          nc = this.nodeCount;
          nodes = this.nodes;
        }
      } else if (c === 46) {
        this.at = at;
        this.nodeCount = nc;
        this.depth = depth;
        v = this.number(t);
        if (v < 0) return -1;
        at = this.at;
        nc = this.nodeCount;
        nodes = this.nodes;
      } else if (isName) {
        this.at = at;
        this.nodeCount = nc;
        this.depth = depth;
        v = this.identifier(t);
        if (v < 0) return -1;
        at = this.at;
        nc = this.nodeCount;
        nodes = this.nodes;
      } else {
        this.at = at;
        this.nodeCount = nc;
        this.depth = depth;
        if (c === 96) v = this.template(t);
        else if (c === 43 || c === 45) v = this.unary(t);
        else v = this.keyword(t);
        if (v < 0) return -1;
        at = this.at;
        nc = this.nodeCount;
        nodes = this.nodes;
      }
      if (v < 0) {
        // Appends the node.
        const b = nc << 3;
        if (b + 8 > nodes.length) {
          this.nodeCount = nc;
          this.growNodes();
          nodes = this.nodes;
        }
        nodes[b] = at | 0;
        nodes[b + 1] = end | 0;
        nodes[b + 2] = ((nc | 0) + 1) | 0;
        nodes[b + 3] = 0;
        nodes[b + 4] = width | 0;
        nodes[b + 5] = kind | 0;
        nodes[b + 6] = flags | 0;
        v = nc;
        nc = ((nc | 0) + 1) | 0;
        at = end;
      }

      if (!isName) {
        value = v;
        state = S_AFTER_VALUE;
        continue;
      }

      // A name: what is after it is `:` and the value.
      {
        const ob = (depth - 1) << 3;
        const nb = v << 3;
        let nameWidth: number;
        if ((nodes[nb + N_KIND] | 0) === K_STRING && !isJson5) {
          nameWidth = nodes[nb + N_WIDTH] | 0;
          open[ob + O_NAME] = v | 0;
          let w2 = (open[ob + O_WIDTH] | 0) + nameWidth;
          if (w2 > MUST_BREAK) w2 = MUST_BREAK;
          open[ob + O_WIDTH] = w2 | 0;
        } else {
          this.at = at;
          this.nodeCount = nc;
          this.depth = depth;
          this.name(t, v);
        }
        let c2 = at < n ? t[at] | 0 : 0;
        // Usually the `:` follows, or a blank does.
        if (c2 <= 32 || c2 >= 0x7f || c2 === 47) {
          this.at = at;
          this.nodeCount = nc;
          this.depth = depth;
          r = this.trivia(t, at, ownerProperty(v), ownerNode(v));
          if (r < 0) return -1;
          at = r & AT_MASK;
          c2 = at < n ? t[at] | 0 : 0;
        }
        if (c2 !== 58) return this.fail(at, nc, depth);
        at = ((at | 0) + 1) | 0;
        c2 = at < n ? t[at] | 0 : 0;
        if (c2 === 32) {
          at = ((at | 0) + 1) | 0;
          c2 = at < n ? t[at] | 0 : 0;
        }
        if (c2 <= 32 || c2 >= 0x7f || c2 === 47) {
          this.at = at;
          this.nodeCount = nc;
          this.depth = depth;
          r = this.trivia(t, at, ownerProperty(v), ownerNode(v));
          if (r < 0) return -1;
          at = r & AT_MASK;
        }
        state = S_VALUE;
      }
    }
  }

  /**
   * White space and comments from `start`. `enclosing`, `preceding`: see the comment slots. Returns the new place in bits
   * 0..28 and the number of line breaks in bits 29..30 (0, 1, or 2 for two or more), or -1.
   */
  trivia(t: Uint8Array, start: number, enclosing: number, preceding: number): number {
    const n = this.n | 0;
    let at = start | 0;
    let lb = 0;
    while (true) {
      at = skipBlanks(t, at);
      while (at < n && (t[at] | 0) === 10) {
        lb = ((lb | 0) + 1) | 0;
        at = skipBlanks(t, ((at | 0) + 1) | 0);
      }
      if (at >= n) break;
      const c = t[at] | 0;
      if (c !== 47 && c < 0x80 && c !== 11 && c !== 12 && c !== 13) break;
      // A comment, or white space of another kind.
      this.coldBreaks = 0;
      const r = this.rareTrivia(t, at, enclosing, preceding);
      if (r === -1) {
        this.at = at;
        return -1;
      }
      if (r === -2) break;
      at = r | 0;
      lb = ((lb | 0) + (this.coldBreaks | 0)) | 0;
    }
    return at | ((lb > 2 ? 2 : lb) << LB_SHIFT);
  }

  /**
   * A comment, or white space other than a blank, a tab and a line break, at `at`. Returns the place after it, -2 if there is
   * none, or -1 if a comment is not closed.
   */
  rareTrivia(t: Uint8Array, at: number, enclosing: number, preceding: number): number {
    const c = t[at] | 0;
    if (c === 47) return this.comment(t, at, enclosing, preceding);
    if (c >= 0x80) {
      const len = jsWhitespaceLen(t, at, this.n);
      if (len === 0) return -2;
      if (len === 3 && (t[at] | 0) === 0xe2 && (t[at + 1] | 0) === 0x80 && ((t[at + 2] | 0) === 0xa8 || (t[at + 2] | 0) === 0xa9)) {
        this.lineSeps = this.lineSeps + 1;
      }
      return at + len;
    }
    if (c === 13) {
      this.sawCr = true;
      return -2;
    }
    return at + 1;
  }

  /** A comment at `start`. Returns the place after it, or -1. */
  comment(t: Uint8Array, start: number, enclosing: number, preceding: number): number {
    const n = this.n;
    const second = start + 1 < n ? t[start + 1] | 0 : -1;
    let end: number;
    let isBlock = 0;
    if (second === 47) {
      let e = start + 2;
      while (e < n && (t[e] | 0) !== 10) e = e + 1;
      // U+2028 and U+2029 end a line too.
      for (let i = start + 2; i + 2 < e; i++) {
        if ((t[i] | 0) === 0xe2 && (t[i + 1] | 0) === 0x80 && ((t[i + 2] | 0) === 0xa8 || (t[i + 2] | 0) === 0xa9)) {
          e = i;
          break;
        }
      }
      end = e;
    } else if (second === 42) {
      let e = start + 2;
      let found = -1;
      let lb = 0;
      while (e + 1 < n) {
        const c = t[e] | 0;
        if (c === 42 && (t[e + 1] | 0) === 47) {
          found = e;
          break;
        }
        if (c === 10) lb = lb + 1;
        e = e + 1;
      }
      if (found < 0) return -1;
      this.coldBreaks = this.coldBreaks + lb;
      end = found + 2;
      isBlock = 1;
    } else {
      return -1;
    }
    for (let i = start; i < end; i++) {
      if ((t[i] | 0) === 13) {
        this.sawCr = true;
        break;
      }
    }
    const index = this.commentCount;
    const b = index << 3;
    if (b + 8 > this.comments.length) this.growComments();
    this.comments[b] = start | 0;
    this.comments[b + 1] = end | 0;
    this.comments[b + 2] = isBlock;
    this.comments[b + 3] = enclosing | 0;
    this.comments[b + 4] = preceding | 0;
    this.comments[b + 5] = OWNER_NONE;
    this.commentCount = index + 1;
    return end;
  }

  /** `owner` is about to be read. */
  resolveFollowing(owner: number): void {
    const count = this.commentCount;
    for (let i = this.unresolved; i < count; i++) this.comments[(i << 3) + C_FOLLOWING] = owner | 0;
    this.unresolved = count;
  }

  /** Opens a container at the cursor. Returns the node. */
  openContainer(kind: number): number {
    const start = this.at;
    this.at = start + 1;
    const node = this.push(kind, start, start + 1, 0, 0);
    const d = this.depth;
    const b = d << 3;
    if (b + 8 > this.open.length) this.growOpen();
    this.open[b + O_NODE] = node | 0;
    this.open[b + O_COUNT] = 0;
    this.open[b + O_WIDTH] = 0;
    this.open[b + O_LAST_VALUE] = -1;
    this.open[b + O_LAST_CHILD] = OWNER_NONE;
    this.open[b + O_NAME] = 0;
    this.open[b + O_FLAGS] = 0;
    this.open[b + O_ELEMENTS] = EK_UNKNOWN;
    this.depth = d + 1;
    return node;
  }

  // ---------------------------------------------------------------------------------------- values

  /** A sign and the number (or `Infinity`, `NaN`) after it. Returns the node of the sign, or -1. */
  unary(t: Uint8Array): number {
    const start = this.at;
    this.at = start + 1;
    const unary = this.push(K_UNARY, start, start + 1, 0, 0);
    const r = this.trivia(t, this.at, ownerNode(unary), OWNER_NONE);
    if (r < 0) return -1;
    const at = r & AT_MASK;
    this.at = at;
    if (this.unresolved !== this.commentCount) this.resolveFollowing(ownerNode(unary + 1));
    const c = at < this.n ? t[at] | 0 : -1;
    let operand: number;
    if ((c >= 48 && c <= 57) || c === 46) {
      operand = this.number(t);
      if (operand < 0) return -1;
    } else {
      operand = this.identifier(t);
      if (operand < 0) return -1;
      if (!this.isSourceOneOf(t, operand, 2)) {
        this.at = this.nodes[(operand << 3) + N_START] | 0;
        return -1;
      }
    }
    const ob = operand << 3;
    // `JSON.stringify` has no `+`.
    const sign = !(this.cfg.parser === PARSER_STRINGIFY && (t[start] | 0) === 43) ? 1 : 0;
    const ub = unary << 3;
    this.nodes[ub + N_END] = this.nodes[ob + N_END] | 0;
    this.nodes[ub + N_NEXT] = this.nodes[ob + N_NEXT] | 0;
    this.nodes[ub + N_WIDTH] = satAdd(this.nodes[ob + N_WIDTH] | 0, sign) | 0;
    return unary;
  }

  /** An identifier that is `null`, `true`, `false`, `Infinity`, `NaN` or `undefined`. Returns its node, or -1. */
  keyword(t: Uint8Array): number {
    const start = this.at;
    const n = this.n;
    // The usual ones.
    const c = t[start] | 0;
    let len = 0;
    if (c === 116 && start + 4 <= n && (t[start + 1] | 0) === 114 && (t[start + 2] | 0) === 117 && (t[start + 3] | 0) === 101) len = 4;
    else if (c === 102 && start + 5 <= n && (t[start + 1] | 0) === 97 && (t[start + 2] | 0) === 108 && (t[start + 3] | 0) === 115 && (t[start + 4] | 0) === 101) len = 5;
    else if (c === 110 && start + 4 <= n && (t[start + 1] | 0) === 117 && (t[start + 2] | 0) === 108 && (t[start + 3] | 0) === 108) len = 4;
    if (len > 0) {
      const after = start + len < n ? t[start + len] | 0 : 44;
      if (!((after >= 97 && after <= 122) || (after >= 65 && after <= 90) || (after >= 48 && after <= 57) || after === 36 || after === 95 || after === 92 || after >= 0x80)) {
        this.at = start + len;
        return this.push(K_IDENTIFIER, start, start + len, len, 0);
      }
    }
    const identifier = this.identifier(t);
    if (identifier < 0) return -1;
    if (this.isSourceOneOf(t, identifier, 1)) return identifier;
    this.at = this.nodes[(identifier << 3) + N_START] | 0;
    this.nodeCount = identifier;
    return -1;
  }

  /** `which` 1: null, true, false, Infinity, NaN, undefined. 2: Infinity, NaN. */
  isSourceOneOf(t: Uint8Array, node: number, which: number): boolean {
    const s = this.nodes[(node << 3) + N_START] | 0;
    const e = this.nodes[(node << 3) + N_END] | 0;
    const len = e - s;
    const c = t[s] | 0;
    if (len === 3) return c === 78 && (t[s + 1] | 0) === 97 && (t[s + 2] | 0) === 78; // NaN
    if (len === 8) return c === 73 && matchAt(t, s, "Infinity");
    if (which === 2) return false;
    if (len === 4) return (c === 110 && matchAt(t, s, "null")) || (c === 116 && matchAt(t, s, "true"));
    if (len === 5) return c === 102 && matchAt(t, s, "false");
    if (len === 9) return c === 117 && matchAt(t, s, "undefined");
    return false;
  }

  /** The name of a property, or `}`. */
  nameOrEnd(t: Uint8Array): number {
    const n = this.n;
    let at = this.at;
    if (at < n && (t[at] | 0) === 125) return this.close();
    const ob = (this.depth - 1) << 3;
    if ((this.open[ob + O_COUNT] | 0) === 0 && (this.braceBreaks > 0 || (this.braceSeps > 0 && this.cfg.isOxfmt))) {
      const nb = ((this.open[ob + O_NODE] | 0) << 3) + N_FLAGS;
      this.nodes[nb] = (this.nodes[nb] | 0) | BREAK_AFTER_OPEN;
    }
    if (this.unresolved !== this.commentCount) this.resolveFollowing(ownerProperty(this.nodeCount));
    if (at >= n) return -1;
    const c = t[at] | 0;
    let name: number;
    if (c === 34 || c === 39) name = this.string(t, c);
    else if ((c >= 48 && c <= 57) || c === 46) name = this.number(t);
    else name = this.identifier(t);
    if (name < 0) return -1;
    this.name(t, name);
    at = this.at;
    let c2 = at < n ? t[at] | 0 : 0;
    // Usually the `:` follows, or a blank does.
    if (c2 <= 32 || c2 >= 0x7f || c2 === 47) {
      const r = this.trivia(t, at, ownerProperty(name), ownerNode(name));
      if (r < 0) return -1;
      at = r & AT_MASK;
      this.at = at;
      c2 = at < n ? t[at] | 0 : 0;
    }
    if (c2 !== 58) return -1;
    at = ((at | 0) + 1) | 0;
    c2 = at < n ? t[at] | 0 : 0;
    if (c2 === 32) {
      at = ((at | 0) + 1) | 0;
      c2 = at < n ? t[at] | 0 : 0;
    }
    if (c2 <= 32 || c2 >= 0x7f || c2 === 47) {
      const r = this.trivia(t, at, ownerProperty(name), ownerNode(name));
      if (r < 0) return -1;
      at = r & AT_MASK;
    }
    this.at = at;
    return S_VALUE;
  }

  /** `index` is the name of a property. */
  name(t: Uint8Array, index: number): void {
    const b = index << 3;
    let width: number;
    let requiresQuotes = false;
    if ((this.nodes[b + N_KIND] | 0) === K_STRING && this.cfg.parser !== PARSER_JSON5) {
      width = this.nodes[b + N_WIDTH] | 0;
    } else {
      width = this.printName(t, index);
      requiresQuotes = this.nameRequiresQuotes;
    }
    const ob = (this.depth - 1) << 3;
    this.open[ob + O_NAME] = index | 0;
    this.open[ob + O_WIDTH] = satAdd(this.open[ob + O_WIDTH] | 0, width) | 0;
    if (requiresQuotes) this.open[ob + O_FLAGS] = (this.open[ob + O_FLAGS] | 0) | OF_REQUIRES_QUOTES;
  }

  /**
   * Prettier's `printKey`, except for what depends on the other names: see `close`. A string is only looked at in `json5`:
   * elsewhere it stays as it is. Returns how wide the name is; `nameRequiresQuotes`: whether it is a string that cannot do
   * without its quotes.
   */
  printName(t: Uint8Array, index: number): number {
    const b = index << 3;
    const start = this.nodes[b + N_START] | 0;
    const end = this.nodes[b + N_END] | 0;
    const kind = this.nodes[b + N_KIND] | 0;
    let width = this.nodes[b + N_WIDTH] | 0;
    let flags = this.nodes[b + N_FLAGS] | 0;
    let requiresQuotes = false;
    const alwaysQuotes = this.cfg.parser !== PARSER_JSON5;
    if (kind === K_STRING) {
      if (!isEs5IdentifierName(t, start + 1, end - 1)) {
        requiresQuotes = true;
      } else if (this.cfg.quoteProperties === QUOTE_PROPS_AS_NEEDED) {
        flags = (flags | UNQUOTED) & ~REWRITTEN;
        width = stringWidth(t, start + 1, end - 1);
      }
    } else if (kind === K_NUMBER && this.cfg.parser === PARSER_STRINGIFY) {
      // `String(Number(raw)) === raw`
      if (numberToStringIsSame(t, start, end)) {
        flags = flags | QUOTED;
        width = width + 2;
      }
    } else if (kind === K_NUMBER && alwaysQuotes) {
      if (this.isCanonicalNumberName(t, start, end)) {
        flags = flags | QUOTED;
        width = width + 2;
      }
    } else if (kind === K_IDENTIFIER && alwaysQuotes) {
      flags = flags | QUOTED;
      width = width + 2;
    }
    this.nodes[b + N_WIDTH] = width | 0;
    this.nodes[b + N_FLAGS] = flags | 0;
    this.nameRequiresQuotes = requiresQuotes;
    return width;
  }

  /** `is_simple_number(&printed) && is_canonical_simple_number(&printed)` where `printed = format_trimmed_number(source)`. */
  isCanonicalNumberName(t: Uint8Array, start: number, end: number): boolean {
    const r = trimmedNumber(t, start, end);
    if (r < 0) return isSimpleNumber(t, start, end) && isCanonicalSimpleNumber(t, start, end);
    const nb = numBuf();
    return isSimpleNumber(nb, 0, r) && isCanonicalSimpleNumber(nb, 0, r);
  }

  /** An element, a hole, or `]`. */
  elementOrEnd(t: Uint8Array): number {
    const n = this.n;
    const at = this.at;
    const c = at < n ? t[at] | 0 : -1;
    if (c === 93) return this.close();
    if (c === 44) {
      // `JSON.stringify` writes `null`.
      this.push(K_HOLE, at, at, 0, 0);
      this.at = at + 1;
      const ob = (this.depth - 1) << 3;
      this.open[ob + O_COUNT] = (this.open[ob + O_COUNT] | 0) + 1;
      this.open[ob + O_LAST_VALUE] = -1;
      this.open[ob + O_FLAGS] = (this.open[ob + O_FLAGS] | 0) | OF_LAST_HOLE;
      this.open[ob + O_ELEMENTS] = EK_MIXED;
      const r = this.trivia(t, at + 1, ownerNode(this.open[ob + O_NODE] | 0), this.open[ob + O_LAST_CHILD] | 0);
      if (r < 0) return -1;
      this.at = r & AT_MASK;
      return S_ELEMENT_OR_END;
    }
    return S_VALUE;
  }

  /** `value` is complete. It is in a container. */
  afterValue(t: Uint8Array, value: number): number {
    const n = this.n;
    const vb = value << 3;
    const nodeKind = this.nodes[vb + N_KIND] | 0;
    const nodeWidth = this.nodes[vb + N_WIDTH] | 0;
    const ob = (this.depth - 1) << 3;
    const container = this.nodes[((this.open[ob + O_NODE] | 0) << 3) + N_KIND] | 0;
    if (container === K_ARRAY) {
      const nodeCount = this.nodes[vb + N_COUNT] | 0;
      const lastValue = this.open[ob + O_LAST_VALUE] | 0;
      const isContainer = nodeKind === K_OBJECT || nodeKind === K_ARRAY;
      const isLikePrevious = isContainer && nodeCount > 1 && (lastValue < 0 || (this.nodes[(lastValue << 3) + N_KIND] | 0) === nodeKind);
      const isNumber =
        nodeKind === K_NUMBER || (nodeKind === K_UNARY && value + 1 < this.nodeCount && (this.nodes[((value + 1) << 3) + N_KIND] | 0) === K_NUMBER);
      const elements = this.open[ob + O_ELEMENTS] | 0;
      if ((elements === EK_UNKNOWN || elements === EK_NUMBERS) && isNumber) this.open[ob + O_ELEMENTS] = EK_NUMBERS;
      else if ((elements === EK_UNKNOWN || elements === EK_CONTAINERS) && isLikePrevious) this.open[ob + O_ELEMENTS] = EK_CONTAINERS;
      else this.open[ob + O_ELEMENTS] = EK_MIXED;
    }
    this.open[ob + O_COUNT] = (this.open[ob + O_COUNT] | 0) + 1;
    this.open[ob + O_WIDTH] = satAdd(this.open[ob + O_WIDTH] | 0, nodeWidth) | 0;
    this.open[ob + O_LAST_VALUE] = value | 0;
    const lastChild = container === K_OBJECT ? ownerProperty(this.open[ob + O_NAME] | 0) : ownerNode(value);
    this.open[ob + O_LAST_CHILD] = lastChild | 0;
    this.open[ob + O_FLAGS] = (this.open[ob + O_FLAGS] | 0) & ~OF_LAST_HOLE;
    const enclosing = ownerNode(this.open[ob + O_NODE] | 0);

    this.lineSeps = 0;
    let at = this.at | 0;
    let lb = 0;
    let c = at < n ? t[at] | 0 : -1;
    // Usually the `,` or the end follows at once.
    if (c <= 32 || c >= 0x7f || c === 47) {
      const r = this.trivia(t, at, enclosing, lastChild);
      if (r < 0) return -1;
      at = r & AT_MASK;
      lb = r >> LB_SHIFT;
      this.at = at;
      c = at < n ? t[at] | 0 : -1;
    }
    const end = container === K_OBJECT ? 125 : 93;
    if (c === 44) {
      if (this.cfg.isOxfmt) {
        lb = 0;
        this.lineSeps = 0;
      }
      const r = this.trivia(t, at + 1, enclosing, lastChild);
      if (r < 0) return -1;
      at = r & AT_MASK;
      lb = lb + (r >> LB_SHIFT);
      this.at = at;
      const next = at < n ? t[at] | 0 : -1;
      if (next === end) return this.close();
      // What is asked skips any number of commas: those of holes too.
      if ((lb + this.lineSeps > 1 || next === 44 || (this.cfg.isOxfmt && this.unresolved !== this.commentCount)) && this.cfg.parser !== PARSER_STRINGIFY) {
        this.blankAfter(t, value, container, lb, ob);
      }
      return container === K_OBJECT ? S_NAME_OR_END : S_ELEMENT_OR_END;
    }
    if (c === end) return this.close();
    return -1;
  }

  /** Whether an empty line follows `value`, which is followed by a comma, in an object or an array. */
  blankAfter(t: Uint8Array, value: number, container: number, lb: number, ob: number): void {
    // Where there is a comment in between, oxfmt's answer is Prettier's in all that is known.
    const hasComment = this.unresolved !== this.commentCount;
    const isBehindTheComma = this.cfg.isOxfmt;
    const vb = value << 3;
    const nodeEnd = this.nodes[vb + N_END] | 0;
    let isBlank: boolean;
    if (isBehindTheComma && !hasComment) isBlank = lb + this.lineSeps > 1;
    else if (container === K_OBJECT) isBlank = isNextLineEmpty(t, nodeEnd);
    else isBlank = isLineAfterElementEmpty(t, nodeEnd);
    if (isBlank) {
      this.nodes[vb + N_FLAGS] = (this.nodes[vb + N_FLAGS] | 0) | BLANK_AFTER;
      this.open[ob + O_FLAGS] = (this.open[ob + O_FLAGS] | 0) | OF_BLANK;
    }
  }

  /** At the `}` or the `]` of the innermost container. Returns `S_AFTER_VALUE`; `closed` is its node. */
  close(): number {
    this.at = this.at + 1;
    this.unresolved = this.commentCount;
    const d = this.depth - 1;
    this.depth = d;
    const ob = d << 3;
    const openNode = this.open[ob + O_NODE] | 0;
    const openCount = this.open[ob + O_COUNT] | 0;
    const openFlags = this.open[ob + O_FLAGS] | 0;
    const nb = openNode << 3;
    this.nodes[nb + N_END] = this.at | 0;
    this.nodes[nb + N_NEXT] = this.nodeCount | 0;
    this.nodes[nb + N_COUNT] = openCount | 0;
    this.closed = openNode;
    if (openCount === 0) {
      this.nodes[nb + N_WIDTH] = 2;
      return S_AFTER_VALUE;
    }
    const kind = this.nodes[nb + N_KIND] | 0;
    const parser = this.cfg.parser;
    let sum = this.open[ob + O_WIDTH] | 0;
    let mustBreak: boolean;
    if (parser === PARSER_STRINGIFY) {
      mustBreak = true;
    } else if (kind === K_OBJECT) {
      mustBreak = (openFlags & OF_BLANK) !== 0 || (this.cfg.preservesWrap && ((this.nodes[nb + N_FLAGS] | 0) & BREAK_AFTER_OPEN) !== 0);
    } else {
      mustBreak = this.closeArray(nb, openCount, openFlags, this.open[ob + O_ELEMENTS] | 0);
    }
    const isObject = kind === K_OBJECT;
    if (isObject && parser === PARSER_JSON5 && this.cfg.quoteProperties === QUOTE_PROPS_CONSISTENT) {
      sum = this.makeNamesConsistent(this.text, openNode, (openFlags & OF_REQUIRES_QUOTES) !== 0, sum);
    }
    const separators = (openCount - 1) * 2;
    let width: number;
    if (mustBreak) {
      width = MUST_BREAK;
    } else if (isObject) {
      // `: ` after each name, and the spaces inside the braces
      width = satAdd(satAdd(satAdd(sum, separators), satAdd(openCount, openCount)), 2 + (this.cfg.bracketSpacing ? 2 : 0));
    } else {
      width = satAdd(satAdd(sum, separators), 2 + ((openFlags & OF_LAST_HOLE) !== 0 ? 1 : 0));
    }
    this.nodes[nb + N_WIDTH] = width | 0;
    return S_AFTER_VALUE;
  }

  /** The flags of a closed array, and whether it must break. */
  closeArray(nb: number, openCount: number, openFlags: number, elementsKind: number): boolean {
    // `comment_ends_filling`: in oxfmt the numbers of an array with a comment in it are on a line each.
    let lastCommentStart = 0;
    if (this.commentCount > 0) lastCommentStart = this.comments[((this.commentCount - 1) << 3) + C_START] | 0;
    const isConcise = elementsKind === EK_NUMBERS && !(this.cfg.isOxfmt && lastCommentStart > (this.nodes[nb + N_START] | 0));
    if (isConcise) this.nodes[nb + N_FLAGS] = (this.nodes[nb + N_FLAGS] | 0) | CONCISE;
    if (elementsKind === EK_CONTAINERS && openCount > 1) this.nodes[nb + N_FLAGS] = (this.nodes[nb + N_FLAGS] | 0) | MATRIX;
    // `empty_line_breaks_every_array`: in oxfmt an empty line is a forced line break, between the elements of an array too.
    return ((this.nodes[nb + N_FLAGS] | 0) & MATRIX) !== 0 || ((isConcise || this.cfg.isOxfmt) && (openFlags & OF_BLANK) !== 0);
  }

  /**
   * `quoteProps: "consistent"`: either all names are quoted or none is. Returns the sum of the widths of what is in the
   * object, which was `sum`.
   */
  makeNamesConsistent(t: Uint8Array, object: number, requiresQuotes: boolean, sumIn: number): number {
    let sum = sumIn;
    const end = this.nodes[(object << 3) + N_NEXT] | 0;
    if (requiresQuotes) this.nodes[(object << 3) + N_FLAGS] = (this.nodes[(object << 3) + N_FLAGS] | 0) | QUOTED_NAMES;
    let name = object + 1;
    while (name < end) {
      const b = name << 3;
      const kind = this.nodes[b + N_KIND] | 0;
      const start = this.nodes[b + N_START] | 0;
      const e = this.nodes[b + N_END] | 0;
      const nodeWidth = this.nodes[b + N_WIDTH] | 0;
      const nodeFlags = this.nodes[b + N_FLAGS] | 0;
      let width = nodeWidth;
      let flags = nodeFlags;
      if (kind === K_STRING && !requiresQuotes) {
        width = stringWidth(t, start + 1, e - 1);
        flags = (nodeFlags | UNQUOTED) & ~REWRITTEN;
      } else if (kind === K_IDENTIFIER && requiresQuotes) {
        width = nodeWidth + 2;
        flags = nodeFlags | QUOTED;
      } else if (kind === K_NUMBER && requiresQuotes) {
        if (this.isCanonicalNumberName(t, start, e)) {
          width = nodeWidth + 2;
          flags = nodeFlags | QUOTED;
        }
      }
      if (sum !== MUST_BREAK) {
        const s = sum - nodeWidth;
        sum = satAdd(s < 0 ? 0 : s, width);
      }
      this.nodes[b + N_WIDTH] = width | 0;
      this.nodes[b + N_FLAGS] = flags | 0;
      // Past the value.
      name = name + 1 < this.nodeCount ? this.nodes[((name + 1) << 3) + N_NEXT] | 0 : end;
    }
    return sum;
  }

  // ---------------------------------------------------------------------------------------- scalars

  /** A string at the cursor. Returns its node, or -1. */
  string(t: Uint8Array, quote: number): number {
    const start = this.at | 0;
    // Printable ASCII up to the quote.
    const i = scanString(t, ((start | 0) + 1) | 0, quote);
    if (i < 0) return -1;
    // Nothing but printable ASCII, in the quotes that it is written in: as many columns as bytes.
    if ((t[i] | 0) === quote && quote === this.qb) {
      this.at = ((i | 0) + 1) | 0;
      return this.push(K_STRING, start, ((i | 0) + 1) | 0, ((i | 0) - (start | 0) + 1) | 0, 0);
    }
    return this.stringFrom(t, i, quote);
  }

  /** The string that starts at the cursor, and is nothing but printable ASCII up to `from`. */
  stringFrom(t: Uint8Array, from: number, quote: number): number {
    const n = this.n | 0;
    const start = this.at | 0;
    let at = from | 0;
    // Nothing but printable ASCII: as many columns as bytes.
    let isPlain = true;
    let hasLineBreak = false;
    while (true) {
      if (at >= n) return -1;
      const b = t[at] | 0;
      if (b === quote) break;
      if (b === 92) {
        const len = this.escapeLen(t, at);
        if (len < 0) return -1;
        at = at + len;
        const prev = t[at - 1] | 0;
        if (prev === 10) hasLineBreak = true;
        else if (prev >= 0x80) isPlain = false;
        else if (prev === 13) this.sawCr = true;
        continue;
      }
      if (b === 10) return -1;
      if (b >= 0x20 && b <= 0x7e) {
        const p = scanString(t, ((at | 0) + 1) | 0, quote);
        if (p < 0) return -1;
        at = p;
        continue;
      }
      if (b === 13) this.sawCr = true;
      isPlain = false;
      at = at + 1;
    }
    const end = at + 1;
    this.at = end;
    // content: [start + 1, at)
    let wanted: number;
    if (this.cfg.stringQuote !== QUOTE_NONE) {
      wanted = this.cfg.stringQuote;
    } else {
      // Prettier's `getPreferredQuote`
      const preferred = this.cfg.preferredQuote;
      const pb = preferred === 0 ? 34 : 39;
      const ob = preferred === 0 ? 39 : 34;
      let cp = 0;
      let co = 0;
      for (let i = start + 1; i < at; i++) {
        const c = t[i] | 0;
        if (c === pb) cp = cp + 1;
        else if (c === ob) co = co + 1;
      }
      wanted = cp > co ? 1 - preferred : preferred;
    }
    const wantedByte = wanted === 0 ? 34 : 39;
    let width: number;
    let flags: number;
    if (wantedByte === quote) {
      width = isPlain ? end - start : stringWidth(t, start, end);
      flags = 0;
    } else {
      this.scratch.reset();
      makeString(t, start + 1, at, wantedByte, this.scratch);
      width = stringWidth(this.scratch.data, 0, this.scratch.len);
      flags = REWRITTEN;
    }
    return this.push(K_STRING, start, end, hasLineBreak ? MUST_BREAK : width, flags);
  }

  /** The length of the escape sequence at `at`, where there is a backslash; -1 if it is not one. */
  escapeLen(t: Uint8Array, at: number): number {
    const n = this.n;
    if (at + 1 >= n) return -1;
    const c = t[at + 1] | 0;
    if (c === 120) {
      // x
      if (hexAt(t, n, at + 2, at + 4)) return 4;
      return -1;
    }
    if (c === 117) {
      // u
      if (at + 2 < n && (t[at + 2] | 0) === 123) {
        let p = at + 3;
        let value = 0;
        while (p < n && isHexDigit(t[p] | 0)) {
          value = value * 16 + hexValue(t[p] | 0);
          if (value > 0xffffffff) value = 0xffffffff;
          p = p + 1;
        }
        const digits = p - (at + 3);
        if (digits > 0 && value <= 0x10ffff && p < n && (t[p] | 0) === 125) return digits + 4;
        return -1;
      }
      if (hexAt(t, n, at + 2, at + 6)) return 6;
      return -1;
    }
    if (c >= 0x80) {
      decodeUtf8(t, at + 1, n);
      return 1 + utf8Len();
    }
    return 2;
  }

  /**
   * How many digits there are at `at`, with the `_` between them. A `_` is between two digits. `mode`: 0 decimal, 1 hex,
   * 2 octal, 3 binary. -1 if there is a `_` at the end.
   */
  digits(t: Uint8Array, at: number, mode: number): number {
    const n = this.n;
    let len = 0;
    let previous = 95;
    let i = at;
    while (i < n) {
      const b = t[i] | 0;
      let isDigit: boolean;
      if (mode === 0) isDigit = b >= 48 && b <= 57;
      else if (mode === 1) isDigit = isHexDigit(b);
      else if (mode === 2) isDigit = b >= 48 && b <= 55;
      else isDigit = b === 48 || b === 49;
      if (!isDigit && (b !== 95 || previous === 95)) break;
      previous = b;
      len = len + 1;
      i = i + 1;
    }
    if (len > 0 && previous === 95) return -1;
    return len;
  }

  /** A number at the cursor. Returns its node, or -1. */
  number(t: Uint8Array): number {
    const n = this.n;
    const start = this.at;
    let at = start;
    const c0 = t[at] | 0;
    // The usual ones: 1, 25, 0, 100000, followed by what ends a value.
    if (c0 >= 48 && c0 <= 57) {
      let i = start + 1;
      while (i < n) {
        const b = t[i] | 0;
        if (b < 48 || b > 57) break;
        i = ((i | 0) + 1) | 0;
      }
      const after = i < n ? t[i] | 0 : 44;
      if ((c0 !== 48 || i === start + 1) && (after === 44 || after === 10 || after === 32 || after === 9 || after === 93 || after === 125)) {
        this.at = i;
        return this.push(K_NUMBER, start, i, i - start, 0);
      }
    }
    const c1 = at + 1 < n ? t[at + 1] | 0 : -1;
    let isInteger = false;
    let radix = -1;
    if (c0 === 48) {
      if (c1 === 120 || c1 === 88) radix = 1;
      else if (c1 === 111 || c1 === 79) radix = 2;
      else if (c1 === 98 || c1 === 66) radix = 3;
    }
    if (radix >= 0) {
      const len = this.digits(t, at + 2, radix);
      if (len <= 0) return -1;
      at = at + 2 + len;
    } else {
      const integer = this.digits(t, at, 0);
      if (integer < 0) return -1;
      // After a zero there is no `_`. If there is no 8 and no 9 either, the number is octal, and that is all of it.
      let isOctal = false;
      if (c0 === 48 && integer > 1) {
        let has89 = false;
        for (let i = at + 1; i < at + integer; i++) {
          const b = t[i] | 0;
          if (b === 95) return -1;
          if (b === 56 || b === 57) has89 = true;
        }
        isOctal = !has89;
      }
      at = at + integer;
      isInteger = true;
      let fraction = 0;
      if (at < n && (t[at] | 0) === 46 && !isOctal) {
        isInteger = false;
        fraction = this.digits(t, at + 1, 0);
        if (fraction < 0) return -1;
        at = at + 1 + fraction;
      }
      if (integer + fraction === 0) return -1;
      if (at < n && ((t[at] | 0) === 101 || (t[at] | 0) === 69) && !isOctal) {
        isInteger = false;
        const s = at + 1 < n && ((t[at + 1] | 0) === 43 || (t[at + 1] | 0) === 45) ? 1 : 0;
        const exponent = this.digits(t, at + 1 + s, 0);
        if (exponent <= 0) return -1;
        at = at + 1 + s + exponent;
      }
    }
    // No name, which includes the `n` of a `bigint`, right after a number.
    if (at < n) {
      const b = t[at] | 0;
      if ((b >= 97 && b <= 122) || (b >= 65 && b <= 90) || b === 36 || b === 95 || b === 92) return -1;
      if (b >= 0x80) {
        const cp = decodeUtf8(t, at, n);
        if (isIdentifierStart(cp)) return -1;
      }
    }
    this.at = at;
    if (isInteger || this.cfg.parser === PARSER_STRINGIFY) {
      // `printNumber` leaves digits, with or without `_`, as they are.
      return this.push(K_NUMBER, start, at, at - start, 0);
    }
    const r = trimmedNumber(t, start, at);
    if (r < 0) return this.push(K_NUMBER, start, at, at - start, 0);
    return this.push(K_NUMBER, start, at, r, REWRITTEN);
  }

  /** An identifier at the cursor. Returns its node, or -1. */
  identifier(t: Uint8Array): number {
    const n = this.n;
    const start = this.at;
    let at = start;
    let isAscii = true;
    while (at < n) {
      const b = t[at] | 0;
      if ((b >= 97 && b <= 122) || (b >= 65 && b <= 90) || b === 36 || b === 95) {
        at = at + 1;
      } else if (b >= 48 && b <= 57 && at > start) {
        at = at + 1;
      } else if (b >= 0x80) {
        const c = decodeUtf8(t, at, n);
        const len = utf8Len();
        const isPart = at === start ? isIdentifierStart(c) : isTypeScriptIdentifierPart(c);
        if (!isPart) break;
        isAscii = false;
        at = at + len;
      } else {
        break;
      }
    }
    if (at === start) return -1;
    this.at = at;
    const width = isAscii ? at - start : stringWidth(t, start, at);
    return this.push(K_IDENTIFIER, start, at, width, 0);
  }

  /** A template without substitutions at the cursor. Returns its node, or -1. */
  template(t: Uint8Array): number {
    const n = this.n;
    const start = this.at;
    let at = start + 1;
    while (true) {
      if (at >= n) return -1;
      const c = t[at] | 0;
      if (c === 96) break;
      if (c === 92) {
        at = at + 2;
        continue;
      }
      if (c === 36 && at + 1 < n && (t[at + 1] | 0) === 123) return -1;
      at = at + 1;
    }
    const end = at + 1;
    this.at = end;
    let hasNewline = false;
    for (let i = start; i < end; i++) {
      const c = t[i] | 0;
      if (c === 10) hasNewline = true;
      else if (c === 13) this.sawCr = true;
    }
    const width = hasNewline && this.cfg.parser !== PARSER_STRINGIFY ? MUST_BREAK : stringWidth(t, start, end);
    return this.push(K_TEMPLATE, start, end, width, 0);
  }
}

function matchAt(t: Uint8Array, s: number, lit: string): boolean {
  const n = lit.length;
  for (let i = 0; i < n; i++) if ((t[s + i] | 0) !== lit.charCodeAt(i)) return false;
  return true;
}

function hexAt(t: Uint8Array, n: number, from: number, to: number): boolean {
  if (to > n) return false;
  for (let i = from; i < to; i++) if (!isHexDigit(t[i] | 0)) return false;
  return true;
}

function isHexDigit(b: number): boolean {
  return (b >= 48 && b <= 57) || (b >= 97 && b <= 102) || (b >= 65 && b <= 70);
}

function hexValue(b: number): number {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  return b - 55;
}

/** The tree of this thread. Valid until the next `parse`. */
export const tree = new Tree();
