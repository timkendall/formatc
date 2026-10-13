// Port of vendor/bun/src/format/graphql/printer.rs: the document of a GraphQL text. Prettier's
// `src/language-graphql/printer-graphql.js`, and what `src/main/comments/print.js` does with the comments.
//
// The Rust `Builder` writes to the `Formatter` of the IR; so does this one, imperatively (`f.startGroup(); ..;
// f.endGroup();`). The children of a node that have not been written yet are an index (`c`) into `Tree.children` that each
// piece of code advances: what Rust's `Children` struct does.
import { ByteBuf } from "../../base/bytebuf.ts";
import { encodeUtf8 } from "../../base/utf8.ts";
import { Formatter } from "../ir/formatter.ts";
import { token, twMultiline, twSingle } from "../ir/element.ts";
import { FLAVOR_OXFMT, LINE_ENDING_CR, LINE_ENDING_CRLF, LINE_ENDING_LF } from "../options.ts";
import {
  hasNewlineBackwards,
  isFollowedByEmptyLine,
  isNextLineEmpty,
  isPreviousLineEmpty,
  trimJsWhitespaceEnd,
  trimJsWhitespaceStart,
} from "../text.ts";
import { eqAscii } from "../../base/bytes.ts";
import { Attached, PLACE_DANGLING, PLACE_LEADING, PLACE_TRAILING } from "./comments.ts";
import {
  F_COMMENT,
  HAS_ALIAS,
  IS_BLOCK,
  IS_REPEATABLE,
  IS_SHORTHAND,
  K_ARGUMENT,
  K_BOOLEAN_VALUE,
  K_DIRECTIVE,
  K_DIRECTIVE_DEFINITION,
  K_DIRECTIVE_EXTENSION,
  K_DOCUMENT,
  K_ENUM_TYPE_DEFINITION,
  K_ENUM_TYPE_EXTENSION,
  K_ENUM_VALUE,
  K_ENUM_VALUE_DEFINITION,
  K_FIELD,
  K_FIELD_DEFINITION,
  K_FLOAT_VALUE,
  K_FRAGMENT_ARGUMENT,
  K_FRAGMENT_DEFINITION,
  K_FRAGMENT_SPREAD,
  K_INLINE_FRAGMENT,
  K_INPUT_OBJECT_TYPE_DEFINITION,
  K_INPUT_OBJECT_TYPE_EXTENSION,
  K_INPUT_VALUE_DEFINITION,
  K_INT_VALUE,
  K_INTERFACE_TYPE_DEFINITION,
  K_INTERFACE_TYPE_EXTENSION,
  K_LIST_TYPE,
  K_LIST_VALUE,
  K_NAME,
  K_NAMED_TYPE,
  K_NON_NULL_TYPE,
  K_NULL_VALUE,
  K_OBJECT_FIELD,
  K_OBJECT_TYPE_DEFINITION,
  K_OBJECT_TYPE_EXTENSION,
  K_OBJECT_VALUE,
  K_OPERATION_DEFINITION,
  K_OPERATION_TYPE_DEFINITION,
  K_SCALAR_TYPE_DEFINITION,
  K_SCALAR_TYPE_EXTENSION,
  K_SCHEMA_DEFINITION,
  K_SCHEMA_EXTENSION,
  K_SELECTION_SET,
  K_STRING_VALUE,
  K_UNION_TYPE_DEFINITION,
  K_UNION_TYPE_EXTENSION,
  K_VARIABLE,
  K_VARIABLE_DEFINITION,
  MUTATION,
  SUBSCRIPTION,
  Tree,
  escapeLen,
  isTypeKind,
  isValueKind,
  readEscape,
} from "./parser.ts";

const T_LBRACE = token("{");
const T_RBRACE = token("}");
const T_LBRACE_SP = token("{ ");
const T_LPAREN = token("(");
const T_RPAREN = token(")");
const T_LBRACKET = token("[");
const T_RBRACKET = token("]");
const T_COMMA_SP = token(", ");
const T_SP = token(" ");
const T_COLON_SP = token(": ");
const T_DOLLAR = token("$");
const T_AT = token("@");
const T_BANG = token("!");
const T_SPREAD = token("...");
const T_QUERY = token("query");
const T_MUTATION = token("mutation");
const T_SUBSCRIPTION = token("subscription");
const T_FRAGMENT_SP = token("fragment ");
const T_ON = token(" on ");
const T_EQ = token(" = ");
const T_EXTEND_SP = token("extend ");
const T_TYPE_SP = token("type ");
const T_INPUT_SP = token("input ");
const T_INTERFACE_SP = token("interface ");
const T_IMPLEMENTS = token(" implements ");
const T_AMP = token(" &");
const T_PIPE_SP = token("| ");
const T_SP_PIPE_SP = token(" | ");
const T_DIRECTIVE_AT = token("directive @");
const T_REPEATABLE = token(" repeatable");
const T_SCALAR_SP = token("scalar ");
const T_ENUM_SP = token("enum ");
const T_UNION_SP = token("union ");
const T_SP_EQ = token(" =");
const T_EXTEND_SCHEMA = token("extend schema");
const T_SCHEMA = token("schema");
const T_TRIPLE_QUOTE = token("\"\"\"");

// Line starts and ends of the lines of a block string.
let lineS = new Int32Array(64);
let lineE = new Int32Array(64);

function isBlank(b: number): boolean {
  return b === 32 || b === 9;
}

/** Rust `trim_ascii` bounds: space, `\t`, `\n`, form feed, `\r`. */
function isAsciiWhitespace(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
}

