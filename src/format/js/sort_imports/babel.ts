// Port of vendor/bun/src/format/js/sort_imports/babel.rs: the imports of a file the way Babel sees them.
//
// The plugins of Prettier parse a file with `@babel/parser`, move the import declarations and the comments that Babel has attached to them
// around, and print them with `@babel/generator` (`generator.ts`). What comes of it depends on which nodes Babel attaches a comment to, and
// on the lines that nodes and comments are on. This is as much of Babel's tree as that takes: the `#!` line, the directives and the import
// declarations that are not in a `declare module`.
import {
  KEY_IDENT,
  KEY_STRING,
  SP,
  STMT_IMPORT,
  TK_BLOCK,
  TK_SHEBANG,
  commentEndAt,
  commentKindAt,
  commentStartAt,
  commentsLen,
  exprSpan,
  fileBodyLen,
  fileBodyStart,
  fileHasBom,
  hir,
  identIsString,
  identSpan,
  importAttributes,
  importAttributesEntriesLen,
  importAttributesEntriesStart,
  importDefault,
  importDefaultPos,
  importIsTypeOnly,
  importNamedLen,
  importNamedStart,
  importNamespace,
  importNamespacePos,
  importNamespaceSpan,
  importSpec,
  importSpecImported,
  importSpecImportedPos,
  importSpecIsTypeOnly,
  importSpecLocal,
  importSpecLocalPos,
  importSpecSpan,
  importSpecSpanOf,
  keyKind,
  keySpan,
  listAt,
  nodeOfProp,
  propSpan,
  propValue,
  stmtDirectiveSpan,
  stmtExprExpr,
  stmtImportImport,
  stmtSpan,
  stmtTag,
  tokenLen,
  STMT_EXPR,
} from "../../../lint/ast/index.ts";
import { Span, nameBytes, utf16Len } from "./util.ts";

/** `Comment`s are indices of `Model.comments`. */
export class Comment {
  /** With its delimiters. */
  start: number;
  end: number;
  isBlock: boolean;
  /** Whether it has a `loc`, which the next three fields are. The plugins change and delete it. */
  hasLoc: boolean;
  startLine: number;
  endLine: number;
  /** In UTF-16 code units. */
  startColumn: number;
  constructor(start: number, end: number, isBlock: boolean) {
    this.start = start;
    this.end = end;
    this.isBlock = isBlock;
    this.hasLoc = true;
    this.startLine = 0;
    this.endLine = 0;
    this.startColumn = 0;
  }
}

/** `leadingComments`, `innerComments` or `trailingComments`: a range of `Model.lists`. */
export class List {
  start: number;
  len: number;
  constructor(start: number, len: number) {
    this.start = start;
    this.len = len;
  }
  isEmpty(): boolean {
    return this.len === 0;
  }
}

export const NO_LIST = new List(0, 0);

export const WHICH_LEADING: number = 0;
export const WHICH_INNER: number = 1;
export const WHICH_TRAILING: number = 2;

/** `loc.start.line` and `loc.end.line` */
export class Lines {
  start: number;
  end: number;
  constructor(start: number, end: number) {
    this.start = start;
    this.end = end;
  }
}

export class Attached {
  leading: List = NO_LIST;
  inner: List = NO_LIST;
  trailing: List = NO_LIST;
  get(which: number): List {
    return which === WHICH_LEADING ? this.leading : which === WHICH_INNER ? this.inner : this.trailing;
  }
  set(which: number, list: List): void {
    if (which === WHICH_LEADING) this.leading = list;
    else if (which === WHICH_INNER) this.inner = list;
    else this.trailing = list;
  }
  copy(): Attached {
    const a = new Attached();
    a.leading = this.leading;
    a.inner = this.inner;
    a.trailing = this.trailing;
    return a;
  }
}

