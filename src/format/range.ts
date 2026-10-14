// Port of vendor/bun/src/format/range.rs: `rangeStart` and `rangeEnd`: only the statements that a range of the text touches are formatted.
//
// This is Prettier's `formatRange` (`src/main/core.js`) and `calculateRange` (`src/main/range.js`). The range is widened to whole statements,
// their text is parsed and formatted as a file of its own, indented like the line that it starts on, and put back.
//
//   formatWithCursor(text, options, out, parse): FORMAT_* code
//
// `text`: the source of the file that was parsed last (parseFile + fileBegin). `parse(slice)`: called at most once, with a part of the text.
// It has to parse that like the file was parsed (the same name, `isScript`, ..), do `fileBegin`, and return whether it could. The cursor
// (`options.cursorOffset`) is not placed: TODO(port) cursor.ts.
import { ByteBuf } from "../base/bytebuf.ts";
import { byteOffsetOfUtf16, utf16Len } from "../base/utf8.ts";
import { I32Vec } from "../base/i32vec.ts";
import { FORMAT_OK, FORMAT_SYNTAX_ERROR } from "./errors.ts";
import { FormatOptions, LINE_ENDING_LF, resolveLineEnding } from "./options.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "./text.ts";
import {
  BODY_BLOCK,
  FN_STATIC_BLOCK,
  N_FUNC,
  N_STMT,
  NODE_FILE,
  SP,
  STMT_CLASS,
  STMT_ENUM,
  STMT_IMPORT,
  STMT_EXPORT_DEFAULT,
  STMT_EXPORT_NAMED,
  STMT_IMPORT_EQUALS,
  STMT_INTERFACE,
  STMT_MODULE,
  STMT_TYPE_ALIAS,
  STMT_VAR,
  fileBodyLen,
  fileBodyStart,
  fileHasParseErrors,
  fileHasBom,
  fileIsJavascript,
  funcBodyKind,
  funcKind,
  funcOwner,
  listAt,
  nodeChildren,
  nodeId,
  nodeKind,
  nodeOfStmt,
  nodeSpan,
  classModifiersLen,
  classModifiersStart,
  modifierDecorator,
  classOwner,
  stmtClassClass,
  stmtIsExported,
  stmtTag,
} from "../lint/ast/index.ts";
import { I32Vec as SemaVec } from "../sema/vec.ts";
import {
  AN_BREAK_STATEMENT,
  AN_CONTINUE_STATEMENT,
  AN_DEBUGGER_STATEMENT,
  AN_DECORATOR,
  AN_DIRECTIVE,
  AN_DO_WHILE_STATEMENT,
  AN_EXPORT_ALL_DECLARATION,
  AN_EXPORT_DEFAULT_DECLARATION,
  AN_EXPORT_NAMED_DECLARATION,
  AN_EXPRESSION_STATEMENT,
  AN_FOR_IN_STATEMENT,
  AN_FOR_OF_STATEMENT,
  AN_FOR_STATEMENT,
  AN_FUNCTION,
  AN_FUNCTION_BODY,
  AN_IF_STATEMENT,
  AN_IMPORT_DECLARATION,
  AN_LABELED_STATEMENT,
  AN_PROGRAM,
  AN_RETURN_STATEMENT,
  AN_THROW_STATEMENT,
  AN_TS_CALL_SIGNATURE_DECLARATION,
  AN_TS_CONSTRUCT_SIGNATURE_DECLARATION,
  AN_TS_ENUM_DECLARATION,
  AN_TS_EXPORT_ASSIGNMENT,
  AN_TS_GLOBAL_DECLARATION,
  AN_TS_IMPORT_EQUALS_DECLARATION,
  AN_TS_INTERFACE_DECLARATION,
  AN_TS_MODULE_DECLARATION,
  AN_TS_NAMESPACE_EXPORT_DECLARATION,
  AN_TS_TYPE_ALIAS_DECLARATION,
  AN_TS_TYPE_PARAMETER_DECLARATION_FUNC,
  AN_TS_TYPE_PARAMETER_DECLARATION_CLASS,
  AN_TS_TYPE_PARAMETER_DECLARATION_STMT,
  AN_TS_TYPE_PARAMETER_DECLARATION_TYPE,
  AN_VARIABLE_DECLARATION,
  AN_WHILE_STATEMENT,
  AN_WITH_STATEMENT,
  AN_BLOCK_STATEMENT,
  AN_EMPTY_STATEMENT,
  AN_SWITCH_STATEMENT,
  AN_TRY_STATEMENT,
  AN_CLASS,
  AN_ARROW_BODY_EXPRESSION_STATEMENT,
  AN_CHAIN_EXPRESSION,
  AN_FORMAL_PARAMETERS,
  anId,
  anParent,
  anSpan,
  anTag,
  mkAn,
  mkTypeParametersAn,
  nodeAsAstNodes,
  typeParametersOf,
  TL,
} from "./js/ast_nodes.ts";
import { Comments, collectComments } from "./js/comments.ts";
import { endsBeforeSemicolon } from "./js/print/program.ts";
import { isNoSourceElement } from "./js/print/flow.ts";
import { cursorResult, formatWith } from "./cursor.ts";