// `print` is a smaller door than the ones of the JavaScript formatter that `Stack`'s limit is counted in: about 600 bytes
// (measured, scriptc, 8 MiB: 13,000 doors overflow, 12,000 do not).
let printerDoors = 8000;

/** For tests: how many nested doors the printer allows. */
export function setPrinterDoors(n: number): void {
  printerDoors = n;
}

/** Writes the elements of a document. One per thread, set up for each text. */
export class Builder {
  f: Formatter;
  /** The text that `tree` is of. */
  text: Uint8Array;
  /** Where `text` starts in `f.source` if it is a part of it, else -1. */
  srcOff: number;
  tree: Tree;
  att: Attached;
  /** The document is for a template literal of JavaScript, in which `\`, `` ` `` and `${` have to be escaped. */
  isInTemplate: boolean;
  /** The line ending of the output (`LINE_ENDING_*`, resolved). */
  lineEnding: number;
  /** Scratch for texts that are built. */
  esc: ByteBuf;
  val: ByteBuf;
  // Token handles: a field of the builder is cheaper to read than a module-level constant in a program that has workers.
  T_LBRACE: number;
  T_RBRACE: number;
  T_LBRACE_SP: number;
  T_LPAREN: number;
  T_RPAREN: number;
  T_LBRACKET: number;
  T_RBRACKET: number;
  T_COMMA_SP: number;
  T_SP: number;
  T_COLON_SP: number;
  T_DOLLAR: number;
  T_AT: number;
  T_BANG: number;
  T_SPREAD: number;
  T_QUERY: number;
  T_MUTATION: number;
  T_SUBSCRIPTION: number;
  T_FRAGMENT_SP: number;
  T_ON: number;
  T_EQ: number;
  T_EXTEND_SP: number;
  T_TYPE_SP: number;
  T_INPUT_SP: number;
  T_INTERFACE_SP: number;
  T_IMPLEMENTS: number;
  T_AMP: number;
  T_PIPE_SP: number;
  T_SP_PIPE_SP: number;
  T_DIRECTIVE_AT: number;
  T_REPEATABLE: number;
  T_SCALAR_SP: number;
  T_ENUM_SP: number;
  T_UNION_SP: number;
  T_SP_EQ: number;
  T_EXTEND_SCHEMA: number;
  T_SCHEMA: number;
  T_TRIPLE_QUOTE: number;
  // The tree, as arrays (a field of the builder, not of the tree: one load less).
  nodes: Int32Array;
  childA: Int32Array;
  // How deep `print` is, and how deep it may be.
  depth: number;
  limit: number;
  // The attached comments of the last `commentsOf`.
  cLo: number;
  cHi: number;

  constructor(f: Formatter, text: Uint8Array, tree: Tree, att: Attached) {
    this.f = f;
    this.text = text;
    this.srcOff = -1;
    this.tree = tree;
    this.att = att;
    this.isInTemplate = false;
    this.lineEnding = LINE_ENDING_LF;
    this.esc = new ByteBuf(256);
    this.val = new ByteBuf(256);
    this.cLo = 0;
    this.cHi = 0;
    this.T_LBRACE = T_LBRACE;
    this.T_RBRACE = T_RBRACE;
    this.T_LBRACE_SP = T_LBRACE_SP;
    this.T_LPAREN = T_LPAREN;
    this.T_RPAREN = T_RPAREN;
    this.T_LBRACKET = T_LBRACKET;
    this.T_RBRACKET = T_RBRACKET;
    this.T_COMMA_SP = T_COMMA_SP;
    this.T_SP = T_SP;
    this.T_COLON_SP = T_COLON_SP;
    this.T_DOLLAR = T_DOLLAR;
    this.T_AT = T_AT;
    this.T_BANG = T_BANG;
    this.T_SPREAD = T_SPREAD;
    this.T_QUERY = T_QUERY;
    this.T_MUTATION = T_MUTATION;
    this.T_SUBSCRIPTION = T_SUBSCRIPTION;
    this.T_FRAGMENT_SP = T_FRAGMENT_SP;
    this.T_ON = T_ON;
    this.T_EQ = T_EQ;
    this.T_EXTEND_SP = T_EXTEND_SP;
    this.T_TYPE_SP = T_TYPE_SP;
    this.T_INPUT_SP = T_INPUT_SP;
    this.T_INTERFACE_SP = T_INTERFACE_SP;
    this.T_IMPLEMENTS = T_IMPLEMENTS;
    this.T_AMP = T_AMP;
    this.T_PIPE_SP = T_PIPE_SP;
    this.T_SP_PIPE_SP = T_SP_PIPE_SP;
    this.T_DIRECTIVE_AT = T_DIRECTIVE_AT;
    this.T_REPEATABLE = T_REPEATABLE;
    this.T_SCALAR_SP = T_SCALAR_SP;
    this.T_ENUM_SP = T_ENUM_SP;
    this.T_UNION_SP = T_UNION_SP;
    this.T_SP_EQ = T_SP_EQ;
    this.T_EXTEND_SCHEMA = T_EXTEND_SCHEMA;
    this.T_SCHEMA = T_SCHEMA;
    this.T_TRIPLE_QUOTE = T_TRIPLE_QUOTE;
    this.nodes = tree.nodes;
    this.childA = tree.children;
    this.depth = 0;
    this.limit = 1000;
  }