/** An `ImportDeclaration`. */
export class Declaration {
  import: number;
  /** `start` and `end`. hasSpan false for a node that a plugin has made. */
  hasSpan: boolean;
  start: number;
  end: number;
  hasLines: boolean;
  lines: Lines;
  /** `importKind === "type"` */
  isType: boolean;
  /** `specifiers`: a range of `Model.orders`. */
  specifiersStart: number;
  specifiersLen: number;
  /** The module specifier, with its quotes. */
  sourceStart: number;
  sourceEnd: number;
  /** A node that a plugin has made has no attributes. */
  hasAttributes: boolean;
  comments: Attached;
  constructor(imp: number) {
    this.import = imp;
    this.hasSpan = true;
    this.start = 0;
    this.end = 0;
    this.hasLines = true;
    this.lines = new Lines(0, 0);
    this.isType = false;
    this.specifiersStart = 0;
    this.specifiersLen = 0;
    this.sourceStart = 0;
    this.sourceEnd = 0;
    this.hasAttributes = false;
    this.comments = new Attached();
  }
  /** `Declaration { ..declaration }` */
  copy(): Declaration {
    const d = new Declaration(this.import);
    d.hasSpan = this.hasSpan;
    d.start = this.start;
    d.end = this.end;
    d.hasLines = this.hasLines;
    d.lines = this.lines;
    d.isType = this.isType;
    d.specifiersStart = this.specifiersStart;
    d.specifiersLen = this.specifiersLen;
    d.sourceStart = this.sourceStart;
    d.sourceEnd = this.sourceEnd;
    d.hasAttributes = this.hasAttributes;
    d.comments = this.comments.copy();
    return d;
  }
}

export const SPEC_DEFAULT: number = 0;
export const SPEC_NAMESPACE: number = 1;
export const SPEC_NAMED: number = 2;

/** An `ImportDefaultSpecifier`, an `ImportNamespaceSpecifier` or an `ImportSpecifier`. */
export class Specifier {
  kind: number;
  /** `importKind === "type"` */
  isType: boolean;
  /** The same as `local` unless there is an `as`. (atom, pos) */
  importedAtom: number;
  importedPos: number;
  localAtom: number;
  localPos: number;
  start: number;
  end: number;
  comments: Attached;
  constructor(kind: number, isType: boolean, importedAtom: number, importedPos: number, localAtom: number, localPos: number, start: number, end: number) {
    this.kind = kind;
    this.isType = isType;
    this.importedAtom = importedAtom;
    this.importedPos = importedPos;
    this.localAtom = localAtom;
    this.localPos = localPos;
    this.start = start;
    this.end = end;
    this.comments = new Attached();
  }
  importedSpan(): Span {
    identSpan(this.importedAtom, this.importedPos);
    const SP$ = SP;
    return new Span(SP$.s0 | 0, SP$.s1 | 0);
  }
  localSpan(): Span {
    identSpan(this.localAtom, this.localPos);
    const SP$ = SP;
    return new Span(SP$.s0 | 0, SP$.s1 | 0);
  }
  isRenamed(): boolean {
    const a = this.importedSpan();
    const b = this.localSpan();
    return a.start !== b.start || a.end !== b.end;
  }
  importedIsString(): boolean {
    return identIsString(this.importedPos);
  }
  localIsString(): boolean {
    return identIsString(this.localPos);
  }
  /** `imported.name` bytes. */
  importedBytes(): Uint8Array {
    return nameBytes(this.importedAtom);
  }
  localBytes(): Uint8Array {
    return nameBytes(this.localAtom);
  }
}

/** `"use strict";` */
export class Directive {
  start: number;
  end: number;
  /** The string. */
  literalStart: number;
  literalEnd: number;
  comments: Attached = new Attached();
  constructor(start: number, end: number, literalStart: number, literalEnd: number) {
    this.start = start;
    this.end = end;
    this.literalStart = literalStart;
    this.literalEnd = literalEnd;
  }
}

// A node that can have comments: `kind * NODE_SCALE + payload`.
export const NODE_SCALE = 1073741824;
export const N_INTERPRETER: number = 0;
export const N_DIRECTIVE: number = 1;
export const N_DIRECTIVE_LITERAL: number = 2;
export const N_IMPORT: number = 3;
export const N_SPECIFIER: number = 4;
export const N_IMPORTED: number = 5;
export const N_LOCAL: number = 6;
/** By where it starts, like the next three. Two declarations can share a `source`. */
export const N_SOURCE: number = 7;
export const N_ATTRIBUTE: number = 8;
export const N_ATTRIBUTE_KEY: number = 9;
export const N_ATTRIBUTE_VALUE: number = 10;
/** The `EmptyStatement` that a plugin puts first, for comments. */
export const N_EMPTY: number = 11;
/** The statement that becomes an empty line, and the string in it. */
export const N_NEW_LINE: number = 12;
export const N_NEW_LINE_LITERAL: number = 13;