/** `parse(slice)`: see the head of this file. */
export type ParseSlice = (slice: Uint8Array) => boolean;

const BOM_LEN = 3;

function startsWithBom(text: Uint8Array): boolean {
  return text.length >= 3 && (text[0] | 0) === 0xef && (text[1] | 0) === 0xbb && (text[2] | 0) === 0xbf;
}

const formatted = new ByteBuf(1024);
const whole = new ByteBuf(1024);

/**
 * Appends to `out` the text of the file with what `options.rangeStart` and `options.rangeEnd` select formatted. That is all of it if neither
 * is set. Returns a `FORMAT_*` code.
 */
export function formatWithCursor(text: Uint8Array, options: FormatOptions, out: ByteBuf, parse: ParseSlice | null): number {
  const cursorResult$ = cursorResult;
  cursorResult$.value = -1;
  if (options.isMdxEsSyntax && !allImportsOrExports()) return FORMAT_SYNTAX_ERROR;
  const first = startsWithBom(text) ? BOM_LEN : 0;
  offsets(text, first, options);
  const start0 = OFFSETS[0] | 0;
  const end0 = OFFSETS[1] | 0;
  if (start0 >= end0 && text.length > first) {
    out.append(text, 0, text.length);
    cursorResult$.value = options.cursorOffset;
    return FORMAT_OK;
  }
  if (start0 <= first && end0 >= text.length) return formatWith(text, options, out, 0);
  if (fileHasParseErrors() || parse === null) return FORMAT_SYNTAX_ERROR;

  let rangeStart = first;
  let rangeEnd = first;
  if (calculateRange(text, options.flavor, start0, end0)) {
    rangeStart = RANGE[0] | 0;
    rangeEnd = RANGE[1] | 0;
  }
  // Everything is put together with `\n`, which is replaced at the end.
  const lineEnding = resolveLineEnding(options.lineEnding, text.subarray(first));
  const formatted$ = formatted;
  formatted$.reset();
  const cursor = OFFSETS[2] | 0;
  // Where the cursor is in `formatted`, if it is in the range.
  let cursorInFormatted = -1;
  if (trimJsWhitespaceStart(text, rangeStart, rangeEnd) < rangeEnd) {
    const alignment = alignmentSize(text, first, rangeStart, options.indentWidth);
    const sliceOptions = options.copy();
    sliceOptions.rangeStart = -1;
    sliceOptions.rangeEnd = -1;
    sliceOptions.cursorOffset = cursor >= 0 && rangeStart < cursor && cursor <= rangeEnd ? utf16Len(text, rangeStart, cursor) : -1;
    sliceOptions.lineEnding = LINE_ENDING_LF;
    // The text of the slice is copied: the parse of the slice replaces the HIR, and the text of the file is not the HIR's.
    const slice = text.slice(rangeStart, rangeEnd);
    if (!parse(slice)) return FORMAT_SYNTAX_ERROR;
    const code = formatWith(slice, sliceOptions, formatted$, alignment);
    if (code !== FORMAT_OK) return code;
    if (cursorResult$.value >= 0 && cursorResult$.value <= utf16Len(formatted$.data, 0, formatted$.len)) {
      cursorInFormatted = byteOffsetOfUtf16(formatted$.data, 0, formatted$.len, cursorResult$.value);
    }
    formatted$.len = trimJsWhitespaceEnd(formatted$.data, 0, formatted$.len);
  }
  const whole$ = whole;
  whole$.reset();
  let cursorInWhole = -1;
  writeWithLineEnding(text, 0, rangeStart, LINE_ENDING_LF, whole$);
  if (cursor >= 0 && cursor <= rangeStart) cursorInWhole = whole$.len - normalizedLen(text, cursor, rangeStart);
  if (cursorInFormatted >= 0) cursorInWhole = whole$.len + cursorInFormatted;
  whole$.append(formatted$.data, 0, formatted$.len);
  if (cursor >= 0 && cursor > rangeEnd) cursorInWhole = whole$.len + normalizedLen(text, rangeEnd, cursor);
  writeWithLineEnding(text, rangeEnd, text.length, LINE_ENDING_LF, whole$);
  if (cursorInWhole > whole$.len) cursorInWhole = whole$.len;
  const upTo = cursorInWhole >= 0 ? cursorInWhole : 0;
  const outStart = out.len;
  writeWithLineEnding(whole$.data, 0, upTo, lineEnding, out);
  cursorResult$.value = cursorInWhole >= 0 ? utf16Len(out.data, outStart, out.len) : -1;
  writeWithLineEnding(whole$.data, upTo, whole$.len, lineEnding, out);
  return FORMAT_OK;
}

