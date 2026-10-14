// Port of vendor/bun/src/format/js/sort_imports/native.rs: extra steps for `sortImports` from bunfig.toml's `[fmt]` or `--sort-imports`, on
// top of oxfmt's sorter. Sorts the names inside braces and merges imports from the same module.
//
// This is a text-to-text pass, like the Prettier plugins. The caller parses and formats the returned text instead of the original file.
// Pieces of source text move around verbatim. A file that is already tidy returns null and isn't parsed twice.
import { ByteBuf } from "../../../base/bytebuf.ts";
import {
  SP,
  STMT_IMPORT,
  TK_LINE,
  commentEndAt,
  commentKindAt,
  commentStartAt,
  commentsLen,
  fileBodyLen,
  fileBodyStart,
  hir,
  identSpan,
  importAttributes,
  importAttributesEntriesLen,
  importAttributesEntriesStart,
  importAttributesKeywordSpan,
  importAttributesBracesSpan,
  importClauseSpan,
  importDefault,
  importDefaultPos,
  importHasNamedImports,
  importIsSideEffect,
  importIsTypeOnly,
  importNamedLen,
  importNamedStart,
  importNamespace,
  importPhase,
  importSpec,
  importSpecImported,
  importSpecImportedPos,
  importSpecIsTypeOnly,
  importSpecLocal,
  importSpecLocalPos,
  importSpecSpan,
  importSpecSpanOf,
  keySpan,
  listAt,
  nodeOfProp,
  propValue,
  exprSpan,
  stmtImportImport,
  stmtSpan,
  stmtTag,
} from "../../../lint/ast/index.ts";
import { natord } from "./compare.ts";
import { stableOrder } from "./sort.ts";
import {
  Span,
  commentRange,
  commentsWithin,
  compareBytes,
  hasJsLineBreakIn,
  isAsciiBlank,
  nameBytes,
  sameBytes,
  bytesString,
  bufBytes,
  indexOfByteIn,
} from "./util.ts";

/** One name inside the braces, plus the source text that moves with it. */
class Chunk {
  spec: number;
  /** Starts where the previous chunk ends. Covers whitespace, leading comments, the name, and anything before its comma. */
  beforeComma: Span;
  /** Trailing comments after the comma. */
  afterComma: Span;
  /** Regions outside this chunk (before the `{`, after the last name). Only the comments in them move with the name. */
  lead: Span;
  trail: Span;
  constructor(spec: number, beforeComma: Span, afterComma: Span) {
    this.spec = spec;
    this.beforeComma = beforeComma;
    this.afterComma = afterComma;
    this.lead = new Span(0, 0);
    this.trail = new Span(0, 0);
  }
  copy(): Chunk {
    const c = new Chunk(this.spec, this.beforeComma, this.afterComma);
    c.lead = this.lead;
    c.trail = this.trail;
    return c;
  }
}

/** An import's `{ .. }`. */
class Braces {
  open: number;
  close: number;
  chunks: Chunk[];
  /** Everything between the last chunk and the `}`. */
  tail: Span;
  /** `lead` ends at the `{`, and its comments belong to the first name. `trail` runs from the `}` to `from`. */
  lead: Span;
  trail: Span;
  constructor(open: number, close: number, chunks: Chunk[], tail: Span, lead: Span, trail: Span) {
    this.open = open;
    this.close = close;
    this.chunks = chunks;
    this.tail = tail;
    this.lead = lead;
    this.trail = trail;
  }
}

/** Output buffer that never lets a line comment swallow the next piece. */
class Pieces {
  text: ByteBuf = new ByteBuf(64);
  endsInLineComment: boolean = false;
  push(src: Uint8Array, start: number, end: number, endsInLineComment: boolean): void {
    if (end <= start) return;
    if (this.endsInLineComment) {
      const first = src[start] | 0;
      if (first !== 10 && first !== 13) this.text.push(10);
    }
    this.text.append(src, start, end);
    this.endsInLineComment = endsInLineComment;
  }
  pushAscii(s: string, endsInLineComment: boolean): void {
    if (s.length === 0) return;
    if (this.endsInLineComment) {
      const c = s.charCodeAt(0);
      if (c !== 10 && c !== 13) this.text.push(10);
    }
    for (let i = 0; i < s.length; i++) this.text.push(s.charCodeAt(i));
    this.endsInLineComment = endsInLineComment;
  }
}

