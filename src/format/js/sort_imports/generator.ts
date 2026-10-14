// Port of vendor/bun/src/format/js/sort_imports/generator.rs: `@babel/generator` 7.29 for the nodes of `babel.ts`: `printer.js`, `buffer.js`,
// and of `generators/` what prints a program of directives and imports.
//
// Functions have the names that they have there. What depends on options that the plugins do not set (`retainLines`, `compact`, `concise`,
// source maps, ..) is left out.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { jsWhitespaceLen } from "../../text.ts";
import {
  SP,
  importAttributes,
  importAttributesEntriesLen,
  importAttributesEntriesStart,
  importIsDeferred,
  listAt,
  nameBuf,
  nameLen,
  nameStart,
  propSpan,
} from "../../../lint/ast/index.ts";
import {
  Comment,
  Declaration,
  Lines,
  Model,
  N_ATTRIBUTE,
  N_ATTRIBUTE_KEY,
  N_ATTRIBUTE_VALUE,
  N_DIRECTIVE,
  N_DIRECTIVE_LITERAL,
  N_EMPTY,
  N_IMPORT,
  N_IMPORTED,
  N_INTERPRETER,
  N_LOCAL,
  N_NEW_LINE,
  N_NEW_LINE_LITERAL,
  N_SOURCE,
  N_SPECIFIER,
  SPEC_DEFAULT,
  SPEC_NAMED,
  SPEC_NAMESPACE,
  Specifier,
  WHICH_INNER,
  WHICH_LEADING,
  WHICH_TRAILING,
  attributeKeySpan,
  mkNode,
  nodeKindOf,
  nodePayload,
} from "./babel.ts";
import { Span, bytesString, hasJsLineBreakIn, sameBytes, utf16Len } from "./util.ts";

/** What `_buf._last` is after a string has been appended. */
const LAST_IS_TEXT = -1;
/** After a word. */
const LAST_IS_WORD = -3;

export const PIECE_INTERPRETER: number = 0;
export const PIECE_DIRECTIVE: number = 1;
export const PIECE_IMPORT: number = 2;
export const PIECE_COMMENT: number = 3;

/** Where a statement, or a comment between statements, is in the code. */
export class Piece {
  kind: number;
  /** The index of the directive, the import or the comment. */
  id: number;
  start: number;
  end: number;
  constructor(kind: number, id: number, start: number, end: number) {
    this.kind = kind;
    this.id = id;
    this.start = start;
    this.end = end;
  }
}

// `COMMENT_SKIP_NEWLINE`
const SKIP_DEFAULT = 0;
const SKIP_ALL = 1;
const SKIP_LEADING = 2;
const SKIP_TRAILING = 3;

/** Whether the interpreter line and the directives of the file are part of the program. */
export const PROLOGUE_INCLUDED: number = 0;
export const PROLOGUE_OMITTED: number = 1;

const JOIN_SEQUENCE = 0;
const JOIN_LIST = 1;

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) | 0;
  return b;
}

export class Printer {
  model: Model;
  /** `importAttributesKeyword` */
  attributesKeyword: string;
  /** What a line ends with. */
  endOfLine: Uint8Array;

  // `Buffer`
  out: ByteBuf = new ByteBuf(1024);
  last: number = 0;
  queued: number = 0;
  /** The `;` that is queued belongs to a statement that is an empty line already. */
  isQueuedHidden: boolean = false;
  /** The end of the last empty line: what is before is not trimmed. */
  keptLen: number = 0;

  current: number = -1;
  indent: number = 0;
  noLineTerminator: boolean = false;
  printedComments: boolean[] = [];
  lastCommentLine: number = 0;
  innerCommentsState: number = 0;

  pieces: Piece[] = [];
  /** A comment is not printed as it is written, or not between statements. */
  hasChangedComment: boolean = false;
  /** What Babel prints cannot be parsed. */
  hasFailed: boolean = false;