/** How long `text[start, end)` is after each `\r\n` in it has become `\n`. */
function normalizedLen(text: Uint8Array, start: number, end: number): number {
  let n = end - start;
  for (let i = start; i + 1 < end; i++) if ((text[i] | 0) === 13 && (text[i + 1] | 0) === 10) n = n - 1;
  return n;
}

function allImportsOrExports(): boolean {
  const s = fileBodyStart();
  const n = fileBodyLen();
  for (let i = 0; i < n; i++) {
    const st = listAt(s, i);
    const t = stmtTag(st);
    if (!(stmtIsExported(st) || t === STMT_IMPORT || t === STMT_EXPORT_NAMED || t === STMT_EXPORT_DEFAULT)) return false;
  }
  return true;
}

/** The result of `offsets`: `rangeStart`, `rangeEnd` and `cursorOffset` as byte offsets in the text (the last: -1 for none). */
const OFFSETS = new Int32Array(3);
/** The range that `calculateRange` found: `[start, end)` (tests). */
export const RANGE = new Int32Array(2);

/** `rangeStart`, `rangeEnd` and `cursorOffset`, which count UTF-16 code units, as offsets in the text. Prettier's `normalizeInputAndOptions`. */
function offsets(text: Uint8Array, first: number, options: FormatOptions): void {
  OFFSETS[0] = offsetOf(text, first, options.rangeStart, first);
  OFFSETS[1] = offsetOf(text, first, options.rangeEnd, text.length);
  OFFSETS[2] = offsetOf(text, first, options.cursorOffset, -1);
}

/** An offset before the byte order mark or behind the end is as good as none. */
function offsetOf(text: Uint8Array, first: number, index: number, dflt: number): number {
  if (index < 0) return dflt;
  if (index > utf16Len(text, 0, text.length)) return dflt;
  let at = byteOffsetOfUtf16(text, 0, text.length, index);
  // After `\r\n` has become `\n`, an offset between the two is behind it.
  if (at >= 1 && at < text.length && (text[at - 1] | 0) === 13 && (text[at] | 0) === 10) at = at + 1;
  return at >= first ? at : dflt;
}