/** One import in a run of consecutive imports. */
class Entry {
  statement: number;
  imp: number;
  braces: Braces | null;
  /** Other imports can merge into this one. */
  canGrow: boolean;
  /** This import can be merged into another one and removed. */
  canGo: boolean;
  constructor(statement: number, imp: number, braces: Braces | null, canGrow: boolean, canGo: boolean) {
    this.statement = statement;
    this.imp = imp;
    this.braces = braces;
    this.canGrow = canGrow;
    this.canGo = canGo;
  }
}

class Change {
  span: Span;
  text: Uint8Array;
  constructor(span: Span, text: Uint8Array) {
    this.span = span;
    this.text = text;
  }
}

const EMPTY_BYTES = new Uint8Array(0);

/** Strips the quotes from `"a"` or `'a'`: the new (start, end). */
function withoutQuotes(text: Uint8Array, start: number, end: number): Span {
  if (end - start >= 2) {
    const a = text[start] | 0;
    const b = text[end - 1] | 0;
    if ((a === 34 || a === 39) && (b === 34 || b === 39)) return new Span(start + 1, end - 1);
  }
  return new Span(start, end);
}

function isAlpha(b: number): boolean {
  return (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
}

/** Written as `ImportSpec::span()`. */
function specSpan(spec: number): Span {
  importSpecSpan(spec);
  const SP$ = SP;
  return new Span(SP$.s0 | 0, SP$.s1 | 0);
}

function identSpanOf(atom: number, pos: number): Span {
  identSpan(atom, pos);
  const SP$ = SP;
  return new Span(SP$.s0 | 0, SP$.s1 | 0);
}

class Tidy {
  text: Uint8Array;
  /** Replacements to apply to the source text. */
  changes: Change[];
  constructor(text: Uint8Array) {
    this.text = text;
    this.changes = [];
  }

  hasComments(span: Span): boolean {
    return commentsWithin(span.start, span.end) > 0;
  }

  /** Finds the first `byte` in `span` that isn't inside a comment: -1 if there is none. */
  find(span: Span, byte: number): number {
    if (span.end < span.start) return -1;
    commentsWithin(span.start, span.end);
    const commentRange$ = commentRange;
    const from0 = commentRange$.from;
    const to0 = commentRange$.to;
    let from = span.start;
    for (let k = from0; k < to0; k++) {
      const cs = commentStartAt(k);
      if (cs > from) {
        const at = indexOfByteIn(this.text, from, cs, byte);
        if (at >= 0) return at;
      }
      from = commentEndAt(k);
    }
    if (span.end > from) {
      const at = indexOfByteIn(this.text, from, span.end, byte);
      if (at >= 0) return at;
    }
    return -1;
  }

  /** Sort key: the exported name, so `a as z` sorts under `a`. */
  keySpan(spec: number): Span {
    const s = identSpanOf(importSpecImported(spec), importSpecImportedPos(spec));
    return withoutQuotes(this.text, s.start, s.end);
  }

  compare(a: number, b: number): number {
    const ka = this.keySpan(a);
    const kb = this.keySpan(b);
    const sa = bytesString(this.text, ka.start, ka.end);
    const sb = bytesString(this.text, kb.start, kb.end);
    let order = natord(sa, sb, true);
    if (order !== 0) return order;
    order = compareBytes(this.text, ka.start, ka.end, this.text, kb.start, kb.end);
    if (order !== 0) return order;
    const la = identSpanOf(importSpecLocal(a), importSpecLocalPos(a));
    const lb = identSpanOf(importSpecLocal(b), importSpecLocalPos(b));
    return compareBytes(this.text, la.start, la.end, this.text, lb.start, lb.end);
  }

  isSameName(a: number, b: number): boolean {
    return this.compare(a, b) === 0 && importSpecIsTypeOnly(a) === importSpecIsTypeOnly(b);
  }

  bracesOf(statement: number, imp: number): Braces | null {
    if (!importHasNamedImports(imp)) return null;
    // Everything between `import` and the module specifier.
    stmtSpan(statement);
    const SP$ = SP;
    const keywordEnd = ((SP$.s0 | 0) + 6) | 0;
    if (!importSpecSpanOf(imp)) return null;
    const clause = new Span(keywordEnd, SP$.s0 | 0);
    const n = importNamedLen(imp);
    const ns = importNamedStart(imp);
    const first = n > 0 ? specSpan(listAt(ns, 0)) : new Span(clause.end, clause.end);
    const open = this.find(new Span(clause.start, first.start), 123);
    if (open < 0) return null;
    const last = n > 0 ? specSpan(listAt(ns, n - 1)) : new Span(open + 1, open + 1);
    const close = this.find(new Span(last.end, clause.end), 125);
    if (close < 0) return null;
    const chunks: Chunk[] = [];
    let from = open + 1;
    const commentRange$ = commentRange;
    for (let index = 0; index < n; index++) {
      const spec = listAt(ns, index);
      const sp = specSpan(spec);
      const next = index + 1 < n ? specSpan(listAt(ns, index + 1)).start : -1;
      const limit = next >= 0 ? next : close;
      const comma = this.find(new Span(sp.end, limit), 44);
      const after = comma >= 0 ? comma + 1 : sp.end;
      // Comments on the rest of the line trail this name, but only if nothing else follows them on that line.
      let reached = after;
      commentsWithin(after, limit);
      const cf = commentRange$.from;
      const ct = commentRange$.to;
      for (let k = cf; k < ct; k++) {
        if (hasJsLineBreakIn(this.text, reached, commentStartAt(k))) break;
        reached = commentEndAt(k);
      }
      let blanks = reached;
      while (blanks < limit && isAsciiBlank(this.text[blanks] | 0)) blanks = blanks + 1;
      if (next >= 0 && !hasJsLineBreakIn(this.text, reached, blanks)) reached = after;
      chunks.push(new Chunk(spec, new Span(from, comma >= 0 ? comma : after), new Span(after, reached)));
      from = reached;
    }
    // `lead` starts after `type` or after the default import.
    importClauseSpan(imp);
    const kindStart = SP$.s0 | 0;
    const kindEnd = SP$.s1 | 0;
    let letters = 0;
    while (kindStart + letters < kindEnd && isAlpha(this.text[kindStart + letters] | 0)) letters = letters + 1;
    let leadStart = clause.start;
    if (importDefault(imp) >= 0) leadStart = identSpanOf(importDefault(imp), importDefaultPos(imp)).end;
    else if (importIsTypeOnly(imp)) leadStart = kindStart + letters;
    const keyword = this.find(new Span(close + 1, clause.end), 102);
    if (keyword < 0) return null;
    return new Braces(open, close, chunks, new Span(from, close), new Span(leadStart, open), new Span(close + 1, keyword));
  }

  /** Returns the chunks with the comments around the braces attached. `withTail` also attaches comments before the `}`. */
  chunksOf(braces: Braces, withTail: boolean): Chunk[] {
    const chunks: Chunk[] = [];
    for (let i = 0; i < braces.chunks.length; i++) chunks.push((braces.chunks[i] as Chunk).copy());
    if (chunks.length > 0) {
      (chunks[0] as Chunk).lead = braces.lead;
      (chunks[chunks.length - 1] as Chunk).trail = withTail ? new Span(braces.tail.start, braces.trail.end) : braces.trail;
    }
    return chunks;
  }

  hasCommentsOfItsOwn(chunk: Chunk): boolean {
    return (
      this.hasComments(chunk.lead) ||
      this.hasComments(new Span(chunk.beforeComma.start, chunk.afterComma.end)) ||
      this.hasComments(chunk.trail)
    );
  }

  /** The rest of the line after `statement`, capped at `limit`. */
  restOfLine(statement: Span, limit: number): Span {
    const rest = new Span(statement.end, limit);
    let len = -1;
    for (let i = rest.start; i < rest.end; i++) {
      const b = this.text[i] | 0;
      if (b === 10 || b === 13) {
        len = i - rest.start;
        break;
      }
    }
    return len >= 0 ? new Span(statement.end, rest.start + len) : rest;
  }

  /** Returns true if the spans contain a `prettier-ignore` or `oxfmt-ignore` comment. */
  isLeftAlone(a: Span, b: Span): boolean {
    return this.hasIgnore(a) || this.hasIgnore(b);
  }

  hasIgnore(span: Span): boolean {
    if (span.end < span.start) return false;
    commentsWithin(span.start, span.end);
    const commentRange$ = commentRange;
    const from = commentRange$.from;
    const to = commentRange$.to;
    for (let k = from; k < to; k++) {
      let s = commentStartAt(k);
      let e = commentEndAt(k);
      const t = this.text;
      if ((t[s] | 0) === 47 && (t[s + 1] | 0) === 47) s = s + 2;
      else if ((t[s] | 0) === 47 && (t[s + 1] | 0) === 42 && e - s >= 4 && (t[e - 2] | 0) === 42 && (t[e - 1] | 0) === 47) {
        s = s + 2;
        e = e - 2;
      }
      while (s < e && isAsciiBlank(t[s] | 0)) s = s + 1;
      while (e > s && isAsciiBlank(t[e - 1] | 0)) e = e - 1;
      const text = bytesString(t, s, e);
      if (text === "prettier-ignore" || text === "oxfmt-ignore") return true;
    }
    return false;
  }

  /** `before` starts after the previous statement's line. `behind` is the rest of this statement's line. */
  entry(statement: number, imp: number, before: Span, behind: Span): Entry {
    stmtSpan(statement);
    const SP$ = SP;
    const span = new Span(SP$.s0 | 0, SP$.s1 | 0);
    const braces = this.bracesOf(statement, imp);
    // Comments inside the statement that no name can carry along.
    let hasCommentsInside: boolean;
    if (braces !== null && braces.chunks.length === 0) hasCommentsInside = this.hasComments(span);
    else if (braces !== null) {
      hasCommentsInside = this.hasComments(new Span(span.start, braces.lead.start)) || this.hasComments(new Span(braces.trail.end, span.end));
    } else hasCommentsInside = this.hasComments(span);
    // A comment directly above, with no blank line in between.
    let leads = false;
    if (before.end >= before.start && commentsWithin(before.start, before.end) > 0) {
      const lastComment = commentRange.to - 1;
      const ce = commentEndAt(lastComment);
      let newlines = 0;
      let returns = 0;
      for (let i = ce; i < span.start; i++) {
        const b = this.text[i] | 0;
        if (b === 10) newlines = newlines + 1;
        else if (b === 13) returns = returns + 1;
      }
      leads = (newlines > returns ? newlines : returns) < 2;
    }
    const canGrow =
      importNamespace(imp) < 0 &&
      importPhase(imp) === 0 &&
      (braces !== null) === importHasNamedImports(imp) &&
      // Leave `import {} from "a"` alone.
      (importDefault(imp) >= 0 || importNamedLen(imp) > 0) &&
      // `import type a, { b }` is a syntax error.
      !(importIsTypeOnly(imp) && importDefault(imp) >= 0);
    return new Entry(statement, imp, braces, canGrow, canGrow && !hasCommentsInside && !leads && !this.hasComments(behind));
  }

  /** The `type` or `typeof` of the clause, or "" (`type` imports only). */
  kindOf(e: Entry): string {
    if (!importIsTypeOnly(e.imp)) return "";
    importClauseSpan(e.imp);
    const SP$ = SP;
    const s = SP$.s0 | 0;
    const end = SP$.s1 | 0;
    let n = 0;
    while (s + n < end && isAlpha(this.text[s + n] | 0)) n = n + 1;
    return "t" + bytesString(this.text, s, s + n);
  }

  /** The attributes as text, or null. */
  attributesOf(e: Entry): string | null {
    const row = importAttributes(e.imp);
    if (row < 0) return null;
    const start = importAttributesEntriesStart(row);
    const len = importAttributesEntriesLen(row);
    importAttributesKeywordSpan(row);
    const SP$ = SP;
    let out = bytesString(this.text, SP$.s0 | 0, SP$.s1 | 0) + "\u0000";
    for (let i = 0; i < len; i++) {
      const p = listAt(start, i);
      let key = "";
      if (keySpan(nodeOfProp(p))) {
        const q = withoutQuotes(this.text, SP$.s0 | 0, SP$.s1 | 0);
        key = bytesString(this.text, q.start, q.end);
      }
      let value = "";
      const v = propValue(p);
      if (v >= 0) {
        exprSpan(v);
        const q = withoutQuotes(this.text, SP$.s0 | 0, SP$.s1 | 0);
        value = bytesString(this.text, q.start, q.end);
      }
      out += key + "\u0001" + value + "\u0002";
    }
    return out;
  }

  /** Same module, same `type` keyword, same import attributes. */
  isSameKind(a: Entry, b: Entry): boolean {
    if (importSpec(a.imp) !== importSpec(b.imp)) return false;
    if (this.kindOf(a) !== this.kindOf(b)) return false;
    return this.attributesOf(a) === this.attributesOf(b);
  }

  isLineCommentAtEnd(span: Span): boolean {
    if (span.end < span.start || commentsWithin(span.start, span.end) === 0) return false;
    const k = commentRange.to - 1;
    return commentKindAt(k) === TK_LINE && !hasJsLineBreakIn(this.text, commentEndAt(k), span.end);
  }

  push(span: Span, out: Pieces): void {
    if (span.end <= span.start) return;
    out.push(this.text, span.start, span.end, this.isLineCommentAtEnd(span));
  }

  /** Writes the comments in `span`. `leads` means they belong to the name that follows. */
  pushComments(span: Span, leads: boolean, out: Pieces): void {
    if (span.end < span.start) return;
    commentsWithin(span.start, span.end);
    const commentRange$ = commentRange;
    const from = commentRange$.from;
    const to = commentRange$.to;
    for (let k = from; k < to; k++) {
      const isLine = commentKindAt(k) === TK_LINE;
      // A leading line comment needs its own line, or it would attach to the previous name.
      out.pushAscii(leads && isLine ? "\n" : " ", false);
      out.push(this.text, commentStartAt(k), commentEndAt(k), isLine);
    }
  }

  hasLineComment(span: Span): boolean {
    if (span.end < span.start) return false;
    commentsWithin(span.start, span.end);
    const commentRange$ = commentRange;
    const from = commentRange$.from;
    const to = commentRange$.to;
    for (let k = from; k < to; k++) if (commentKindAt(k) === TK_LINE) return true;
    return false;
  }

  /** Writes `chunks` as the contents of the braces. */
  writeNames(chunks: Chunk[], out: Pieces): void {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as Chunk;
      this.pushComments(chunk.lead, true, out);
      this.push(chunk.beforeComma, out);
      // A block comment after the comma would attach to the next name, so the comma goes after it.
      const commaIsFirst = this.hasLineComment(chunk.afterComma) || this.hasLineComment(chunk.trail);
      if (commaIsFirst) out.pushAscii(",", false);
      this.push(chunk.afterComma, out);
      this.pushComments(chunk.trail, false, out);
      if (!commaIsFirst) out.pushAscii(",", false);
    }
  }

  /** Sorts `chunks` and drops exact duplicates. Returns the new list and sets `changed`. */
  sort(chunks: Chunk[]): Chunk[] {
    const before: number[] = [];
    for (let i = 0; i < chunks.length; i++) before.push((chunks[i] as Chunk).beforeComma.start);
    const places = stableOrder(chunks.length, (a: number, b: number): number => this.compare((chunks[a] as Chunk).spec, (chunks[b] as Chunk).spec));
    const sorted: Chunk[] = [];
    for (let i = 0; i < chunks.length; i++) sorted.push(chunks[places[i] | 0] as Chunk);
    const kept: Chunk[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const later = sorted[i] as Chunk;
      if (kept.length > 0) {
        const earlier = kept[kept.length - 1] as Chunk;
        if (!this.hasCommentsOfItsOwn(later) && this.isSameName(later.spec, earlier.spec)) continue;
      }
      kept.push(later);
    }
    this.lastSortChanged = kept.length !== before.length;
    if (!this.lastSortChanged) {
      for (let i = 0; i < kept.length; i++) if ((kept[i] as Chunk).beforeComma.start !== before[i]) this.lastSortChanged = true;
    }
    return kept;
  }
  lastSortChanged: boolean = false;

  /** Deletes `statement`, and the whole line if nothing else is on it. */
  remove(statement: number): void {
    stmtSpan(statement);
    const SP$ = SP;
    let start = SP$.s0 | 0;
    let end = SP$.s1 | 0;
    const t = this.text;
    let lineStart = 0;
    for (let i = start - 1; i >= 0; i--) {
      const b = t[i] | 0;
      if (b === 10 || b === 13) {
        lineStart = i + 1;
        break;
      }
    }
    let lineLen = t.length - end;
    for (let i = end; i < t.length; i++) {
      const b = t[i] | 0;
      if (b === 10 || b === 13) {
        lineLen = i - end;
        break;
      }
    }
    let blankBefore = true;
    for (let i = lineStart; i < start; i++) if (!isAsciiBlank(t[i] | 0)) blankBefore = false;
    let blankAfter = true;
    for (let i = end; i < end + lineLen; i++) if (!isAsciiBlank(t[i] | 0)) blankAfter = false;
    if (blankBefore && blankAfter) {
      let lineBreak = 0;
      const p = end + lineLen;
      if (p < t.length) lineBreak = (t[p] | 0) === 13 && p + 1 < t.length && (t[p + 1] | 0) === 10 ? 2 : 1;
      start = lineStart;
      end = end + lineLen + lineBreak;
    }
    this.changes.push(new Change(new Span(start, end), EMPTY_BYTES));
  }

  /** Rewrites `target` to import `default` and `chunks`. `defaultSpan` null: none. */
  rewrite(target: Entry, defaultSpan: Span | null, chunks: Chunk[]): void {
    const names = new Pieces();
    const ownDefault = importDefault(target.imp);
    const braces = target.braces;
    const commentRange$ = commentRange;
    const SP$ = SP;
    if (braces !== null) {
      // These comments are part of `chunks` now.
      if (braces.chunks.length > 0) {
        const spans: Span[] = [braces.lead, braces.trail];
        for (let s = 0; s < 2; s++) {
          const sp = spans[s] as Span;
          if (sp.end < sp.start) continue;
          commentsWithin(sp.start, sp.end);
          for (let k = commentRange$.from; k < commentRange$.to; k++) {
            this.changes.push(new Change(new Span(commentStartAt(k), commentEndAt(k)), EMPTY_BYTES));
          }
        }
      }
      if (defaultSpan !== null && ownDefault < 0) {
        const a = new TextEncoder().encode(bytesString(this.text, defaultSpan.start, defaultSpan.end) + ", ");
        this.changes.push(new Change(new Span(braces.open, braces.open), a));
      }
      this.writeNames(chunks, names);
      this.push(braces.tail, names);
      if (names.endsInLineComment) names.text.push(10);
      this.changes.push(new Change(new Span(braces.open + 1, braces.close), bufBytes(names.text)));
    } else if (ownDefault >= 0 && chunks.length > 0) {
      // Insert after any comments that belong to the default import.
      const d = identSpanOf(ownDefault, importDefaultPos(target.imp));
      const source = importSpecSpanOf(target.imp) ? new Span(SP$.s0 | 0, SP$.s1 | 0) : new Span(0, 0);
      const from = this.find(new Span(d.end, source.start), 102);
      const aboutDefault = new Span(d.end, from >= 0 ? from : d.end);
      let lastComment = -1;
      if (aboutDefault.end >= aboutDefault.start && commentsWithin(aboutDefault.start, aboutDefault.end) > 0) lastComment = commentRange$.to - 1;
      names.endsInLineComment = lastComment >= 0 && commentKindAt(lastComment) === TK_LINE;
      names.pushAscii(", {", false);
      this.writeNames(chunks, names);
      names.pushAscii(" }", false);
      const at = lastComment >= 0 ? commentEndAt(lastComment) : d.end;
      this.changes.push(new Change(new Span(at, at), bufBytes(names.text)));
    }
  }

  /** Tidies one run of imports with no barrier in it. */
  tidy(entries: Entry[]): void {
    const isSeen: boolean[] = [];
    for (let i = 0; i < entries.length; i++) isSeen.push(false);
    for (let at = 0; at < entries.length; at++) {
      if (isSeen[at] as boolean) continue;
      const first = entries[at] as Entry;
      // All imports that could merge with `first`.
      const group: number[] = [];
      for (let other = at; other < entries.length; other++) {
        if (other === at || (!(isSeen[other] as boolean) && this.isSameKind(first, entries[other] as Entry))) group.push(other);
      }
      for (let i = 0; i < group.length; i++) isSeen[group[i] as number] = true;
      // Prefer a target that can't be removed, then one whose `}` has a comment before it, so that comment stays put.
      let target = -1;
      for (let i = 0; i < group.length && target < 0; i++) {
        const e = entries[group[i] as number] as Entry;
        if (e.canGrow && !e.canGo) target = group[i] as number;
      }
      for (let i = 0; i < group.length && target < 0; i++) {
        const e = entries[group[i] as number] as Entry;
        if (e.canGrow && e.braces !== null && this.hasComments(e.braces.tail)) target = group[i] as number;
      }
      for (let i = 0; i < group.length && target < 0; i++) {
        const e = entries[group[i] as number] as Entry;
        if (e.canGrow) target = group[i] as number;
      }
      let defaultSpan: Span | null = null;
      if (target >= 0) {
        const d = importDefault((entries[target] as Entry).imp);
        if (d >= 0) defaultSpan = identSpanOf(d, importDefaultPos((entries[target] as Entry).imp));
      }
      let merged: Chunk[] = [];
      for (let g = 0; g < group.length; g++) {
        const index = group[g] as number;
        const entry = entries[index] as Entry;
        const own = (withTail: boolean): Chunk[] => (entry.braces === null ? [] : this.chunksOf(entry.braces, withTail));
        if (index === target) {
          const o = own(false);
          for (let i = 0; i < o.length; i++) merged.push(o[i] as Chunk);
          continue;
        }
        let fits = true;
        const ed = importDefault(entry.imp);
        if (defaultSpan !== null && ed >= 0) {
          const od = identSpanOf(ed, importDefaultPos(entry.imp));
          fits = sameBytes(this.text, defaultSpan.start, defaultSpan.end, this.text, od.start, od.end);
        }
        if (target >= 0 && entry.canGo && fits) {
          if (defaultSpan === null && ed >= 0) defaultSpan = identSpanOf(ed, importDefaultPos(entry.imp));
          const o = own(true);
          for (let i = 0; i < o.length; i++) merged.push(o[i] as Chunk);
          this.remove(entry.statement);
          continue;
        }
        const sortedOwn = this.sort(own(false));
        if (this.lastSortChanged) this.rewrite(entry, null, sortedOwn);
      }
      if (target >= 0) {
        const t = entries[target] as Entry;
        const ownNames = t.braces === null ? 0 : t.braces.chunks.length;
        const hasGrown = merged.length > ownNames || (defaultSpan !== null) !== (importDefault(t.imp) >= 0);
        merged = this.sort(merged);
        if (this.lastSortChanged || hasGrown) this.rewrite(t, defaultSpan, merged);
      }
    }
  }

  /** Cheap check for unsorted names or a module that is imported twice. False positives are fine. */
  mayBeUntidy(): boolean {
    const modules: string[] = [];
    const n = fileBodyLen();
    const bs = fileBodyStart();
    for (let i = 0; i < n; i++) {
      const statement = listAt(bs, i);
      if (stmtTag(statement) !== STMT_IMPORT) continue;
      const imp = stmtImportImport(statement);
      const len = importNamedLen(imp);
      const ns = importNamedStart(imp);
      for (let k = 0; k + 1 < len; k++) {
        if (this.compare(listAt(ns, k), listAt(ns, k + 1)) >= 0) return true;
      }
      if (!importIsSideEffect(imp)) {
        const b = nameBytes(importSpec(imp));
        modules.push(bytesString(b, 0, b.length));
      }
    }
    // Bytewise order, but equal modules are all that is looked for.
    modules.sort();
    for (let i = 0; i + 1 < modules.length; i++) if (modules[i] === modules[i + 1]) return true;
    return false;
  }
}

