// Port of vendor/bun/src/format/js/sort_imports/layout.rs: whether a file is as a plugin leaves it, as far as the formatter can tell.
//
// A plugin prints every import anew, on one line, and with other empty lines than there were. Most of the time the formatter undoes all of
// that: the imports were sorted before. Then the file does not have to be parsed again.
import {
  SP,
  importAttributes,
  importAttributesBracesSpan,
  importAttributesEntriesLen,
  importAttributesEntriesStart,
  listAt,
  propSpan,
  tokenLen,
} from "../../../lint/ast/index.ts";
import { Declaration, Model } from "./babel.ts";
import { PIECE_COMMENT, PIECE_DIRECTIVE, PIECE_IMPORT, PIECE_INTERPRETER, Piece } from "./generator.ts";
import { hasLineBreakIn, isAsciiBlank, sameBytes } from "./util.ts";

/** -1 if `text[from..to)` is not whitespace; else how what is on both sides of it is laid out: on one line (0), on two lines (1), or with an empty line between (2). */
function gap(text: Uint8Array, from: number, to: number): number {
  if (from > to || to > text.length) return -1;
  let breaks = 0;
  for (let i = from; i < to; i++) {
    const b = text[i] | 0;
    if (!(b === 32 || b === 9 || b === 10 || b === 13)) return -1;
    if (b === 10) breaks = breaks + 1;
    else if (b === 13 && !(i + 1 < to && (text[i + 1] | 0) === 10)) breaks = breaks + 1;
  }
  return breaks < 2 ? breaks : 2;
}

/** Whether the imports `written` and `printed` have the same tokens, but for a `,` before a `}` and a `;` at the end. There are no comments in them. */
function hasSameTokens(text: Uint8Array, ws0: number, we: number, printed: Uint8Array, ps0: number, pe: number): boolean {
  let ws = ws0;
  let ps = ps0;
  while (ws < we && isAsciiBlank(text[ws] | 0)) ws = ws + 1;
  while (ps < pe && isAsciiBlank(printed[ps] | 0)) ps = ps + 1;
  while (true) {
    const wEmpty = ws >= we;
    const pEmpty = ps >= pe;
    if (wEmpty && (pEmpty || (ps + 1 === pe && (printed[ps] | 0) === 59))) return true;
    if (wEmpty || pEmpty) {
      if (wEmpty) return false;
    }
    const a = text[ws] | 0;
    const b = pEmpty ? -1 : printed[ps] | 0;
    if ((a === 34 || a === 39) && !pEmpty && a === b) {
      const len = tokenLen(text, we, ws);
      if (ws + len > we || ps + len > pe) return false;
      if (!sameBytes(text, ws, ws + len, printed, ps, ps + len)) return false;
      ws = ws + len;
      ps = ps + len;
    } else if (!pEmpty && a === b) {
      ws = ws + 1;
      ps = ps + 1;
    } else if (a === 44 && !pEmpty && b === 125) {
      let r = ws + 1;
      while (r < we && isAsciiBlank(text[r] | 0)) r = r + 1;
      if (r < we && (text[r] | 0) === 125) ws = ws + 1;
      else return false;
    } else {
      return false;
    }
    while (ws < we && isAsciiBlank(text[ws] | 0)) ws = ws + 1;
    while (ps < pe && isAsciiBlank(printed[ps] | 0)) ps = ps + 1;
  }
}

class Statement {
  kind: number;
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

/**
 * Whether formatting `newText` gives what formatting the file of `model` gives.
 *
 * - The two are the same up to `from`.
 * - `pieces`: the statements and the comments of `newText` from `newFrom` to `newRestStart`.
 * - From `newRestStart`, it is the text of the file from `model.restStart`.
 */
export function isUnchanged(model: Model, from: number, newText: Uint8Array, newFrom: number, pieces: Piece[], newRestStart: number): boolean {
  if (!model.isContiguous) return false;
  const text = model.text;
  let isExact = false;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as Piece;
    if (piece.kind !== PIECE_COMMENT) continue;
    const v = model.commentValue(piece.id);
    let s = v.start;
    let e = v.end;
    while (s < e && isAsciiBlank(text[s] | 0)) s = s + 1;
    while (e > s && isAsciiBlank(text[e - 1] | 0)) e = e - 1;
    if (e - s === 15 && sameAscii(text, s, "prettier-ignore")) isExact = true;
  }