/** Prettier's `getAlignmentSize` of the white space that the last line of text[first, end) starts with. */
export function alignmentSize(text: Uint8Array, first: number, end: number, tabWidth0: number): number {
  let lineStart = first;
  for (let i = end - 1; i >= first; i--) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) {
      lineStart = i + 1;
      break;
    }
  }
  const tabWidth = tabWidth0 > 1 ? tabWidth0 : 1;
  let size = 0;
  let at = lineStart;
  while (at < end) {
    const b = text[at] | 0;
    let len = 0;
    if (b === 32 || (b >= 9 && b <= 13)) len = 1;
    else len = jsWhiteSpaceLenAt(text, at, end);
    if (len === 0) return size;
    size = b === 9 ? size + tabWidth - (size % tabWidth) : size + 1;
    at = at + len;
  }
  return size;
}

function jsWhiteSpaceLenAt(text: Uint8Array, at: number, end: number): number {
  const b = text[at] | 0;
  if (b < 0x80) return 0;
  // Other white space (NBSP, ..): one column.
  if (b === 0xc2 && at + 1 < end && (text[at + 1] | 0) === 0xa0) return 2;
  if (b === 0xe2 && at + 2 < end && (text[at + 1] | 0) === 0x80) {
    const b2 = text[at + 2] | 0;
    if ((b2 >= 0x80 && b2 <= 0x8a) || b2 === 0xa8 || b2 === 0xa9 || b2 === 0xaf) return 3;
  }
  if (b === 0xef && at + 2 < end && (text[at + 1] | 0) === 0xbb && (text[at + 2] | 0) === 0xbf) return 3;
  return 0;
}

/** Appends text[start, end) with each `\r\n`, `\r` and `\n` replaced by `lineEnding` (a `LINE_ENDING_*`). */
export function writeWithLineEnding(text: Uint8Array, start: number, end: number, lineEnding: number, out: ByteBuf): void {
  let i = start;
  let runStart = start;
  while (i < end) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) {
      out.append(text, runStart, i);
      if (lineEnding === 1) {
        out.push(13);
        out.push(10);
      } else if (lineEnding === 2) out.push(13);
      else out.push(10);
      i = b === 13 && i + 1 < end && (text[i + 1] | 0) === 10 ? i + 2 : i + 1;
      runStart = i;
    } else i = i + 1;
  }
  out.append(text, runStart, end);
}

// ───────────────────────────── calculate_range ─────────────────────────────

const EDGE_START = 0;
const EDGE_END = 1;

/** Whether a node at `(start, end)` is looked at for `offset`. A range does not start in a node that ends there, and does not end in one that starts there. */
function edgeIsIn(edge: number, offset: number, start: number, end: number): boolean {
  return edge === EDGE_START ? start <= offset && offset < end : start < offset && offset <= end;
}

/** Prettier's `locStart`: with the decorators before it. */
function locStart(node: number): number {
  let cls = -1;
  switch (anTag(node)) {
    // Babel's `Program` starts where the text does, that of typescript-estree at the first token.
    case AN_PROGRAM: {
      const first = fileHasBom() ? BOM_LEN : 0;
      if (fileIsJavascript()) return first;
      if (fileBodyLen() > 0) return locStart(nodeAsAstNodes(nodeOfStmt(listAt(fileBodyStart(), 0))));
      anSpan(node);
      return SP[1] | 0;
    }
    case AN_CLASS:
      cls = anId(node);
      break;
    case AN_EXPORT_NAMED_DECLARATION:
    case AN_EXPORT_DEFAULT_DECLARATION:
      cls = exportedClass(anId(node));
      break;
    default:
      break;
  }
  anSpan(node);
  const start = SP[0] | 0;
  if (cls >= 0) {
    const s = classModifiersStart(cls);
    const n = classModifiersLen(cls);
    for (let i = 0; i < n; i++) {
      const d = modifierDecorator(listAt(s, i));
      if (d >= 0) {
        anSpan(mkAn(AN_DECORATOR, d));
        return start < (SP[0] | 0) ? start : SP[0] | 0;
      }
    }
  }
  return start;
}