  /** For the next text. */
  setUp(f: Formatter, text: Uint8Array, srcOff: number, tree: Tree, att: Attached, isInTemplate: boolean, lineEnding: number): void {
    this.f = f;
    this.text = text;
    this.srcOff = srcOff;
    this.tree = tree;
    this.att = att;
    this.isInTemplate = isInTemplate;
    this.lineEnding = lineEnding;
    this.nodes = tree.nodes;
    this.childA = tree.children;
    this.depth = 0;
    this.limit = printerDoors - f.stack.depth * 8;
  }

  // ───────────────────────────── text ─────────────────────────────

  needsEscapes(bytes: Uint8Array, a: number, b: number): boolean {
    for (let i = a; i < b; i++) {
      const c = bytes[i] | 0;
      if (c === 92 || c === 96) return true;
      if (c === 36 && i + 1 < b && (bytes[i + 1] | 0) === 123) return true;
    }
    return false;
  }

  /** Prettier's `uncookTemplateElementValue` */
  escapeForTemplate(bytes: Uint8Array, a: number, b: number, out: ByteBuf): void {
    for (let i = a; i < b; i++) {
      const c = bytes[i] | 0;
      if (c === 92 || c === 96 || (c === 36 && i + 1 < b && (bytes[i + 1] | 0) === 123)) out.push(92);
      out.push(c);
    }
  }

  /** `bytes[a, b)`, which is on one line. It is not copied if it is a part of the source text (`inSource`). */
  emitText(bytes: Uint8Array, a: number, b: number, inSource: boolean): void {
    const f = this.f;
    if (this.isInTemplate && this.needsEscapes(bytes, a, b)) {
      const esc = this.esc;
      esc.reset();
      this.escapeForTemplate(bytes, a, b, esc);
      f.textBytesWithWidth(esc.data, 0, esc.len, twSingle(f.stringWidth(esc.data, 0, esc.len)));
      return;
    }
    const w = twSingle(f.stringWidth(bytes, a, b));
    if (inSource && this.srcOff >= 0) f.textSourceWithWidth(this.srcOff + a, this.srcOff + b, w);
    else f.textBytesWithWidth(bytes, a, b, w);
  }

  /** The part of the text at `[a, b)`, which is on one line. */
  source(a: number, b: number): void {
    this.emitText(this.text, a, b, true);
  }

  /**
   * A name, a number, an enum value: ASCII without a tab or a line break, so it is as wide as it is long and nothing in it
   * needs escaping. Written as `sourceText` writes it, without asking which blocks of the source are plain (that would need
   * `startDocument` to look at every byte of the source).
   */
  nameText(a: number, b: number): void {
    const off = this.srcOff;
    if (off >= 0) this.f.textSourceWithWidth(off + a, off + b, twSingle(b - a));
    else this.f.textBytesWithWidth(this.text, a, b, twSingle(b - a));
  }

  // ───────────────────────────── comments ─────────────────────────────