  constructor(model: Model, attributesKeyword: string, endOfLine: string) {
    this.model = model;
    this.attributesKeyword = attributesKeyword;
    this.endOfLine = ascii(endOfLine);
    for (let i = 0; i < model.comments.length; i++) this.printedComments.push(false);
  }

  /** `generate(file(program(body, directives, "module", interpreter))).code`, with the statements that stand for empty lines replaced. */
  generate(prologue: number, body: number[]): void {
    const model = this.model;
    if (prologue === PROLOGUE_INCLUDED && model.interpreter !== null) this.print(mkNode(N_INTERPRETER, 0), false, 0);
    // `Program`
    const directives = prologue === PROLOGUE_INCLUDED ? model.directives.length : 0;
    if (directives > 0) {
      const newline = body.length === 0 ? 1 : 2;
      const nodes: number[] = [];
      for (let i = 0; i < directives; i++) nodes.push(mkNode(N_DIRECTIVE, i));
      this.printSequence(nodes, newline);
      if (model.commentsOf(mkNode(N_DIRECTIVE, directives - 1), WHICH_TRAILING).isEmpty()) this.newline(newline);
    }
    this.printSequence(body, 0);
    this.lastCommentLine = 0;

    // `Buffer.get`
    const last = this.last;
    if (this.queued !== 32) this.flush();
    if (last === 10) {
      let end = this.out.len;
      const d = this.out.data;
      while (end > 0) {
        const b = d[end - 1] | 0;
        if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) end = end - 1;
        else break;
      }
      this.out.len = end > this.keptLen ? end : this.keptLen;
    }
  }

  code(): Uint8Array {
    return this.out.data.subarray(0, this.out.len);
  }

  // ───────────────────────────── buffer.js ─────────────────────────────

  flush(): void {
    if (this.queued !== 0) {
      if (!this.isQueuedHidden) this.out.push(this.queued);
      this.last = this.queued;
      this.queued = 0;
      this.isQueuedHidden = false;
    }
  }

  bufferAppend(text: Uint8Array, start: number, end: number): void {
    this.flush();
    this.out.append(text, start, end);
    this.last = LAST_IS_TEXT;
  }

  bufferAppendChar(char: number): void {
    this.flush();
    if (char === 10) this.out.append(this.endOfLine, 0, this.endOfLine.length);
    else this.out.push(char);
    this.last = char;
  }

  getLastChar(checksQueue: boolean): number {
    if (checksQueue && this.queued !== 0) return this.queued;
    return this.last;
  }

  getNewlineCount(): number {
    return this.queued === 0 && this.last === 10 ? 1 : 0;
  }

  hasContent(): boolean {
    return this.last !== 0;
  }

  getCurrentColumn(): number {
    const d = this.out.data;
    let start = 0;
    for (let i = this.out.len - 1; i >= 0; i--) {
      if ((d[i] | 0) === 10) {
        start = i + 1;
        break;
      }
    }
    return utf16Len(d, start, this.out.len) + (this.queued !== 0 ? 1 : 0);
  }

  // ───────────────────────────── printer.js ─────────────────────────────

  semicolon(isForced: boolean): void {
    if (isForced) this.appendChar(59, false);
    else this.queue(59);
    this.noLineTerminator = false;
  }

  space(): void {
    const last = this.getLastChar(true);
    if (last !== 0 && last !== 32 && last !== 10) this.queue(32);
  }

  /** `word(text)` of a text in `buf[start, end)`. */
  word(buf: Uint8Array, start: number, end: number): void {
    this.maybePrintInnerComments();
    const last = this.getLastChar(false);
    if (last === LAST_IS_WORD || (last === 47 && end > start && (buf[start] | 0) === 47)) this.queue(32);
    this.append(buf, start, end);
    this.last = LAST_IS_WORD;
    this.noLineTerminator = false;
  }

  wordAscii(s: string): void {
    const b = ascii(s);
    this.word(b, 0, b.length);
  }

  token(buf: Uint8Array, start: number, end: number): void {
    this.maybePrintInnerComments();
    this.append(buf, start, end);
    this.noLineTerminator = false;
  }

  tokenAscii(s: string): void {
    const b = ascii(s);
    this.token(b, 0, b.length);
  }

  tokenChar(char: number): void {
    this.maybePrintInnerComments();
    this.appendChar(char, false);
    this.noLineTerminator = false;
  }

  newline(count: number): void {
    const times = (count < 2 ? count : 2) - this.getNewlineCount();
    for (let i = 0; i < times; i++) this.newlineChar();
  }

  /** `_newline` */
  newlineChar(): void {
    if (this.queued === 32) this.queued = 0;
    this.appendChar(10, true);
  }

  append(buf: Uint8Array, start: number, end: number): void {
    this.maybeIndent();
    this.bufferAppend(buf, start, end);
  }

  appendChar(char: number, isWithoutIndent: boolean): void {
    if (!isWithoutIndent) this.maybeIndent();
    this.bufferAppendChar(char);
  }

  queue(char: number): void {
    this.flush();
    this.queued = char;
    this.last = LAST_IS_TEXT;
  }

  shouldIndent(): number {
    return this.getLastChar(true) === 10 ? this.indent : 0;
  }

  maybeIndent(): void {
    const indent = this.shouldIndent();
    if (indent > 0) {
      this.out.fill(32, indent);
      this.last = LAST_IS_TEXT;
    }
  }

  print(node: number, noLineTerminatorAfter: boolean, trailingCommentsLineOffset: number): void {
    this.innerCommentsState = 0;
    const parent = this.current;
    this.current = node;

    this.printComments(WHICH_LEADING, node, 0);
    const start = this.out.len + (this.queued !== 0 && !this.isQueuedHidden ? 1 : 0);
    this.printNode(node);
    const kind = nodeKindOf(node);
    const payload = nodePayload(node);
    if (kind === N_INTERPRETER || kind === N_DIRECTIVE || kind === N_IMPORT) {
      let end: number;
      if (kind === N_INTERPRETER) {
        const span = this.model.span(node);
        end = start + (span === null ? 0 : span.len());
      } else {
        end = this.out.len + (this.queued === 59 ? 1 : 0);
      }
      this.pieces.push(new Piece(kind === N_INTERPRETER ? PIECE_INTERPRETER : kind === N_DIRECTIVE ? PIECE_DIRECTIVE : PIECE_IMPORT, payload, start, end));
    }
    if (noLineTerminatorAfter && !this.noLineTerminator) {
      // Babel puts the node in parentheses, which is not valid for the source of an import.
      const trailing = this.model.list(this.model.commentsOf(node, WHICH_TRAILING));
      for (let i = 0; i < trailing.length; i++) {
        const c = this.model.comments[trailing[i] as number] as Comment;
        const v = this.model.commentValue(trailing[i] as number);
        if (!c.isBlock || hasJsLineBreakIn(this.model.text, v.start, v.end)) this.hasFailed = true;
      }
      this.noLineTerminator = true;
      this.printTrailingComments(node, 0);
    } else {
      this.printTrailingComments(node, trailingCommentsLineOffset);
    }
    this.current = parent;
    this.innerCommentsState = 0;
  }

  printJoin(nodes: number[], join: number, trailingCommentsLineOffset: number): void {
    for (let index = 0; index < nodes.length; index++) {
      const node = (nodes[index] as number) | 0;
      if (join === JOIN_SEQUENCE && index === 0 && this.hasContent()) this.newline(1);
      this.print(node, false, trailingCommentsLineOffset);
      if (join === JOIN_LIST) {
        if (index + 1 < nodes.length) {
          this.tokenChar(44);
          this.space();
        }
        continue;
      }
      if (index + 1 < nodes.length) {
        const lines = this.model.lines(nodes[index + 1] as number);
        const nextLine = lines === null ? 0 : lines.start;
        if (this.lastCommentLine > 0 && nextLine >= this.lastCommentLine) {
          const d = nextLine - this.lastCommentLine;
          this.newline(d > 1 ? d : 1);
          continue;
        }
      }
      this.newline(1);
    }
  }

  printSequence(nodes: number[], trailingCommentsLineOffset: number): void {
    this.printJoin(nodes, JOIN_SEQUENCE, trailingCommentsLineOffset);
  }

  printList(nodes: number[]): void {
    this.printJoin(nodes, JOIN_LIST, 0);
  }

  printTrailingComments(node: number, lineOffset: number): void {
    this.printCommentsAs(1, WHICH_INNER, node, lineOffset);
    if (this.model.commentsOf(node, WHICH_TRAILING).isEmpty()) this.lastCommentLine = 0;
    else this.printComments(WHICH_TRAILING, node, lineOffset);
  }

  maybePrintInnerComments(): void {
    const state = this.innerCommentsState;
    const s = state & 3;
    if (s === 0) this.innerCommentsState = 1 | 4;
    else if (s === 1) this.printInnerComments((state & 4) !== 0);
  }

  printInnerComments(isIndented: boolean): void {
    if (this.current < 0 || this.model.commentsOf(this.current, WHICH_INNER).isEmpty()) {
      this.innerCommentsState = 2;
      return;
    }
    const node = this.current;
    const hasSpace = this.getLastChar(true) === 32;
    if (isIndented) this.indent = this.indent + 2;
    const printed = this.printCommentsAs(1, WHICH_INNER, node, 0);
    if (printed === 2) this.innerCommentsState = 2;
    if (printed !== 0 && hasSpace) this.space();
    if (isIndented) this.indent = this.indent - 2;
  }

  noIndentInnerCommentsHere(): void {
    this.innerCommentsState = this.innerCommentsState & ~4;
  }

  /** 0: no, 1: yes, 2: later. */
  shouldPrintComment(comment: number): number {
    if (this.printedComments[comment] as boolean) return 0;
    const v = this.model.commentValue(comment);
    if (this.noLineTerminator && (hasJsLineBreakIn(this.model.text, v.start, v.end) || hasStar(this.model.text, v.start, v.end))) return 2;
    this.printedComments[comment] = true;
    return 1;
  }

  printComment(id: number, skipNewLines: number): void {
    const model = this.model;
    const comment = model.comments[id] as Comment;
    const noLineTerminator = this.noLineTerminator;
    const printsNewLines = comment.isBlock && skipNewLines !== SKIP_ALL && !noLineTerminator;
    if (printsNewLines && this.hasContent() && skipNewLines !== SKIP_LEADING) this.newline(1);
    const lastChar = this.getLastChar(true);
    if (lastChar === 47) this.queue(32);
    else if (lastChar === 91 || lastChar === 123 || lastChar === 40) {
      // Nothing.
    } else this.space();

    const text = model.text;
    const kind = nodeKindOf(this.current);
    const isBetweenStatements = this.current >= 0 && (kind === N_INTERPRETER || kind === N_DIRECTIVE || kind === N_IMPORT || kind === N_EMPTY);
    let adjusted: Uint8Array | null = null;
    if (comment.isBlock && hasJsLineBreakIn(text, comment.start, comment.end)) {
      let indentSize = this.getCurrentColumn();
      if (this.shouldIndent() > 0) indentSize = indentSize + this.indent;
      adjusted = adjustMultilineComment(text, comment.start, comment.end, comment.hasLoc ? comment.startColumn : 0, indentSize);
    } else if (!comment.isBlock && noLineTerminator) {
      const v = model.commentValue(id);
      const body = text.subarray(v.start, v.end);
      adjusted = new Uint8Array(body.length + 4);
      adjusted[0] = 47;
      adjusted[1] = 42;
      adjusted.set(body, 2);
      adjusted[body.length + 2] = 42;
      adjusted[body.length + 3] = 47;
    }
    const value = adjusted === null ? text : adjusted;
    const vs = adjusted === null ? comment.start : 0;
    const ve = adjusted === null ? comment.end : adjusted.length;
    this.hasChangedComment = this.hasChangedComment || !isBetweenStatements || !sameBytes(value, vs, ve, text, comment.start, comment.end);
    this.maybeIndent();
    this.flush();
    const start = this.out.len;
    this.bufferAppend(value, vs, ve);
    this.pieces.push(new Piece(PIECE_COMMENT, id, start, this.out.len));

    if (!comment.isBlock && !noLineTerminator) this.newlineChar();
    if (printsNewLines && skipNewLines !== SKIP_TRAILING) this.newline(1);
  }

  printComments(which: number, node: number, lineOffset: number): void {
    this.printCommentsAs(which === WHICH_LEADING ? 0 : 2, which, node, lineOffset);
  }

  /** `_printComments`. `kind`: `COMMENT_TYPE`, 0 for leading, 1 for inner, 2 for trailing. */
  printCommentsAs(kind: number, which: number, node: number, lineOffset: number): number {
    const model = this.model;
    const list = model.commentsOf(node, which);
    if (list.isEmpty()) return 2;
    const comments = model.list(list);
    const nodeLinesOpt = model.lines(node);
    let hasLoc = nodeLinesOpt !== null;
    const nodeLines = nodeLinesOpt === null ? new Lines(0, 0) : nodeLinesOpt;
    let lastLine = 0;
    let leadingCommentNewline = 0;
    const noLineTerminator = this.noLineTerminator;
    const len = comments.length;

    for (let index = 0; index < len; index++) {
      const id = comments[index] as number;
      const comment = model.comments[id] as Comment;
      const shouldPrint = this.shouldPrintComment(id);
      if (shouldPrint === 2) return index !== 0 ? 1 : 0;
      if (hasLoc && comment.hasLoc && shouldPrint === 1) {
        let offset: number;
        if (kind === 0) {
          if (index > 0) {
            offset = comment.startLine - lastLine;
          } else {
            if (this.hasContent() && (!comment.isBlock || comment.startLine !== comment.endLine)) leadingCommentNewline = 1;
            offset = leadingCommentNewline;
          }
        } else if (kind === 1) {
          offset = comment.startLine - (index === 0 ? nodeLines.start : lastLine);
        } else {
          offset = comment.startLine - (index === 0 ? nodeLines.end - lineOffset : lastLine);
        }
        lastLine = comment.endLine;
        if (offset > 0 && !noLineTerminator) this.newline(offset);
        this.printComment(id, SKIP_ALL);
        if (index + 1 === len && kind !== 2) {
          let count: number;
          if (kind === 0) {
            const d = nodeLines.start - lastLine;
            count = d > leadingCommentNewline ? d : leadingCommentNewline;
          } else {
            const d = nodeLines.end - lastLine;
            count = d < 1 ? d : 1;
          }
          if (count > 0 && !noLineTerminator) this.newline(count);
          lastLine = kind === 0 ? nodeLines.start : nodeLines.end;
        }
        continue;
      }
      hasLoc = false;
      if (shouldPrint !== 1) continue;
      let skip: number;
      if (len === 1) {
        const v = model.commentValue(id);
        const isSingleLine = comment.hasLoc ? comment.startLine === comment.endLine : !hasJsLineBreakIn(model.text, v.start, v.end);
        const nodeKind = nodeKindOf(node);
        const isStatement = nodeKind === N_IMPORT || nodeKind === N_EMPTY || nodeKind === N_NEW_LINE;
        skip = isSingleLine && !isStatement && kind !== 1 ? SKIP_ALL : SKIP_DEFAULT;
      } else if (kind === 1) {
        skip = index === 0 ? SKIP_LEADING : index === len - 1 ? SKIP_TRAILING : SKIP_DEFAULT;
      } else {
        skip = SKIP_DEFAULT;
      }
      this.printComment(id, skip);
    }
    if (kind === 2 && hasLoc && lastLine !== 0) this.lastCommentLine = lastLine;
    return 2;
  }

  // ───────────────────────────── generators/ ─────────────────────────────

  printNode(node: number): void {
    const model = this.model;
    const kind = nodeKindOf(node);
    const payload = nodePayload(node);
    switch (kind) {
      case N_INTERPRETER: {
        const i = model.interpreter;
        if (i !== null) this.token(model.text, i.start, i.end);
        this.newlineChar();
        break;
      }
      case N_DIRECTIVE:
        this.print(mkNode(N_DIRECTIVE_LITERAL, payload), false, 0);
        this.semicolon(false);
        break;
      case N_DIRECTIVE_LITERAL: {
        const d = model.directives[payload];
        if (d !== undefined) this.token(model.text, d.literalStart, d.literalEnd);
        break;
      }
      case N_IMPORT:
        this.importDeclaration(payload);
        break;
      case N_SPECIFIER:
        this.importSpecifier(payload);
        break;
      case N_IMPORTED:
        this.moduleExportName((model.specifiers[payload] as Specifier).importedAtom, (model.specifiers[payload] as Specifier).importedPos, (model.specifiers[payload] as Specifier).importedSpan());
        break;
      case N_LOCAL:
        this.moduleExportName((model.specifiers[payload] as Specifier).localAtom, (model.specifiers[payload] as Specifier).localPos, (model.specifiers[payload] as Specifier).localSpan());
        break;
      case N_SOURCE:
      case N_ATTRIBUTE_KEY:
      case N_ATTRIBUTE_VALUE: {
        const span = model.span(node);
        if (span === null) break;
        const first = model.text[span.start] | 0;
        if (first === 34 || first === 39) this.token(model.text, span.start, span.end);
        else this.word(model.text, span.start, span.end);
        break;
      }
      case N_ATTRIBUTE:
        this.print(mkNode(N_ATTRIBUTE_KEY, payload), false, 0);
        this.tokenChar(58);
        this.space();
        this.print(mkNode(N_ATTRIBUTE_VALUE, payload), false, 0);
        break;
      case N_EMPTY:
        this.semicolon(true);
        break;
      case N_NEW_LINE:
        this.print(mkNode(N_NEW_LINE_LITERAL, 0), false, 0);
        this.semicolon(false);
        this.isQueuedHidden = true;
        break;
      case N_NEW_LINE_LITERAL:
        this.maybePrintInnerComments();
        this.flush();
        this.out.append(this.endOfLine, 0, this.endOfLine.length);
        this.out.append(this.endOfLine, 0, this.endOfLine.length);
        this.keptLen = this.out.len;
        this.last = LAST_IS_TEXT;
        this.noLineTerminator = false;
        break;
      default:
        break;
    }
  }

  /** An `Identifier`, or a `StringLiteral`. */
  moduleExportName(atom: number, pos: number, span: Span): void {
    const model = this.model;
    if (model.text[pos] === 34 || model.text[pos] === 39) {
      this.token(model.text, span.start, span.end);
    } else {
      const b = nameBytesOf(atom);
      this.word(b, 0, b.length);
    }
  }

  importSpecifier(index: number): void {
    const specifier = this.model.specifiers[index] as Specifier;
    if (specifier.kind === SPEC_DEFAULT) {
      this.print(mkNode(N_LOCAL, index), false, 0);
    } else if (specifier.kind === SPEC_NAMESPACE) {
      this.tokenChar(42);
      this.space();
      this.wordAscii("as");
      this.space();
      this.print(mkNode(N_LOCAL, index), false, 0);
    } else {
      if (specifier.isType) {
        this.wordAscii("type");
        this.space();
      }
      this.print(mkNode(N_IMPORTED, index), false, 0);
      // `imported.name` of a string is undefined.
      const im = specifier.importedBytes();
      const lo = specifier.localBytes();
      if (specifier.importedIsString() || !sameBytes(lo, 0, lo.length, im, 0, im.length)) {
        this.space();
        this.wordAscii("as");
        this.space();
        this.print(mkNode(N_LOCAL, index), false, 0);
      }
    }
  }

  /** The same as `importDeclaration` where no import has a comment in it. */
  importDeclarationWithoutComments(index: number): void {
    const model = this.model;
    const declaration = model.declarations[index] as Declaration;
    this.flush();
    const out = this.out;
    out.appendAscii("import ");
    if (declaration.isType) out.appendAscii("type ");
    else if (importIsDeferred(declaration.import) && declaration.hasSpan) out.appendAscii("defer ");
    const specifiers = model.specifiersOf(declaration);
    let isInBraces = false;
    for (let at = 0; at < specifiers.length; at++) {
      const specifier = model.specifiers[specifiers[at] as number] as Specifier;
      if (at > 0) out.appendAscii(", ");
      if (specifier.kind === SPEC_DEFAULT) {
        // Nothing.
      } else if (specifier.kind === SPEC_NAMESPACE) {
        out.appendAscii("* as ");
      } else {
        if (!isInBraces) {
          isInBraces = true;
          out.appendAscii("{ ");
        }
        if (specifier.isType) out.appendAscii("type ");
        const isString = specifier.importedIsString();
        const im = specifier.importedBytes();
        const lo = specifier.localBytes();
        if (isString || !sameBytes(lo, 0, lo.length, im, 0, im.length)) {
          if (isString) {
            const s = specifier.importedSpan();
            out.append(model.text, s.start, s.end);
          } else {
            out.append(im, 0, im.length);
          }
          out.appendAscii(" as ");
        }
      }
      const lo = specifier.localBytes();
      out.append(lo, 0, lo.length);
    }
    if (isInBraces) out.appendAscii(" }");
    else if (declaration.isType && specifiers.length === 0) out.appendAscii("{}");
    if (specifiers.length > 0 || declaration.isType) out.appendAscii(" from ");
    out.append(model.text, declaration.sourceStart, declaration.sourceEnd);
    const row = importAttributes(declaration.import);
    if (row >= 0 && declaration.hasAttributes) {
      const isLegacy = this.attributesKeyword.endsWith("-legacy");
      out.push(32);
      out.appendAscii(isLegacy ? this.attributesKeyword.substring(0, this.attributesKeyword.length - 7) : this.attributesKeyword);
      out.appendAscii(isLegacy ? " " : " { ");
      let isFirst = true;
      const n = importAttributesEntriesLen(row);
      const es = importAttributesEntriesStart(row);
      for (let k = 0; k < n; k++) {
        const attribute = listAt(es, k);
        const key = attributeKeySpan(attribute);
        const value = model.span(mkNode(N_ATTRIBUTE_VALUE, attributeStartOf(attribute)));
        if (key === null || value === null) continue;
        if (!isFirst) out.appendAscii(", ");
        isFirst = false;
        out.append(model.text, key.start, key.end);
        out.appendAscii(": ");
        out.append(model.text, value.start, value.end);
      }
      if (!isLegacy) out.appendAscii(" }");
    }
    this.last = LAST_IS_TEXT;
    this.semicolon(false);
  }

  importDeclaration(index: number): void {
    const model = this.model;
    if (!model.hasCommentsInImports) {
      this.importDeclarationWithoutComments(index);
      return;
    }
    const declaration = model.declarations[index] as Declaration;
    this.wordAscii("import");
    this.space();
    if (declaration.isType) {
      this.noIndentInnerCommentsHere();
      this.wordAscii("type");
      this.space();
    } else if (importIsDeferred(declaration.import) && declaration.hasSpan) {
      this.noIndentInnerCommentsHere();
      this.wordAscii("defer");
      this.space();
    }

    const specifiers = model.specifiersOf(declaration);
    const hasSpecifiers = specifiers.length > 0;
    let special = 0;
    while (special < specifiers.length && (model.specifiers[specifiers[special] as number] as Specifier).kind !== SPEC_NAMED) special = special + 1;
    for (let at = 0; at < special; at++) {
      this.print(mkNode(N_SPECIFIER, specifiers[at] as number), false, 0);
      if (at + 1 < specifiers.length) {
        this.tokenChar(44);
        this.space();
      }
    }
    if (special < specifiers.length) {
      this.tokenChar(123);
      this.space();
      const nodes: number[] = [];
      for (let i = special; i < specifiers.length; i++) nodes.push(mkNode(N_SPECIFIER, specifiers[i] as number));
      this.printList(nodes);
      this.space();
      this.tokenChar(125);
    } else if (declaration.isType && !hasSpecifiers) {
      this.tokenChar(123);
      this.tokenChar(125);
    }
    if (hasSpecifiers || declaration.isType) {
      this.space();
      this.wordAscii("from");
      this.space();
    }

    const source = mkNode(N_SOURCE, declaration.sourceStart);
    const row = importAttributes(declaration.import);
    if (row >= 0 && declaration.hasAttributes) {
      this.print(source, true, 0);
      this.space();
      // `_printAttributes`
      const kw = this.attributesKeyword.endsWith("-legacy") ? this.attributesKeyword.substring(0, this.attributesKeyword.length - 7) : this.attributesKeyword;
      this.wordAscii(kw);
      this.space();
      const nodes: number[] = [];
      const n = importAttributesEntriesLen(row);
      const es = importAttributesEntriesStart(row);
      for (let k = 0; k < n; k++) {
        const attribute = listAt(es, k);
        if (attributeKeySpan(attribute) !== null) nodes.push(mkNode(N_ATTRIBUTE, attributeStartOf(attribute)));
      }
      if (this.attributesKeyword.endsWith("-legacy")) {
        this.printList(nodes);
      } else {
        this.tokenAscii("{");
        this.space();
        this.printList(nodes);
        this.space();
        this.tokenAscii("}");
      }
    } else {
      this.print(source, false, 0);
    }
    this.semicolon(false);
  }
}