function exportedClass(stmt: number): number {
  return isClassStmt(stmt) ? stmtClassClass(stmt) : -1;
}

function isClassStmt(stmt: number): boolean {
  return stmtTag(stmt) === STMT_CLASS;
}

function fullSpanEnd(node: number): number {
  anSpan(node);
  return SP[1] | 0;
}

/** Prettier's `locEnd`: a statement ends before its `;`. */
function locEnd(node: number, cm: Comments): number {
  anSpan(node);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  let endsBeforeSemi = false;
  const id = anId(node);
  switch (anTag(node)) {
    case AN_EXPORT_NAMED_DECLARATION:
    case AN_EXPORT_DEFAULT_DECLARATION:
    case AN_EXPORT_ALL_DECLARATION:
      endsBeforeSemi = true;
      break;
    case AN_EXPRESSION_STATEMENT:
    case AN_DIRECTIVE:
    case AN_IMPORT_DECLARATION:
    case AN_RETURN_STATEMENT:
    case AN_THROW_STATEMENT:
    case AN_DO_WHILE_STATEMENT:
    case AN_BREAK_STATEMENT:
    case AN_CONTINUE_STATEMENT:
    case AN_DEBUGGER_STATEMENT:
    case AN_VARIABLE_DECLARATION:
    case AN_IF_STATEMENT:
    case AN_FOR_STATEMENT:
    case AN_FOR_IN_STATEMENT:
    case AN_FOR_OF_STATEMENT:
    case AN_WHILE_STATEMENT:
    case AN_WITH_STATEMENT:
    case AN_LABELED_STATEMENT:
      endsBeforeSemi = endsBeforeSemicolon(id);
      break;
    default:
      break;
  }
  return endsBeforeSemi ? cm.withoutSemicolon(start, end) : end;
}

/**
 * Prettier's `isJsSourceElement`: the name of the node in ESTree is `Directive`, `TSExportAssignment`, starts with `TSDeclare`, or ends with
 * `Statement` or `Declaration`.
 */
function isSourceElement(node: number): boolean {
  if (isNoSourceElement(node)) return false;
  const id = anId(node);
  switch (anTag(node)) {
    case AN_DIRECTIVE:
    case AN_BLOCK_STATEMENT:
    case AN_EMPTY_STATEMENT:
    case AN_DEBUGGER_STATEMENT:
    case AN_VARIABLE_DECLARATION:
    case AN_RETURN_STATEMENT:
    case AN_IF_STATEMENT:
    case AN_FOR_STATEMENT:
    case AN_FOR_IN_STATEMENT:
    case AN_FOR_OF_STATEMENT:
    case AN_WHILE_STATEMENT:
    case AN_DO_WHILE_STATEMENT:
    case AN_WITH_STATEMENT:
    case AN_SWITCH_STATEMENT:
    case AN_TRY_STATEMENT:
    case AN_THROW_STATEMENT:
    case AN_BREAK_STATEMENT:
    case AN_CONTINUE_STATEMENT:
    case AN_LABELED_STATEMENT:
    case AN_IMPORT_DECLARATION:
    case AN_EXPORT_ALL_DECLARATION:
    case AN_EXPORT_NAMED_DECLARATION:
    case AN_EXPORT_DEFAULT_DECLARATION:
    case AN_TS_INTERFACE_DECLARATION:
    case AN_TS_TYPE_ALIAS_DECLARATION:
    case AN_TS_ENUM_DECLARATION:
    case AN_TS_MODULE_DECLARATION:
    case AN_TS_GLOBAL_DECLARATION:
    case AN_TS_IMPORT_EQUALS_DECLARATION:
    case AN_TS_EXPORT_ASSIGNMENT:
    case AN_TS_NAMESPACE_EXPORT_DECLARATION:
    case AN_TS_CALL_SIGNATURE_DECLARATION:
    case AN_TS_CONSTRUCT_SIGNATURE_DECLARATION:
    case AN_TS_TYPE_PARAMETER_DECLARATION_FUNC:
    case AN_TS_TYPE_PARAMETER_DECLARATION_CLASS:
    case AN_TS_TYPE_PARAMETER_DECLARATION_STMT:
    case AN_TS_TYPE_PARAMETER_DECLARATION_TYPE:
    case AN_EXPRESSION_STATEMENT:
      return true;
    case AN_FUNCTION:
      return nodeKind(funcOwner(id)) === N_STMT;
    case AN_CLASS:
      return nodeKind(classOwner(id)) === N_STMT;
    // The `BlockStatement` that is the body of a function.
    case AN_FUNCTION_BODY:
      return funcBodyKind(id) === BODY_BLOCK && funcKind(id) !== FN_STATIC_BLOCK;
    default:
      return false;
  }
}