/** Returns the text of the file with sorted names and merged imports, or null if nothing changes. */
export function preprocess(): Uint8Array | null {
  const hir$ = hir;
  const text = hir$.text.subarray(0, hir$.sourceLen | 0);
  const tidy = new Tidy(text);
  if (!tidy.mayBeUntidy()) return null;
  const n = fileBodyLen();
  const bs = fileBodyStart();
  let entries: Entry[] = [];
  let previousEnd = 0;
  const SP$ = SP;
  for (let index = 0; index < n; index++) {
    const statement = listAt(bs, index);
    stmtSpan(statement);
    const span = new Span(SP$.s0 | 0, SP$.s1 | 0);
    let nextStart = text.length;
    if (index + 1 < n) {
      stmtSpan(listAt(bs, index + 1));
      nextStart = SP$.s0 | 0;
    }
    const before = new Span(previousEnd, span.start);
    const behind = tidy.restOfLine(span, nextStart);
    previousEnd = behind.end;
    if (stmtTag(statement) === STMT_IMPORT && !importIsSideEffect(stmtImportImport(statement)) && !tidy.isLeftAlone(before, behind)) {
      entries.push(tidy.entry(statement, stmtImportImport(statement), before, behind));
    } else {
      tidy.tidy(entries);
      entries = [];
    }
  }
  tidy.tidy(entries);
  const changes = tidy.changes;
  if (changes.length === 0) return null;
  const places = stableOrder(changes.length, (a: number, b: number): number => {
    const x = (changes[a] as Change).span.start;
    const y = (changes[b] as Change).span.start;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const out = new ByteBuf(text.length + 64);
  let from = 0;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[places[i] | 0] as Change;
    if (c.span.start > text.length || from > c.span.start) return null;
    out.append(text, from, c.span.start);
    out.append(c.text, 0, c.text.length);
    from = c.span.end;
  }
  if (from > text.length) return null;
  out.append(text, from, text.length);
  return bufBytes(out);
}

// ───────────────────────────── keeps_imports ─────────────────────────────

/** Every binding the file imports (as text), plus all of its comments, sorted. */
export class Summary {
  names: string[] = [];
  comments: string[] = [];
}

export function summary(): Summary {
  const hir$ = hir;
  const text = hir$.text.subarray(0, hir$.sourceLen | 0);
  const out = new Summary();
  const n = fileBodyLen();
  const bs = fileBodyStart();
  const SP$ = SP;
  for (let i = 0; i < n; i++) {
    const statement = listAt(bs, i);
    if (stmtTag(statement) !== STMT_IMPORT) continue;
    const imp = stmtImportImport(statement);
    let attributes = "";
    const row = importAttributes(imp);
    if (row >= 0) {
      importAttributesKeywordSpan(row);
      const s = SP$.s0 | 0;
      importAttributesBracesSpan(row);
      const e = SP$.s1 | 0;
      for (let k = s; k < e; k++) {
        const b = text[k] | 0;
        if (!(isAsciiBlank(b) || b === 34 || b === 39 || b === 44)) attributes += String.fromCharCode(b);
      }
    }
    const specBytes = nameBytes(importSpec(imp));
    const spec = bytesString(specBytes, 0, specBytes.length);
    const add = (imported: string, local: string, isType: boolean): void => {
      out.names.push(spec + "\u0000" + attributes + "\u0000" + (importIsTypeOnly(imp) ? "1" : "0") + (isType ? "1" : "0") + "\u0000" + imported + "\u0000" + local);
    };
    const d = importDefault(imp);
    const ns = importNamespace(imp);
    const len = importNamedLen(imp);
    if (d < 0 && ns < 0 && len === 0) add("", "", false);
    if (d >= 0) {
      const sp = identSpanOf(d, importDefaultPos(imp));
      add("default", bytesString(text, sp.start, sp.end), false);
    }
    if (ns >= 0) {
      const sp = identSpanOf(ns, hir$.importNamespacePos[imp] | 0);
      add("*", bytesString(text, sp.start, sp.end), false);
    }
    const start = importNamedStart(imp);
    for (let k = 0; k < len; k++) {
      const spec2 = listAt(start, k);
      const im = identSpanOf(importSpecImported(spec2), importSpecImportedPos(spec2));
      const q = withoutQuotes(text, im.start, im.end);
      const lo = identSpanOf(importSpecLocal(spec2), importSpecLocalPos(spec2));
      add(bytesString(text, q.start, q.end), bytesString(text, lo.start, lo.end), importSpecIsTypeOnly(spec2));
    }
  }
  out.names.sort();
  const dedup: string[] = [];
  for (let i = 0; i < out.names.length; i++) if (i === 0 || out.names[i] !== out.names[i - 1]) dedup.push(out.names[i] as string);
  out.names = dedup;
  const cn = commentsLen();
  for (let i = 0; i < cn; i++) out.comments.push(bytesString(text, commentStartAt(i), commentEndAt(i)));
  out.comments.sort();
  return out;
}

export function sameSummary(a: Summary, b: Summary): boolean {
  if (a.names.length !== b.names.length || a.comments.length !== b.comments.length) return false;
  for (let i = 0; i < a.names.length; i++) if (a.names[i] !== b.names[i]) return false;
  for (let i = 0; i < a.comments.length; i++) if (a.comments[i] !== b.comments[i]) return false;
  return true;
}