function hasStar(text: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i + 1 < end; i++) if ((text[i] | 0) === 42 && (text[i + 1] | 0) === 47) return true;
  return false;
}

function nameBytesOf(atom: number): Uint8Array {
  const s = nameStart(atom);
  return nameBuf(atom).subarray(s, s + nameLen(atom));
}

function attributeStartOf(attribute: number): number {
  propSpan(attribute);
  return SP.s0 | 0;
}

/** `adjustMultilineComment`: takes up to `offset` characters of whitespace off the start of every line of `comment` but the first, and puts `indentSize` spaces there. */
function adjustMultilineComment(text: Uint8Array, start: number, end: number, offset: number, indentSize: number): Uint8Array {
  const out = new ByteBuf(end - start + 16);
  let rest = start;
  while (true) {
    let at = -1;
    for (let i = rest; i < end; i++) {
      if ((text[i] | 0) === 10) {
        at = i;
        break;
      }
    }
    if (at < 0) break;
    out.append(text, rest, at + 1);
    out.fill(32, indentSize);
    rest = at + 1;
    // `\n\s{1,offset}`, which can take line breaks too.
    for (let k = 0; k < offset; k++) {
      const len = jsWhitespaceLen(text, rest, end);
      if (len === 0) break;
      rest = rest + len;
    }
  }
  out.append(text, rest, end);
  return out.data.slice(0, out.len);
}