/** Whether ESTree has the node, and Prettier attaches comments to it. */
function isInEstree(node: number): boolean {
  switch (anTag(node)) {
    case AN_PROGRAM:
    case AN_FORMAL_PARAMETERS:
    case AN_CHAIN_EXPRESSION:
    case AN_ARROW_BODY_EXPRESSION_STATEMENT:
      return false;
    case AN_FUNCTION_BODY:
      return funcBodyKind(anId(node)) === BODY_BLOCK;
    default:
      return true;
  }
}

/** The declaration in `export` and the declaration `statement`: an `AstNodes`, or -1. */
function exportedDeclaration(stmt: number): number {
  if (!stmtIsExported(stmt)) return -1;
  switch (stmtTag(stmt)) {
    case STMT_VAR:
      return mkAn(AN_VARIABLE_DECLARATION, stmt);
    case STMT_INTERFACE:
      return mkAn(AN_TS_INTERFACE_DECLARATION, stmt);
    case STMT_TYPE_ALIAS:
      return mkAn(AN_TS_TYPE_ALIAS_DECLARATION, stmt);
    case STMT_ENUM:
      return mkAn(AN_TS_ENUM_DECLARATION, stmt);
    case STMT_MODULE:
      return mkAn(AN_TS_MODULE_DECLARATION, stmt);
    case STMT_IMPORT_EQUALS:
      return mkAn(AN_TS_IMPORT_EQUALS_DECLARATION, stmt);
    default:
      return -1;
  }
}

const kids = new SemaVec(32);

/**
 * Prettier's `findNodeAtOffset`: the innermost statement or declaration that `offset` is in, and what that is in, from the inside out,
 * without the file. Fills `path` (appends `AstNodes`; the first is the innermost) and returns whether there is one.
 */
function findNodeAtOffset(offset: number, edge: number, path: I32Vec): boolean {
  // Siblings do not overlap, so there is one way down.
  let innermost = NODE_FILE;
  const kids$ = kids;
  while (true) {
    const base = kids$.len;
    nodeChildren(innermost, -1, kids$);
    let next = -1;
    for (let i = base; i < kids$.len; i++) {
      const child = kids$.data[i] | 0;
      nodeSpan(child);
      let s = SP[0] | 0;
      let e = SP[1] | 0;
      const an = nodeAsAstNodes(child);
      const fs = locStart(an);
      const fe = fullSpanEnd(an);
      if (fs < s) s = fs;
      if (fe > e) e = fe;
      if (next < 0 && edgeIsIn(edge, offset, s, e)) next = child;
    }
    kids$.len = base;
    if (next >= 0) innermost = next;
    else break;
  }

  // The nodes of ESTree that are not nodes of their own here.
  let inner = -1;
  if (nodeKind(innermost) === N_FUNC) inner = mkAn(AN_FUNCTION_BODY, nodeId(innermost));
  else if (nodeKind(innermost) === N_STMT) inner = exportedDeclaration(nodeId(innermost));
  let typeParameters = -1;
  if (typeParametersOf(innermost) && (TL[1] | 0) > 0) typeParameters = mkTypeParametersAn(innermost);
  const candidates = scratchCandidates;
  candidates.reset();
  if (typeParameters >= 0) candidates.push(typeParameters);
  if (inner >= 0) candidates.push(inner);
  let a = nodeAsAstNodes(innermost);
  while (true) {
    candidates.push(a);
    if (anTag(a) === AN_PROGRAM) break;
    a = anParent(a);
  }
  let found = false;
  for (let i = 0; i < candidates.len; i++) {
    const node = candidates.data[i] | 0;
    if (!isInEstree(node)) continue;
    const s = locStart(node);
    const e = fullSpanEnd(node);
    if (!edgeIsIn(edge, offset, s, e)) continue;
    if (!found) {
      if (isSourceElement(node)) {
        found = true;
        path.push(node);
      }
    } else path.push(node);
  }
  return found;
}
const scratchCandidates = new I32Vec(32);
const startPath = new I32Vec(16);
const endPath = new I32Vec(16);