export function mkNode(kind: number, payload: number): number {
  return kind * NODE_SCALE + payload;
}
export function nodeKindOf(node: number): number {
  return Math.floor(node / NODE_SCALE);
}
export function nodePayload(node: number): number {
  return node - Math.floor(node / NODE_SCALE) * NODE_SCALE;
}

/** Skips the white space of JavaScript (and of Babel). */
export function skipWhitespace(text: Uint8Array, at0: number): number {
  let at = at0;
  const n = text.length;
  while (at < n) {
    const b = text[at] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 13 || b === 0x0b || b === 0x0c) at = at + 1;
    else if (b === 0xc2 && at + 1 < n && (text[at + 1] | 0) === 0xa0) at = at + 2;
    else if (b === 0xe2 && at + 2 < n && (text[at + 1] | 0) === 0x80 && ((text[at + 2] | 0) === 0xa8 || (text[at + 2] | 0) === 0xa9)) at = at + 3;
    else if (b === 0xef && at + 2 < n && (text[at + 1] | 0) === 0xbb && (text[at + 2] | 0) === 0xbf) at = at + 3;
    else return at;
  }
  return at;
}

function skipWhitespaceBack(text: Uint8Array, at0: number): number {
  let at = at0;
  while (at > 0) {
    const b = text[at - 1] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 13 || b === 0x0b || b === 0x0c) at = at - 1;
    else if (at >= 2 && b === 0xa0 && (text[at - 2] | 0) === 0xc2) at = at - 2;
    else if (at >= 3 && (b === 0xa8 || b === 0xa9) && (text[at - 2] | 0) === 0x80 && (text[at - 3] | 0) === 0xe2) at = at - 3;
    else if (at >= 3 && b === 0xbf && (text[at - 2] | 0) === 0xbb && (text[at - 3] | 0) === 0xef) at = at - 3;
    else return at;
  }
  return at;
}

/** Babel's `CommentWhitespace`: the comments between two tokens. */
class Group {
  /** Where the token before ends. */
  start: number;
  /** Where the token after starts. */
  end: number;
  /** A range of `Model.comments`. */
  first: number;
  after: number;
  constructor(start: number, end: number, first: number, after: number) {
    this.start = start;
    this.end = end;
    this.first = first;
    this.after = after;
  }
}

class Deep {
  node: number;
  which: number;
  list: List;
  constructor(node: number, which: number, list: List) {
    this.node = node;
    this.which = which;
    this.list = list;
  }
}

export class Interpreter {
  start: number;
  end: number;
  comments: Attached = new Attached();
  constructor(start: number, end: number) {
    this.start = start;
    this.end = end;
  }
}

export class FirstStatement {
  start: number;
  list: List;
  constructor(start: number, list: List) {
    this.start = start;
    this.list = list;
  }
}

export class Model {
  text: Uint8Array;
  /** Those up to `restStart`. */
  comments: Comment[] = [];
  lists: number[] = [];
  interpreter: Interpreter | null = null;
  directives: Directive[] = [];
  declarations: Declaration[] = [];
  specifiers: Specifier[] = [];
  /** Indices into `specifiers`. */
  orders: number[] = [];
  /** The comments of the nodes in specifiers, of sources, of attributes and of the strings of directives. The plugins leave them alone. */
  deep: Deep[] = [];
  /** Whether there is a comment in an import. */
  hasCommentsInImports: boolean = false;
  /** The comments of `N_EMPTY`. */
  empty: Attached = new Attached();
  /** `program.body[0]`: where it starts, and its `leadingComments`. */
  firstStatement: FirstStatement | null = null;
  /** Whether the imports are the first statements after the directives, with nothing between them. */
  isContiguous: boolean = true;
  /** Where the first token after the last import starts, or the file ends. */
  restStart: number = 0;
  /** Where lines start, up to `restStart`. Empty if there are no comments. */
  lineStarts: number[] = [];

  constructor(text: Uint8Array) {
    this.text = text;
  }