  /** The attached comments of `id` are `att[cLo, cHi)`. */
  commentsOf(id: number): void {
    const att = this.att;
    const n = att.count;
    if (n === 0) {
      this.cLo = 0;
      this.cHi = 0;
      return;
    }
    const nodes = att.node;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = lo + ((hi - lo) >> 1);
      if ((nodes[mid] | 0) < id) lo = mid + 1;
      else hi = mid;
    }
    let e = lo;
    while (e < n && (nodes[e] | 0) === id) e = e + 1;
    this.cLo = lo;
    this.cHi = e;
  }

  /** Prettier's `printComment` of comment `index`. */
  comment(index: number): void {
    const tree = this.tree;
    const s = tree.cStart[index] | 0;
    let e = tree.cEnd[index] | 0;
    const text = this.text;
    while (e > s && isAsciiWhitespace(text[e - 1] | 0)) e = e - 1;
    this.source(s, e);
  }

  /** Prettier's `printLeadingComment` */
  leadingComment(index: number): void {
    this.comment(index);
    // An empty line after it is kept.
    if (isFollowedByEmptyLine(this.text, this.tree.cEnd[index] | 0)) this.f.emptyLine();
    else this.f.hardLineBreak();
  }

  /** Prettier's `printTrailingComments` */
  trailingComments(lo: number, hi: number): void {
    const f = this.f;
    const att = this.att;
    let isAfterLineSuffix = false;
    for (let i = lo; i < hi; i++) {
      if ((att.place[i] | 0) !== PLACE_TRAILING) continue;
      const index = att.comment[i] | 0;
      const start = this.tree.cStart[index] | 0;
      f.startLineSuffix();
      const isOnOwnLine = isAfterLineSuffix || hasNewlineBackwards(this.text, start);
      if (isOnOwnLine) {
        if (isPreviousLineEmpty(this.text, start)) f.emptyLine();
        else f.hardLineBreak();
      } else {
        f.space();
      }
      this.comment(index);
      f.endLineSuffix();
      if (!isOnOwnLine) f.expandParent();
      isAfterLineSuffix = true;
    }
  }

  /** Prettier's `printDanglingComments` with `indent: true` */
  danglingComments(id: number): void {
    this.commentsOf(id);
    const lo = this.cLo;
    const hi = this.cHi;
    const att = this.att;
    let any = false;
    for (let i = lo; i < hi; i++) {
      if ((att.place[i] | 0) === PLACE_DANGLING) {
        any = true;
        break;
      }
    }
    if (!any) return;
    const f = this.f;
    f.startIndent();
    for (let i = lo; i < hi; i++) {
      if ((att.place[i] | 0) !== PLACE_DANGLING) continue;
      f.hardLineBreak();
      this.comment(att.comment[i] | 0);
    }
    f.endIndent();
  }

  /** Whether the comment `index` says that what follows stays as it is written. */
  isIgnoreComment(index: number): boolean {
    const tree = this.tree;
    let s = ((tree.cStart[index] | 0) + 1) | 0;
    let e = tree.cEnd[index] | 0;
    const text = this.text;
    while (s < e && isAsciiWhitespace(text[s] | 0)) s = s + 1;
    while (e > s && isAsciiWhitespace(text[e - 1] | 0)) e = e - 1;
    const len = e - s;
    if (len === 15 && eqAscii(text, s, "prettier-ignore")) return true;
    return len === 12 && this.f.flavor === FLAVOR_OXFMT && eqAscii(text, s, "oxfmt-ignore");
  }

  /**
   * What has a `prettier-ignore` comment, as it is in the text. For Prettier that is a string like any other: its line
   * breaks do not break the groups around it, and all of it counts as being on the line.
   */
  ignored(a: number, b: number): void {
    const f = this.f;
    const text = this.text;
    const width = twSingle(f.stringWidth(text, a, b));
    const needsEscapes = this.isInTemplate && this.needsEscapes(text, a, b);
    const lineEnding = this.lineEnding;
    let hasCr = false;
    for (let i = a; i < b; i++) {
      if ((text[i] | 0) === 13) {
        hasCr = true;
        break;
      }
    }
    if (!needsEscapes && lineEnding === LINE_ENDING_LF && !hasCr) {
      if (this.srcOff >= 0) f.textSourceWithWidth(this.srcOff + a, this.srcOff + b, width);
      else f.textBytesWithWidth(text, a, b, width);
      return;
    }
    const written = this.val;
    written.reset();
    let lineStart = a;
    let first = true;
    while (true) {
      let lineEnd = lineStart;
      while (lineEnd < b && (text[lineEnd] | 0) !== 10) lineEnd = lineEnd + 1;
      if (!first) {
        if (lineEnding === LINE_ENDING_CRLF) {
          written.push(13);
          written.push(10);
        } else if (lineEnding === LINE_ENDING_CR) {
          written.push(13);
        } else {
          written.push(10);
        }
      }
      first = false;
      let le = lineEnd;
      if (le > lineStart && (text[le - 1] | 0) === 13) le = le - 1;
      if (needsEscapes) this.escapeForTemplate(text, lineStart, le, written);
      else written.append(text, lineStart, le);
      if (lineEnd >= b) break;
      lineStart = lineEnd + 1;
    }
    f.textBytesWithWidth(written.data, 0, written.len, width);
  }

  // ───────────────────────────── nodes ─────────────────────────────

  /** A node with its comments. */
  print(id: number): void {
    const d = this.depth;
    if (d >= this.limit) {
      // Out of room: nothing is written, `f.stack.ranOut()` is true from now on.
      this.f.stack.hasRoomAt(this.f.stack.limit);
      return;
    }
    this.depth = d + 1;
    if (((this.nodes[id << 3] | 0) & (F_COMMENT << 8)) === 0) this.printNode(id);
    else this.printWithComments(id);
    this.depth = d;
  }

  /** A node that is a name, with its comments. */
  printName(id: number): void {
    if (((this.nodes[id << 3] | 0) & (F_COMMENT << 8)) === 0) this.nameText(this.nodes[(id << 3) + 1] | 0, this.nodes[(id << 3) + 2] | 0);
    else this.print(id);
  }

  printWithComments(id: number): void {
    this.commentsOf(id);
    const lo = this.cLo;
    const hi = this.cHi;
    if (lo === hi) {
      this.printNode(id);
      return;
    }
    const att = this.att;
    for (let i = lo; i < hi; i++) {
      if ((att.place[i] | 0) === PLACE_LEADING) this.leadingComment(att.comment[i] | 0);
    }
    let isIgnored = false;
    for (let i = lo; i < hi; i++) {
      if (this.isIgnoreComment(att.comment[i] | 0)) {
        isIgnored = true;
        break;
      }
    }
    if (isIgnored) this.ignored(this.nodes[(id << 3) + 1] | 0, this.nodes[(id << 3) + 2] | 0);
    else this.printNode(id);
    this.trailingComments(lo, hi);
  }

  /** The document without the line break at its end: what Prettier's `textToDoc` returns. */
  printDefinitions(): void {
    const tree = this.tree;
    const root = tree.root();
    const c = this.nodes[(root << 3) + 3] | 0;
    this.sequence(c, (c + (this.nodes[(root << 3) + 4] | 0)) | 0);
  }

  /** Prettier's `printGraphqlComments`: the text is nothing but comments and white space. */
  printCommentLines(): void {
    const f = this.f;
    const text = this.text;
    const n = text.length;
    let hasComment = false;
    let isAfterBlankLine = false;
    let lineStart = 0;
    while (true) {
      let lineEnd = lineStart;
      while (lineEnd < n && (text[lineEnd] | 0) !== 10) lineEnd = lineEnd + 1;
      const cs = trimJsWhitespaceStart(text, lineStart, lineEnd);
      const ce = trimJsWhitespaceEnd(text, cs, lineEnd);
      const isEmpty = ce <= cs;
      if (!isEmpty) {
        if (hasComment) {
          if (isAfterBlankLine) f.emptyLine();
          else f.hardLineBreak();
        }
        hasComment = true;
        this.source(cs, ce);
      }
      isAfterBlankLine = isEmpty;
      if (lineEnd >= n) break;
      lineStart = lineEnd + 1;
    }
  }

  kindAt(c: number): number {
    return (this.nodes[(this.childA[c] | 0) << 3] | 0) & 255;
  }

  /** Prettier's `printSequence`, joined by line breaks: an empty line after a node is kept. */
  sequence(c0: number, c1: number): void {
    const f = this.f;
    for (let i = c0; i < c1; i++) {
      const id = this.childA[i] | 0;
      this.print(id);
      if (i + 1 < c1) {
        if (isNextLineEmpty(this.text, this.nodes[(id << 3) + 2] | 0)) f.emptyLine();
        else f.hardLineBreak();
      }
    }
  }

  /** `{`, the nodes on lines of their own, `}` */
  block(c0: number, c1: number): void {
    const f = this.f;
    f.token(this.T_LBRACE);
    f.startIndent();
    f.hardLineBreak();
    this.sequence(c0, c1);
    f.endIndent();
    f.hardLineBreak();
    f.token(this.T_RBRACE);
  }

  /** `(a, b)`, or each on its own line without the commas. `keepsEmptyLines`: Prettier's `printSequence`. */
  parenthesized(c0: number, c1: number, keepsEmptyLines: boolean): void {
    if (c0 >= c1) return;
    const f = this.f;
    f.startGroup();
    f.token(this.T_LPAREN);
    f.startIndent();
    f.softLineBreak();
    this.list(c0, c1, keepsEmptyLines);
    f.endIndent();
    f.softLineBreak();
    f.token(this.T_RPAREN);
    f.endGroup();
  }

  /** `a, b`, or each on its own line. */
  list(c0: number, c1: number, keepsEmptyLines: boolean): void {
    const tree = this.tree;
    const f = this.f;
    for (let i = c0; i < c1; i++) {
      const id = this.childA[i] | 0;
      this.print(id);
      if (i + 1 === c1) break;
      // That empty line is a forced line break.
      if (keepsEmptyLines && isNextLineEmpty(this.text, this.nodes[(id << 3) + 2] | 0)) {
        f.emptyLine();
      } else {
        f.startIfGroupFits();
        f.token(this.T_COMMA_SP);
        f.endConditional();
        f.softLineBreak();
      }
    }
  }

  /** Prettier's `printDescription`. Returns the next child. */
  description(c: number, cend: number, owner: number): number {
    if (c >= cend || this.kindAt(c) !== K_STRING_VALUE) return c;
    const id = this.childA[c] | 0;
    this.print(id);
    const isBlock = (((this.nodes[id << 3] | 0) >> 8) & IS_BLOCK) !== 0;
    if (owner === K_INPUT_VALUE_DEFINITION && !isBlock) this.f.softLineBreakOrSpace();
    else this.f.hardLineBreak();
    return c + 1;
  }

  /** Prettier's `printDirectives`. Returns the next child. */
  directives(c0: number, cend: number, owner: number): number {
    let c = c0;
    while (c < cend && this.kindAt(c) === K_DIRECTIVE) c = c + 1;
    if (c === c0) return c0;
    const f = this.f;
    if (owner === K_FRAGMENT_DEFINITION || owner === K_OPERATION_DEFINITION) {
      f.startGroup();
      f.softLineBreakOrSpace();
      for (let i = c0; i < c; i++) {
        if (i > c0) f.softLineBreakOrSpace();
        this.print(this.childA[i] | 0);
      }
      f.endGroup();
      return c;
    }
    f.token(this.T_SP);
    f.startGroup();
    f.startIndent();
    f.softLineBreak();
    for (let i = c0; i < c; i++) {
      if (i > c0) f.softLineBreakOrSpace();
      this.print(this.childA[i] | 0);
    }
    f.endIndent();
    f.endGroup();
    return c;
  }

  operation(flags: number): void {
    if (flags === MUTATION) this.f.token(this.T_MUTATION);
    else if (flags === SUBSCRIPTION) this.f.token(this.T_SUBSCRIPTION);
    else this.f.token(this.T_QUERY);
  }

  stringValue(a: number, b: number, isBlock: boolean): void {
    const text = this.text;
    if (isBlock) {
      if (b - a >= 6) this.blockString(a + 3, b - 3);
      else this.blockString(a, a);
      return;
    }
    // Without escapes, it is written as it is.
    let hasBackslash = false;
    for (let i = a; i < b; i++) {
      if ((text[i] | 0) === 92) {
        hasBackslash = true;
        break;
      }
    }
    if (!hasBackslash) {
      this.source(a, b);
      return;
    }
    // Of the characters that the escapes stand for, only three are escaped again.
    const value = this.val;
    value.reset();
    value.push(34);
    const end = b - 1;
    let pos = a + 1;
    while (true) {
      let at = pos;
      while (at < end && (text[at] | 0) !== 92) at = at + 1;
      value.append(text, pos, at);
      if (at >= end) break;
      let cp = readEscape(text, at, end);
      let len = 0;
      if (cp < 0) {
        cp = 92;
        len = 1;
      } else {
        len = escapeLen();
      }
      if (cp === 34) {
        value.push(92);
        value.push(34);
      } else if (cp === 92) {
        value.push(92);
        value.push(92);
      } else if (cp === 10) {
        value.push(92);
        value.push(110);
      } else {
        encodeUtf8(value, cp);
      }
      pos = at + len;
    }
    value.push(34);
    this.emitText(value.data, 0, value.len, false);
  }

  /** Splits `text[a, b)` into the lines graphql-js sees: `\r\n`, `\n`, `\r`. Returns how many; they are in `lineS`/`lineE`. */
  splitLines(a: number, b: number): number {
    const text = this.text;
    let n = 0;
    let start = a;
    let i = a;
    while (true) {
      while (i < b) {
        const c = text[i] | 0;
        if (c === 10 || c === 13) break;
        i = i + 1;
      }
      if (n === lineS.length) {
        const s = new Int32Array(n * 2);
        s.set(lineS);
        lineS = s;
        const e = new Int32Array(n * 2);
        e.set(lineE);
        lineE = e;
      }
      lineS[n] = start | 0;
      lineE[n] = i | 0;
      n = n + 1;
      if (i >= b) break;
      if ((text[i] | 0) === 13 && i + 1 < b && (text[i + 1] | 0) === 10) i = i + 2;
      else i = i + 1;
      start = i;
    }
    return n;
  }

  /** `a..b`: what is between the `"""`. */
  blockString(a: number, b: number): void {
    const text = this.text;
    const f = this.f;
    // graphql-js's `dedentBlockStringLines`
    const n = this.splitLines(a, b);
    const ls = lineS;
    const le = lineE;
    let commonIndent = 2147483647;
    let first = -1;
    let last = -1;
    for (let i = 0; i < n; i++) {
      const s = ls[i] | 0;
      const e = le[i] | 0;
      let k = s;
      while (k < e && isBlank(text[k] | 0)) k = k + 1;
      const blank = k === e;
      if (!blank) {
        if (first < 0) first = i;
        last = i;
        if (i > 0) {
          const indent = k - s;
          if (indent < commonIndent) commonIndent = indent;
        }
      }
    }
    let count = 0;
    if (last >= 0) count = last + 1 - first;
    if (first < 0) first = 0;

    f.token(this.T_TRIPLE_QUOTE);
    let emptyLines = 0;
    for (let i = first; i < first + count; i++) {
      let s = ls[i] | 0;
      let e = le[i] | 0;
      if (i > 0) {
        const len = e - s;
        s = s + (commonIndent < len ? commonIndent : len);
      }
      // The printer of Prettier leaves out the blanks at the end of a line.
      while (e > s && isBlank(text[e - 1] | 0)) e = e - 1;
      if (count === 1) {
        while (s < e && isAsciiWhitespace(text[s] | 0)) s = s + 1;
        while (e > s && isAsciiWhitespace(text[e - 1] | 0)) e = e - 1;
      }
      if (e === s) {
        emptyLines = emptyLines + 1;
        continue;
      }
      this.lineBreaks(emptyLines);
      emptyLines = 0;
      this.emitText(text, s, e, true);
    }
    f.hardLineBreak();
    f.token(this.T_TRIPLE_QUOTE);
  }

  /** A line break after so many empty lines. */
  lineBreaks(emptyLines: number): void {
    const f = this.f;
    if (emptyLines === 1) {
      f.emptyLine();
      return;
    }
    if (emptyLines >= 2) {
      // The printer writes no more than one empty line for line breaks.
      const v = this.val;
      v.reset();
      v.fill(10, emptyLines + 1);
      f.textBytesWithWidth(v.data, 0, v.len, twMultiline(0));
    }
    f.hardLineBreak();
  }

  /** A node without its comments: Prettier's `genericPrint`. */
  printNode(id: number): void {
    const tree = this.tree;
    const f = this.f;
    const nodes = this.nodes;
    const kf = nodes[id << 3] | 0;
    const kind = kf & 255;
    const flags = (kf >> 8) & 127;
    let c = nodes[(id << 3) + 3] | 0;
    const cend = (c + (nodes[(id << 3) + 4] | 0)) | 0;
    switch (kind) {
      case K_DOCUMENT:
        this.sequence(c, cend);
        f.hardLineBreak();
        break;
      case K_OPERATION_DEFINITION: {
        c = this.description(c, cend, kind);
        const hasOperation = flags !== IS_SHORTHAND;
        let name = -1;
        if (c < cend && this.kindAt(c) === K_NAME) {
          name = this.childA[c] | 0;
          c = c + 1;
        }
        const v0 = c;
        while (c < cend && this.kindAt(c) === K_VARIABLE_DEFINITION) c = c + 1;
        if (hasOperation) {
          this.operation(flags);
          if (name >= 0 || c > v0) f.token(this.T_SP);
          if (name >= 0) this.printName(name);
        }
        this.parenthesized(v0, c, false);
        c = this.directives(c, cend, kind);
        if (hasOperation) f.token(this.T_SP);
        if (c < cend && this.kindAt(c) === K_SELECTION_SET) this.print(this.childA[c] | 0);
        break;
      }
      case K_FRAGMENT_DEFINITION: {
        c = this.description(c, cend, kind);
        f.token(this.T_FRAGMENT_SP);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        const v0 = c;
        while (c < cend && this.kindAt(c) === K_VARIABLE_DEFINITION) c = c + 1;
        this.parenthesized(v0, c, false);
        f.token(this.T_ON);
        if (c < cend && this.kindAt(c) === K_NAMED_TYPE) {
          this.print(this.childA[c] | 0);
          c = c + 1;
        }
        c = this.directives(c, cend, kind);
        f.token(this.T_SP);
        if (c < cend && this.kindAt(c) === K_SELECTION_SET) this.print(this.childA[c] | 0);
        break;
      }
      case K_SELECTION_SET:
        this.block(c, cend);
        break;
      case K_FIELD: {
        // A field that is no more than a name (and an alias) has nothing in it that a group would decide.
        const isPlain = cend - c <= ((flags & HAS_ALIAS) !== 0 ? 2 : 1);
        if (!isPlain) f.startGroup();
        if ((flags & HAS_ALIAS) !== 0) {
          if (c < cend && this.kindAt(c) === K_NAME) {
            this.printName(this.childA[c] | 0);
            c = c + 1;
          }
          f.token(this.T_COLON_SP);
        }
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        const a0 = c;
        while (c < cend && this.kindAt(c) === K_ARGUMENT) c = c + 1;
        this.parenthesized(a0, c, true);
        c = this.directives(c, cend, kind);
        if (c < cend && this.kindAt(c) === K_SELECTION_SET) {
          f.token(this.T_SP);
          this.print(this.childA[c] | 0);
        }
        if (!isPlain) f.endGroup();
        break;
      }
      case K_NAME:
      case K_INT_VALUE:
      case K_FLOAT_VALUE:
      case K_ENUM_VALUE:
      case K_BOOLEAN_VALUE:
      case K_NULL_VALUE:
        this.nameText(nodes[(id << 3) + 1] | 0, nodes[(id << 3) + 2] | 0);
        break;
      case K_STRING_VALUE:
        this.stringValue(nodes[(id << 3) + 1] | 0, nodes[(id << 3) + 2] | 0, (flags & IS_BLOCK) !== 0);
        break;
      case K_VARIABLE:
        f.token(this.T_DOLLAR);
        if (c < cend && this.kindAt(c) === K_NAME) this.printName(this.childA[c] | 0);
        break;
      case K_LIST_VALUE:
        f.startGroup();
        f.token(this.T_LBRACKET);
        this.danglingComments(id);
        if (c < cend) {
          f.startIndent();
          f.softLineBreak();
          this.list(c, cend, false);
          f.endIndent();
        }
        f.softLineBreak();
        f.token(this.T_RBRACKET);
        f.endGroup();
        break;
      case K_OBJECT_VALUE: {
        f.startGroup();
        const hasSpace = f.options.bracketSpacing && c < cend;
        f.token(hasSpace ? this.T_LBRACE_SP : this.T_LBRACE);
        this.danglingComments(id);
        if (c < cend) {
          f.startIndent();
          f.softLineBreak();
          this.list(c, cend, false);
          f.endIndent();
        }
        f.softLineBreak();
        if (hasSpace) {
          f.startIfGroupFits();
          f.token(this.T_SP);
          f.endConditional();
        }
        f.token(this.T_RBRACE);
        f.endGroup();
        break;
      }
      case K_OBJECT_FIELD:
      case K_ARGUMENT:
      case K_FRAGMENT_ARGUMENT:
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        f.token(this.T_COLON_SP);
        if (c < cend && isValueKind(this.kindAt(c))) this.print(this.childA[c] | 0);
        break;
      case K_DIRECTIVE: {
        f.token(this.T_AT);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        const a0 = c;
        while (c < cend && this.kindAt(c) === K_ARGUMENT) c = c + 1;
        this.parenthesized(a0, c, true);
        break;
      }
      case K_NAMED_TYPE:
        if (c < cend && this.kindAt(c) === K_NAME) this.printName(this.childA[c] | 0);
        break;
      case K_VARIABLE_DEFINITION:
      case K_INPUT_VALUE_DEFINITION:
        c = this.description(c, cend, kind);
        if (c < cend) {
          const k = this.kindAt(c);
          if (k === K_VARIABLE || k === K_NAME) {
            this.print(this.childA[c] | 0);
            c = c + 1;
          }
        }
        f.token(this.T_COLON_SP);
        if (c < cend && isTypeKind(this.kindAt(c))) {
          this.print(this.childA[c] | 0);
          c = c + 1;
        }
        if (c < cend && isValueKind(this.kindAt(c))) {
          f.token(this.T_EQ);
          this.print(this.childA[c] | 0);
          c = c + 1;
        }
        c = this.directives(c, cend, kind);
        break;
      case K_OBJECT_TYPE_EXTENSION:
      case K_OBJECT_TYPE_DEFINITION:
      case K_INPUT_OBJECT_TYPE_EXTENSION:
      case K_INPUT_OBJECT_TYPE_DEFINITION:
      case K_INTERFACE_TYPE_EXTENSION:
      case K_INTERFACE_TYPE_DEFINITION: {
        if (kind === K_OBJECT_TYPE_DEFINITION || kind === K_INPUT_OBJECT_TYPE_DEFINITION || kind === K_INTERFACE_TYPE_DEFINITION) {
          c = this.description(c, cend, kind);
        } else {
          f.token(this.T_EXTEND_SP);
        }
        if (kind === K_OBJECT_TYPE_DEFINITION || kind === K_OBJECT_TYPE_EXTENSION) f.token(this.T_TYPE_SP);
        else if (kind === K_INPUT_OBJECT_TYPE_DEFINITION || kind === K_INPUT_OBJECT_TYPE_EXTENSION) f.token(this.T_INPUT_SP);
        else f.token(this.T_INTERFACE_SP);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        const i0 = c;
        while (c < cend && this.kindAt(c) === K_NAMED_TYPE) c = c + 1;
        if (c > i0) {
          f.token(this.T_IMPLEMENTS);
          f.startIndent();
          f.startGroup();
          for (let i = i0; i < c; i++) {
            if (i > i0) {
              f.token(this.T_AMP);
              f.softLineBreakOrSpace();
            }
            this.print(this.childA[i] | 0);
          }
          f.endGroup();
          f.endIndent();
        }
        c = this.directives(c, cend, kind);
        if (c < cend) {
          f.token(this.T_SP);
          this.block(c, cend);
        }
        break;
      }
      case K_FIELD_DEFINITION: {
        c = this.description(c, cend, kind);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        const a0 = c;
        while (c < cend && this.kindAt(c) === K_INPUT_VALUE_DEFINITION) c = c + 1;
        this.parenthesized(a0, c, true);
        f.token(this.T_COLON_SP);
        if (c < cend && isTypeKind(this.kindAt(c))) {
          this.print(this.childA[c] | 0);
          c = c + 1;
        }
        c = this.directives(c, cend, kind);
        break;
      }
      case K_DIRECTIVE_DEFINITION: {
        c = this.description(c, cend, kind);
        f.token(this.T_DIRECTIVE_AT);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        const a0 = c;
        while (c < cend && this.kindAt(c) === K_INPUT_VALUE_DEFINITION) c = c + 1;
        this.parenthesized(a0, c, true);
        c = this.directives(c, cend, kind);
        if ((flags & IS_REPEATABLE) !== 0) f.token(this.T_REPEATABLE);
        f.token(this.T_ON);
        for (let i = c; i < cend; i++) {
          if (i > c) f.token(this.T_SP_PIPE_SP);
          this.print(this.childA[i] | 0);
        }
        break;
      }
      case K_DIRECTIVE_EXTENSION:
        f.token(this.T_EXTEND_SP);
        f.token(this.T_DIRECTIVE_AT);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        c = this.directives(c, cend, kind);
        break;
      case K_ENUM_TYPE_EXTENSION:
      case K_ENUM_TYPE_DEFINITION:
        c = this.description(c, cend, kind);
        if (kind === K_ENUM_TYPE_EXTENSION) f.token(this.T_EXTEND_SP);
        f.token(this.T_ENUM_SP);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        c = this.directives(c, cend, kind);
        if (c < cend) {
          f.token(this.T_SP);
          this.block(c, cend);
        }
        break;
      case K_ENUM_VALUE_DEFINITION:
        c = this.description(c, cend, kind);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        c = this.directives(c, cend, kind);
        break;
      case K_SCHEMA_EXTENSION:
      case K_SCHEMA_DEFINITION:
        c = this.description(c, cend, kind);
        f.token(kind === K_SCHEMA_EXTENSION ? this.T_EXTEND_SCHEMA : this.T_SCHEMA);
        c = this.directives(c, cend, kind);
        if (c < cend) {
          f.token(this.T_SP);
          this.block(c, cend);
        }
        break;
      case K_OPERATION_TYPE_DEFINITION:
        this.operation(flags);
        f.token(this.T_COLON_SP);
        if (c < cend && this.kindAt(c) === K_NAMED_TYPE) this.print(this.childA[c] | 0);
        break;
      case K_FRAGMENT_SPREAD: {
        f.token(this.T_SPREAD);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        const a0 = c;
        while (c < cend && this.kindAt(c) === K_FRAGMENT_ARGUMENT) c = c + 1;
        this.parenthesized(a0, c, true);
        c = this.directives(c, cend, kind);
        break;
      }
      case K_INLINE_FRAGMENT:
        f.token(this.T_SPREAD);
        if (c < cend && this.kindAt(c) === K_NAMED_TYPE) {
          f.token(this.T_ON);
          this.print(this.childA[c] | 0);
          c = c + 1;
        }
        c = this.directives(c, cend, kind);
        f.token(this.T_SP);
        if (c < cend && this.kindAt(c) === K_SELECTION_SET) this.print(this.childA[c] | 0);
        break;
      case K_UNION_TYPE_EXTENSION:
      case K_UNION_TYPE_DEFINITION:
        f.startGroup();
        c = this.description(c, cend, kind);
        f.startGroup();
        if (kind === K_UNION_TYPE_EXTENSION) f.token(this.T_EXTEND_SP);
        f.token(this.T_UNION_SP);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        c = this.directives(c, cend, kind);
        if (c < cend) {
          f.token(this.T_SP_EQ);
          f.startIfGroupFits();
          f.token(this.T_SP);
          f.endConditional();
          f.startIndent();
          f.startIfGroupBreaks();
          f.softLineBreakOrSpace();
          f.token(this.T_PIPE_SP);
          f.endConditional();
          for (let i = c; i < cend; i++) {
            if (i > c) {
              f.softLineBreakOrSpace();
              f.token(this.T_PIPE_SP);
            }
            this.print(this.childA[i] | 0);
          }
          f.endIndent();
        }
        f.endGroup();
        f.endGroup();
        break;
      case K_SCALAR_TYPE_EXTENSION:
      case K_SCALAR_TYPE_DEFINITION:
        c = this.description(c, cend, kind);
        if (kind === K_SCALAR_TYPE_EXTENSION) f.token(this.T_EXTEND_SP);
        f.token(this.T_SCALAR_SP);
        if (c < cend && this.kindAt(c) === K_NAME) {
          this.printName(this.childA[c] | 0);
          c = c + 1;
        }
        c = this.directives(c, cend, kind);
        break;
      case K_NON_NULL_TYPE:
        if (c < cend && isTypeKind(this.kindAt(c))) this.print(this.childA[c] | 0);
        f.token(this.T_BANG);
        break;
      case K_LIST_TYPE:
        f.token(this.T_LBRACKET);
        if (c < cend && isTypeKind(this.kindAt(c))) this.print(this.childA[c] | 0);
        f.token(this.T_RBRACKET);
        break;
      default:
        break;
    }
  }
}