/** Prettier's `findSiblingAncestors`: widens two nodes as long as each stays within the other's side of the range. Writes `RANGE`. */
function findSiblingAncestors(startP: I32Vec, endP: I32Vec, cm: Comments): boolean {
  if (startP.len === 0 || endP.len === 0) return false;
  let startNode = startP.data[0] | 0;
  let endNode = endP.data[0] | 0;
  const root = mkAn(AN_PROGRAM, 0);
  if (startNode === endNode) {
    RANGE[0] = locStart(startNode);
    RANGE[1] = locStart(endNode);
    return finishRange(startNode, endNode);
  }
  // Prettier's `dropRootParents` only leaves out the file if there is anything else.
  const startAncestors = startP.len > 1 ? 1 : -1;
  const endAncestors = endP.len > 1 ? 1 : -1;

  const start = locStart(startNode);
  // end_ancestors.iter().take_while(|it| loc_start(it) >= start).last()
  if (endAncestors < 0) {
    if (locStart(root) >= start) endNode = root;
  } else {
    let last = -1;
    for (let i = endAncestors; i < endP.len; i++) {
      const n = endP.data[i] | 0;
      if (locStart(n) >= start) last = n;
      else break;
    }
    if (last >= 0) endNode = last;
  }
  const end = locEnd(endNode, cm);
  if (startAncestors < 0) {
    if (locEnd(root, cm) <= end) startNode = root;
  } else {
    for (let i = startAncestors; i < startP.len; i++) {
      const n = startP.data[i] | 0;
      if (locEnd(n, cm) > end) break;
      startNode = n;
      if (startNode === endNode) break;
    }
  }
  return finishRange(startNode, endNode);
}

function finishRange(startNode: number, endNode: number): boolean {
  const ls = locStart(startNode);
  const le = locStart(endNode);
  anSpan(startNode);
  const se = SP[1] | 0;
  anSpan(endNode);
  const ee = SP[1] | 0;
  RANGE[0] = ls < le ? ls : le;
  RANGE[1] = se > ee ? se : ee;
  return true;
}

const rangeComments = new Comments();

/** Prettier's `calculateRange`: what to format so that everything from `start0` to `end0` is. Writes `RANGE`. */
function calculateRange(text: Uint8Array, flavor: number, start0: number, end0: number): boolean {
  let start = start0;
  let end = end0;
  // The range is narrowed so that it starts and ends with something.
  if (start > end || end > text.length) return false;
  const trimmed = trimJsWhitespaceStart(text, start, end);
  const isAllWhiteSpace = trimmed >= end;
  if (!isAllWhiteSpace) {
    start = trimmed;
    end = trimJsWhitespaceEnd(text, start, end);
  }
  const startPath$ = startPath;
  startPath$.reset();
  if (!findNodeAtOffset(start, EDGE_START, startPath$)) return false;
  const endPath$ = endPath;
  endPath$.reset();
  if (isAllWhiteSpace) {
    for (let i = 0; i < startPath$.len; i++) endPath$.push(startPath$.data[i] | 0);
  } else if (!findNodeAtOffset(end, EDGE_END, endPath$)) return false;
  const rangeComments$ = rangeComments;
  collectComments(rangeComments$, text, flavor, fileIsJavascript());
  return findSiblingAncestors(startPath$, endPath$, rangeComments$);
}