  /** The bytes of the file. */
  /** `None`: the file has no imports. */
  static create(): Model | null {
    let lastImport = -1;
    const n = fileBodyLen();
    const bs = fileBodyStart();
    for (let i = n - 1; i >= 0; i--) {
      if (stmtTag(listAt(bs, i)) === STMT_IMPORT) {
        lastImport = listAt(bs, i);
        break;
      }
    }
    if (lastImport < 0) return null;
    const hir$ = hir;
    const model = new Model(hir$.text.subarray(0, hir$.sourceLen | 0));
    stmtSpan(lastImport);
    model.collectComments(SP.s1 | 0);
    model.collectStatements();
    return model;
  }

  /** Where the text starts: after a byte order mark. */
  textStart(): number {
    return fileHasBom() ? 3 : 0;
  }

  /** The comments up to the first token after `end`, where the last import ends. */
  collectComments(end: number): void {
    let restStart = skipWhitespace(this.text, end);
    const n = commentsLen();
    for (let i = 0; i < n; i++) {
      const start = commentStartAt(i);
      const cend = commentEndAt(i);
      if (start > restStart) break;
      if (start === restStart) restStart = skipWhitespace(this.text, cend);
      const kind = commentKindAt(i);
      if (kind === TK_SHEBANG) this.interpreter = new Interpreter(start, cend);
      else this.comments.push(new Comment(start, cend, kind === TK_BLOCK));
    }
    this.restStart = restStart;
    if (this.comments.length === 0) return;

    this.lineStarts.push(0);
    const regionEnd = restStart < this.text.length ? restStart : this.text.length;
    const text = this.text;
    let at = 0;
    while (at < regionEnd) {
      const b = text[at] | 0;
      if (b === 13) {
        at = at + ((at + 1 < regionEnd && (text[at + 1] | 0) === 10) ? 2 : 1);
      } else if (b === 10) {
        at = at + 1;
      } else if (b === 0xe2 && at + 2 < regionEnd && (text[at + 1] | 0) === 0x80 && ((text[at + 2] | 0) === 0xa8 || (text[at + 2] | 0) === 0xa9)) {
        at = at + 3;
      } else {
        at = at + 1;
        continue;
      }
      this.lineStarts.push(at);
    }
    for (let index = 0; index < this.comments.length; index++) {
      const comment = this.comments[index] as Comment;
      const startLine = this.lineOf(comment.start);
      const endLine = this.lineOf(comment.end);
      const lineStartAt = this.lineStarts[startLine - 1] as number;
      const lineStart = lineStartAt > this.textStart() ? lineStartAt : this.textStart();
      comment.startColumn = utf16Len(text, lineStart, comment.start);
      comment.startLine = startLine;
      comment.endLine = endLine;
    }
  }

  /** The line that `offset` is on, counted from 1. 0 if there are no comments: nothing asks. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.lineStarts[mid] as number) <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  linesOfSpan(start: number, end: number): Lines {
    return new Lines(this.lineOf(start), this.lineOf(end));
  }

  list(list: List): number[] {
    return this.lists.slice(list.start, list.start + list.len);
  }

  listAt(list: List, i: number): number {
    return this.lists[list.start + i] as number;
  }

  newList(comments: number[]): List {
    const start = this.lists.length;
    for (let i = 0; i < comments.length; i++) this.lists.push(comments[i] as number);
    return new List(start, this.lists.length - start);
  }

  newRange(first: number, after: number): List {
    const start = this.lists.length;
    for (let i = first; i < after; i++) this.lists.push(i);
    return new List(start, this.lists.length - start);
  }

  /** `[...a, ...b]` */
  concat(a: List, b: List): List {
    if (a.isEmpty() || b.isEmpty()) return a.isEmpty() ? b : a;
    const start = this.lists.length;
    for (let i = 0; i < a.len; i++) this.lists.push(this.lists[a.start + i] as number);
    for (let i = 0; i < b.len; i++) this.lists.push(this.lists[b.start + i] as number);
    return new List(start, a.len + b.len);
  }

  /** Without the delimiters: the (start, end). */
  commentValue(id: number): Span {
    const c = this.comments[id] as Comment;
    return new Span(c.start + 2 > c.end ? c.end : c.start + 2, c.isBlock ? (c.end >= c.start + 4 ? c.end - 2 : c.start + 2) : c.end);
  }

  /** `declaration.specifiers` */
  specifiersOf(declaration: Declaration): number[] {
    return this.orders.slice(declaration.specifiersStart, declaration.specifiersStart + declaration.specifiersLen);
  }