  // The pieces of the file, in order.
  const statements: Statement[] = [];
  if (model.interpreter !== null && model.interpreter.start >= from) statements.push(new Statement(PIECE_INTERPRETER, 0, model.interpreter.start, model.interpreter.end));
  for (let i = 0; i < model.directives.length; i++) {
    const d = model.directives[i];
    if (d !== undefined && d.start >= from) statements.push(new Statement(PIECE_DIRECTIVE, i, d.start, d.end));
  }
  for (let i = 0; i < model.declarations.length; i++) {
    const d = model.declarations[i] as Declaration;
    if (d.hasSpan && d.start >= from) statements.push(new Statement(PIECE_IMPORT, i, d.start, d.end));
  }
  let statementAt = 0;
  let commentAt = 0;
  while (commentAt < model.comments.length && (model.comments[commentAt]?.start ?? 0) < from) commentAt = commentAt + 1;

  let end = from;
  let newEnd = newFrom;
  let isFirst = from === model.textStart();
  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p] as Piece;
    const nextComment = commentAt < model.comments.length ? (model.comments[commentAt]?.start ?? -1) : -1;
    let kind: number;
    let id: number;
    let spanStart: number;
    let spanEnd: number;
    const statement = statementAt < statements.length ? (statements[statementAt] as Statement) : null;
    if (statement !== null && (nextComment < 0 || statement.start < nextComment)) {
      // A comment in a statement.
      if (nextComment >= 0 && nextComment < statement.end) return false;
      statementAt = statementAt + 1;
      kind = statement.kind;
      id = statement.id;
      spanStart = statement.start;
      spanEnd = statement.end;
    } else {
      if (commentAt >= model.comments.length) return false;
      const c = model.comments[commentAt];
      if (c === undefined) return false;
      kind = PIECE_COMMENT;
      id = commentAt;
      spanStart = c.start;
      spanEnd = c.end;
      commentAt = commentAt + 1;
    }
    if (kind !== piece.kind || (kind !== PIECE_INTERPRETER && id !== piece.id)) return false;
    const g = gap(text, end, spanStart);
    const ng = gap(newText, newEnd, piece.start);
    if (g < 0 || ng < 0 || (g !== ng && !isFirst)) return false;
    isFirst = false;
    const pe = piece.end <= newText.length ? piece.end : newText.length;
    const ps = piece.start <= pe ? piece.start : pe;
    const equal = sameBytes(text, spanStart, spanEnd, newText, ps, pe);
    let isSame: boolean;
    if (kind === PIECE_IMPORT) {
      const declaration = model.declarations[id] as Declaration;
      let isBroken = false;
      const row = importAttributes(declaration.import);
      if (row >= 0) {
        importAttributesBracesSpan(row);
        const braceStart = SP[0] | 0;
        const braceEnd = SP[1] | 0;
        const n = importAttributesEntriesLen(row);
        let first = braceEnd;
        if (n > 0) {
          propSpan(listAt(importAttributesEntriesStart(row), 0));
          first = SP[0] | 0;
        }
        isBroken = hasLineBreakIn(text, braceStart, first);
      }
      isSame = equal || (!isExact && !isBroken && hasSameTokens(text, spanStart, spanEnd, newText, ps, pe));
    } else if (kind === PIECE_DIRECTIVE) {
      isSame = equal || (!isExact && hasSameTokens(text, spanStart, spanEnd, newText, ps, pe));
    } else {
      isSame = equal;
    }
    if (!isSame) return false;
    end = spanEnd;
    newEnd = piece.end;
  }
  if (statementAt < statements.length || commentAt < model.comments.length) return false;
  const g = gap(text, end, model.restStart);
  const ng = gap(newText, newEnd, newRestStart);
  return g >= 0 && ng >= 0 && (g === ng || model.restStart >= text.length);
}

function sameAscii(text: Uint8Array, at: number, lit: string): boolean {
  for (let i = 0; i < lit.length; i++) if ((text[at + i] | 0) !== lit.charCodeAt(i)) return false;
  return true;
}