  /** The new range of specifiers: (start, len). */
  newSpecifiers(specifiers: number[]): Span {
    const start = this.orders.length;
    for (let i = 0; i < specifiers.length; i++) this.orders.push(specifiers[i] as number);
    return new Span(start, this.orders.length - start);
  }

  /** `declaration.source.value` */
  sourceOf(declaration: Declaration): Uint8Array {
    return nameBytes(importSpec(declaration.import));
  }

  /** Where the module specifier of `imp`, the statement at `[start, end)`, is: into `Span`. */
  findSource(imp: number, start: number, end: number): Span {
    // Nearly always it is the last thing before the `;`, and has no escapes.
    const text = this.text;
    let e = end;
    if (e > start && (text[e - 1] | 0) === 59) e = e - 1;
    while (e > start) {
      const b = text[e - 1] | 0;
      if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) e = e - 1;
      else break;
    }
    if (e > start) {
      const quote = text[e - 1] | 0;
      if (quote === 34 || quote === 39) {
        const spec = nameBytes(importSpec(imp));
        const beforeEnd = e - 1;
        const valueStart = beforeEnd - spec.length;
        if (valueStart > start) {
          let same = true;
          for (let i = 0; i < spec.length; i++) {
            if ((text[valueStart + i] | 0) !== (spec[i] | 0)) {
              same = false;
              break;
            }
          }
          if (same && (text[valueStart - 1] | 0) === quote) return new Span(valueStart - 1, e);
        }
      }
    }
    const SP$ = SP;
    if (importSpecSpanOf(imp)) return new Span(SP$.s0 | 0, SP$.s1 | 0);
    return new Span(0, 0);
  }

  attachedOf(node: number): Attached | null {
    const kind = nodeKindOf(node);
    const payload = nodePayload(node);
    switch (kind) {
      case N_INTERPRETER:
        return this.interpreter === null ? null : this.interpreter.comments;
      case N_DIRECTIVE:
        return payload < this.directives.length ? (this.directives[payload] as Directive).comments : null;
      case N_IMPORT:
        return payload < this.declarations.length ? (this.declarations[payload] as Declaration).comments : null;
      case N_SPECIFIER:
        return payload < this.specifiers.length ? (this.specifiers[payload] as Specifier).comments : null;
      case N_EMPTY:
        return this.empty;
      default:
        return null;
    }
  }

  commentsOf(node: number, which: number): List {
    const kind = nodeKindOf(node);
    const NO_LIST$ = NO_LIST;
    if (kind === N_NEW_LINE || kind === N_NEW_LINE_LITERAL) return NO_LIST$;
    const attached = this.attachedOf(node);
    if (attached !== null) return attached.get(which);
    if (kind === N_INTERPRETER || kind === N_DIRECTIVE || kind === N_IMPORT || kind === N_SPECIFIER || kind === N_EMPTY) return NO_LIST$;
    for (let i = 0; i < this.deep.length; i++) {
      const d = this.deep[i] as Deep;
      if (d.node === node && d.which === which) return d.list;
    }
    return NO_LIST$;
  }

  /** Adds `list` at the end of the comments of `node`. */
  attach(node: number, which: number, list: List): void {
    if (list.isEmpty()) return;
    const all = this.concat(this.commentsOf(node, which), list);
    const attached = this.attachedOf(node);
    if (attached !== null) {
      attached.set(which, all);
      return;
    }
    for (let i = 0; i < this.deep.length; i++) {
      const d = this.deep[i] as Deep;
      if (d.node === node && d.which === which) {
        d.list = all;
        return;
      }
    }
    this.deep.push(new Deep(node, which, all));
  }

  group(first: number, after: number): Group | null {
    if (first >= after) return null;
    return new Group(
      skipWhitespaceBack(this.text, (this.comments[first] as Comment).start),
      skipWhitespace(this.text, (this.comments[after - 1] as Comment).end),
      first,
      after,
    );
  }

  /** The next group of comments that starts before `end`: comments with only whitespace between them. `cursor` is in `this.cursor`. */
  cursor: number = 0;
  nextGroupBefore(end: number): Group | null {
    const first = this.cursor;
    const firstComment = this.comments[first];
    if (firstComment === undefined || firstComment.start >= end) return null;
    let groupEnd = firstComment.end;
    this.cursor = this.cursor + 1;
    while (true) {
      const next = this.comments[this.cursor];
      if (next === undefined || next.start >= end || skipWhitespace(this.text, groupEnd) !== next.start) break;
      groupEnd = next.end;
      this.cursor = this.cursor + 1;
    }
    return this.group(first, this.cursor);
  }

  collectStatements(): void {
    this.cursor = 0;
    // What the comments after it trail.
    let previous = this.interpreter !== null ? mkNode(N_INTERPRETER, 0) : -1;
    let previousEnd = this.interpreter !== null ? this.interpreter.end : this.textStart();
    let isInPrologue = true;
    let hasSeenOther = false;
    const n = fileBodyLen();
    const bs = fileBodyStart();
    const NO_LIST$ = NO_LIST;
    const SP$ = SP;
    for (let i = 0; i < n; i++) {
      const statement = listAt(bs, i);
      stmtSpan(statement);
      const spanStart = SP$.s0 | 0;
      const spanEnd = SP$.s1 | 0;
      const group = this.nextGroupBefore(spanStart);
      const start = group === null ? skipWhitespace(this.text, previousEnd) : group.end;
      const between = group === null ? NO_LIST$ : this.newRange(group.first, group.after);
      if (previous >= 0) {
        this.attach(previous, WHICH_TRAILING, between);
        previous = -1;
      }
      const isDirective = stmtDirectiveSpan(statement);
      isInPrologue = isInPrologue && isDirective;
      if (!isInPrologue && this.firstStatement === null) this.firstStatement = new FirstStatement(start, between);
      if (start >= this.restStart) return;
      previousEnd = spanEnd;
      const tag = stmtTag(statement);
      if (tag === STMT_EXPR && isInPrologue) {
        const index = this.directives.length;
        exprSpan(stmtExprExpr(statement));
        this.directives.push(new Directive(spanStart, spanEnd, SP$.s0 | 0, SP$.s1 | 0));
        this.attach(mkNode(N_DIRECTIVE, index), WHICH_LEADING, between);
        while (true) {
          const g = this.nextGroupBefore(spanEnd);
          if (g === null) break;
          const list = this.newRange(g.first, g.after);
          this.attach(mkNode(N_DIRECTIVE_LITERAL, index), WHICH_TRAILING, list);
        }
        previous = mkNode(N_DIRECTIVE, index);
      } else if (tag === STMT_IMPORT) {
        this.isContiguous = this.isContiguous && !hasSeenOther;
        const index = this.addDeclaration(statement, stmtImportImport(statement));
        this.attach(mkNode(N_IMPORT, index), WHICH_LEADING, between);
        previous = mkNode(N_IMPORT, index);
      } else {
        hasSeenOther = true;
        while (this.cursor < this.comments.length && (this.comments[this.cursor] as Comment).start < spanEnd) this.cursor = this.cursor + 1;
      }
    }
    // At the end of the file.
    if (previous >= 0) {
      const list = this.newRange(this.cursor, this.comments.length);
      this.attach(previous, WHICH_TRAILING, list);
    }
  }

  addSpecifier(kind: number, isType: boolean, importedAtom: number, importedPos: number, localAtom: number, localPos: number, start: number, end: number): void {
    this.orders.push(this.specifiers.length);
    this.specifiers.push(new Specifier(kind, isType, importedAtom, importedPos, localAtom, localPos, start, end));
  }

  addDeclaration(statement: number, imp: number): number {
    stmtSpan(statement);
    const SP$ = SP;
    const start = SP$.s0 | 0;
    const end = SP$.s1 | 0;
    const index = this.declarations.length;
    const first = this.orders.length;
    const d = importDefault(imp);
    if (d >= 0) {
      const pos = importDefaultPos(imp);
      identSpan(d, pos);
      this.addSpecifier(SPEC_DEFAULT, false, d, pos, d, pos, SP$.s0 | 0, SP$.s1 | 0);
    }
    const ns = importNamespace(imp);
    if (ns >= 0 && importNamespaceSpan(imp)) {
      this.addSpecifier(SPEC_NAMESPACE, false, ns, importNamespacePos(imp), ns, importNamespacePos(imp), SP$.s0 | 0, SP$.s1 | 0);
    }
    const len = importNamedLen(imp);
    const ns0 = importNamedStart(imp);
    for (let k = 0; k < len; k++) {
      const named = listAt(ns0, k);
      importSpecSpan(named);
      this.addSpecifier(
        SPEC_NAMED,
        importSpecIsTypeOnly(named),
        importSpecImported(named),
        importSpecImportedPos(named),
        importSpecLocal(named),
        importSpecLocalPos(named),
        SP$.s0 | 0,
        SP$.s1 | 0,
      );
    }
    const declaration = new Declaration(imp);
    declaration.start = start;
    declaration.end = end;
    declaration.lines = this.linesOfSpan(start, end);
    declaration.isType = importIsTypeOnly(imp);
    declaration.specifiersStart = first;
    declaration.specifiersLen = this.orders.length - first;
    const source = this.findSource(imp, start, end);
    declaration.sourceStart = source.start;
    declaration.sourceEnd = source.end;
    const row = importAttributes(imp);
    declaration.hasAttributes = row >= 0 && importAttributesEntriesLen(row) > 0;
    this.declarations.push(declaration);
    while (true) {
      const group = this.nextGroupBefore(end);
      if (group === null) break;
      this.attachInDeclaration(index, group);
    }
    return index;
  }

  /** If `group` is right after or right before the node at `[start, end)`, it is attached to it. */
  attachIfAdjacent(node: number, start: number, end: number, group: Group, list: List): boolean {
    if (end === group.start) this.attach(node, WHICH_TRAILING, list);
    if (start === group.end) this.attach(node, WHICH_LEADING, list);
    return end === group.start || start === group.end;
  }

  /** Babel's `processComment` and `finalizeComment` for comments inside of an import. */
  attachInDeclaration(index: number, group: Group): void {
    this.hasCommentsInImports = true;
    const declaration = this.declarations[index] as Declaration;
    const list = this.newRange(group.first, group.after);
    let isAttached = false;

    // At first, specifiers are in the order of the source.
    const first = declaration.specifiersLen > 0 ? (this.orders[declaration.specifiersStart] as number) : 0;
    const count = declaration.specifiersLen;
    for (let at = first; at < first + count; at++) {
      const specifier = this.specifiers[at] as Specifier;
      const isIn = group.start > specifier.start && group.end < specifier.end;
      if (!isIn) {
        isAttached = this.attachIfAdjacent(mkNode(N_SPECIFIER, at), specifier.start, specifier.end, group, list) || isAttached;
        continue;
      }
      if (specifier.kind === SPEC_NAMED) {
        const im = specifier.importedSpan();
        let a = this.attachIfAdjacent(mkNode(N_IMPORTED, at), im.start, im.end, group, list);
        if (specifier.isRenamed()) {
          const lo = specifier.localSpan();
          const b = this.attachIfAdjacent(mkNode(N_LOCAL, at), lo.start, lo.end, group, list);
          a = a || b;
        }
        isAttached = a;
      } else {
        const lo = specifier.localSpan();
        isAttached = this.attachIfAdjacent(mkNode(N_LOCAL, at), lo.start, lo.end, group, list);
      }
      if (!isAttached) this.attach(mkNode(N_SPECIFIER, at), WHICH_INNER, list);
      return;
    }
    const sourceStart = declaration.sourceStart;
    const sourceEnd = declaration.sourceEnd;
    isAttached = this.attachIfAdjacent(mkNode(N_SOURCE, sourceStart), sourceStart, sourceEnd, group, list) || isAttached;
    const row = importAttributes(declaration.import);
    const SP$ = SP;
    if (row >= 0) {
      const entries = importAttributesEntriesLen(row);
      const es = importAttributesEntriesStart(row);
      for (let k = 0; k < entries; k++) {
        const attribute = listAt(es, k);
        propSpan(attribute);
        const aStart = SP$.s0 | 0;
        const aEnd = SP$.s1 | 0;
        const isIn = group.start > aStart && group.end < aEnd;
        if (!isIn) {
          isAttached = this.attachIfAdjacent(mkNode(N_ATTRIBUTE, aStart), aStart, aEnd, group, list) || isAttached;
          continue;
        }
        const key = attributeKeySpan(attribute);
        const v = propValue(attribute);
        let value: Span | null = null;
        if (v >= 0) {
          exprSpan(v);
          value = new Span(SP$.s0 | 0, SP$.s1 | 0);
        }
        let a = false;
        if (key !== null) a = this.attachIfAdjacent(mkNode(N_ATTRIBUTE_KEY, aStart), key.start, key.end, group, list);
        let b = false;
        if (value !== null) b = this.attachIfAdjacent(mkNode(N_ATTRIBUTE_VALUE, aStart), value.start, value.end, group, list);
        isAttached = a || b;
        if (!isAttached) this.attach(mkNode(N_ATTRIBUTE, aStart), WHICH_INNER, list);
        return;
      }
    }
    if (isAttached) return;
    // `adjustInnerComments`
    const isAfterComma = group.start >= 1 && (this.text[group.start - 1] | 0) === 44;
    if (count > 0 && isAfterComma && (this.specifiers[first + count - 1] as Specifier).start <= group.start) {
      this.attach(mkNode(N_SPECIFIER, first + count - 1), WHICH_TRAILING, list);
    } else {
      this.attach(mkNode(N_IMPORT, index), WHICH_INNER, list);
    }
  }

  /** `node.start` and `node.end`: null if it has none. */
  span(node: number): Span | null {
    const kind = nodeKindOf(node);
    const payload = nodePayload(node);
    const SP$ = SP;
    switch (kind) {
      case N_INTERPRETER:
        return this.interpreter === null ? null : new Span(this.interpreter.start, this.interpreter.end);
      case N_DIRECTIVE: {
        const d = this.directives[payload] as Directive;
        return new Span(d.start, d.end);
      }
      case N_DIRECTIVE_LITERAL: {
        const d = this.directives[payload] as Directive;
        return new Span(d.literalStart, d.literalEnd);
      }
      case N_IMPORT: {
        const d = this.declarations[payload] as Declaration;
        return d.hasSpan ? new Span(d.start, d.end) : null;
      }
      case N_SPECIFIER: {
        const s = this.specifiers[payload] as Specifier;
        return new Span(s.start, s.end);
      }
      case N_IMPORTED:
        return (this.specifiers[payload] as Specifier).importedSpan();
      case N_LOCAL:
        return (this.specifiers[payload] as Specifier).localSpan();
      case N_SOURCE:
        return new Span(payload, payload + tokenLen(this.text, this.text.length, payload));
      case N_ATTRIBUTE: {
        const p = this.attributeAt(payload);
        if (p < 0) return null;
        propSpan(p);
        return new Span(SP$.s0 | 0, SP$.s1 | 0);
      }
      case N_ATTRIBUTE_KEY: {
        const p = this.attributeAt(payload);
        return p < 0 ? null : attributeKeySpan(p);
      }
      case N_ATTRIBUTE_VALUE: {
        const p = this.attributeAt(payload);
        if (p < 0) return null;
        const v = propValue(p);
        if (v < 0) return null;
        exprSpan(v);
        return new Span(SP$.s0 | 0, SP$.s1 | 0);
      }
      default:
        return null;
    }
  }

  /** `node.loc` */
  lines(node: number): Lines | null {
    const kind = nodeKindOf(node);
    if (kind === N_IMPORT) {
      const d = this.declarations[nodePayload(node)] as Declaration;
      return d.hasLines ? d.lines : null;
    }
    if (kind === N_EMPTY) return new Lines(0, 0);
    const s = this.span(node);
    return s === null ? null : this.linesOfSpan(s.start, s.end);
  }

  /** The attribute (a Prop) that starts at `start`, or -1. */
  attributeAt(start: number): number {
    const SP$ = SP;
    for (let i = 0; i < this.declarations.length; i++) {
      const d = this.declarations[i] as Declaration;
      if (!(d.hasSpan && d.start <= start && start < d.end)) continue;
      const row = importAttributes(d.import);
      if (row < 0) return -1;
      const entries = importAttributesEntriesLen(row);
      const es = importAttributesEntriesStart(row);
      for (let k = 0; k < entries; k++) {
        const p = listAt(es, k);
        propSpan(p);
        if ((SP$.s0 | 0) === start) return p;
      }
      return -1;
    }
    return -1;
  }
}

/** The span of the key of an import attribute, if it is a string or a name. */
export function attributeKeySpan(attribute: number): Span | null {
  const owner = nodeOfProp(attribute);
  const kind = keyKind(owner);
  if (kind !== KEY_STRING && kind !== KEY_IDENT) return null;
  if (!keySpan(owner)) return null;
  const SP$ = SP;
  return new Span(SP$.s0 | 0, SP$.s1 | 0);
}
