// Port of vendor/bun/src/format/js/sort_imports/organize.rs: `prettier-plugin-organize-imports` 4.3, which hands a file to the "Organize Imports"
// of TypeScript's language service before Prettier formats it: `organizeImports.ts` of TypeScript 5.9, and of `textChanges.ts` what it uses.
//
// Imports that nothing refers to are removed, imports of one module are combined, and imports, what they import, and exports with a `from`
// are sorted. An empty line or a line of comments separates groups, which are sorted on their own.
//
// There is no binder in this port: which imports are used is told by `usage.ts`.
import { ByteBuf } from "../../../base/bytebuf.ts";
import {
  EXPR_JSX,
  MODNAME_STRING,
  N_FILE,
  SP,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_IMPORT,
  STMT_MODULE,
  TK_BLOCK,
  TK_SHEBANG,
  commentEndAt,
  commentKindAt,
  commentStartAt,
  commentsLen,
  exportHasFrom,
  exportIsTypeOnly,
  exportItemsLen,
  exportItemsStart,
  exportSpec,
  exportSpecExport,
  exportSpecExported,
  exportSpecExportedPos,
  exportSpecIsTypeOnly,
  exportSpecSpan,
  fileBodyLen,
  fileBodyStart,
  fileIsDeclarationFile,
  fileProgramSpan,
  hir,
  identIsString,
  identSpan,
  importAttributes,
  importAttributesBracesSpan,
  importAttributesEntriesLen,
  importAttributesEntriesStart,
  importAttributesKeywordSpan,
  importClauseSpan,
  importDefault,
  importDefaultPos,
  importHasNamedImports,
  importIsDeferred,
  importIsTypeOnly,
  importNamedLen,
  importNamedStart,
  importNamespace,
  importNamespacePos,
  importSpec,
  importSpecImport,
  importSpecImported,
  importSpecImportedPos,
  importSpecIsRenamed,
  importSpecIsTypeOnly,
  importSpecLocal,
  importSpecLocalPos,
  importSpecSpan,
  importStmt,
  exportStmt,
  keyName,
  keySpan,
  listAt,
  moduleBodyLen,
  moduleBodySpan,
  moduleBodyStart,
  moduleName,
  moduleNameKind,
  nodeOfStmt,
  nodeParent,
  nodeKind,
  nodeId,
  propSpan,
  propValue,
  nodeOfProp,
  exprSpan,
  stmtExportNamedExport,
  stmtExportStarAlias,
  stmtExportStarFlags,
  stmtExportStarSpec,
  stmtImportAttributes,
  stmtImportImport,
  stmtModuleModule,
  stmtModuleSpecifierSpan,
  stmtSpan,
  stmtTag,
} from "../../../lint/ast/index.ts";
import { lowercaseEach } from "./compare.ts";
import { stableOrder } from "./sort.ts";
import { Span, bufBytes, bytesString, containsAscii, hasLineBreakIn, nameBytes, sameBytes } from "./util.ts";
import { Usage, usageOf } from "./usage.ts";

export const TYPE_ORDER_LAST: number = 0;
export const TYPE_ORDER_INLINE: number = 1;
export const TYPE_ORDER_FIRST: number = 2;

export class OrganizeOptions {
  /** `organizeImportsSkipDestructiveCodeActions`: nothing is removed. */
  skipsDestructiveCodeActions: boolean = false;
  /** `organizeImportsTypeOrder`: -1 for none. */
  typeOrder: number = -1;
  /** `jsx` of the `tsconfig.json` is `react` or `react-native`: JSX uses what the next two name. */
  jsxNeedsImport: boolean = false;
  /** The first name in `jsxFactory`, or `reactNamespace`, or `React`. */
  jsxNamespace: string = "React";
  /** The first name in `jsxFragmentFactory`; "" for none. */
  jsxFragmentFactory: string = "";
}

/** `getOrganizeImportsOrdinalStringComparer` */
const IGNORING_CASE = 0;
const CASE_SENSITIVE = 1;

/** Compares by code point (the order of UTF-8 bytes). */
function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) return x < y ? -1 : 1;
    i = i + (x > 0xffff ? 2 : 1);
    j = j + (y > 0xffff ? 2 : 1);
  }
  const ra = i < a.length;
  const rb = j < b.length;
  return ra === rb ? 0 : ra ? 1 : -1;
}

function compareWith(comparer: number, a: string, b: string): number {
  if (comparer === CASE_SENSITIVE) return compareCodePoints(a, b);
  return compareCodePoints(lowercaseEach(a), lowercaseEach(b));
}

/** An `ImportDeclaration` or an `ExportDeclaration`. */
class Decl {
  statement: number;
  /** `getFullStart()`: where the token before it ends. */
  fullStart: number;
  constructor(statement: number, fullStart: number) {
    this.statement = statement;
    this.fullStart = fullStart;
  }
  start(): number {
    stmtSpan(this.statement);
    return SP[0] | 0;
  }
  end(): number {
    stmtSpan(this.statement);
    return SP[1] | 0;
  }
  /** The import, or -1. */
  imp(): number {
    return stmtTag(this.statement) === STMT_IMPORT ? stmtImportImport(this.statement) : -1;
  }
  /** `getExternalModuleName(moduleSpecifier)`: null if there is none. */
  module(): string | null {
    const s = this.statement;
    const tag = stmtTag(s);
    let atom = -1;
    if (tag === STMT_IMPORT) atom = importSpec(stmtImportImport(s));
    else if (tag === STMT_EXPORT_NAMED) atom = exportSpec(stmtExportNamedExport(s));
    else if (tag === STMT_EXPORT_STAR) atom = stmtExportStarSpec(s);
    if (atom < 0) return null;
    const b = nameBytes(atom);
    return bytesString(b, 0, b.length);
  }
}

/** `measureSortedness` */
function measureSortedness(items: string[], comparer: number): number {
  let n = 0;
  for (let i = 0; i + 1 < items.length; i++) if (compareWith(comparer, items[i] as string, items[i + 1] as string) > 0) n = n + 1;
  return n;
}

/** `detectCaseSensitivityBySort` */
function detectCaseSensitivityBySort(groups: string[][]): number {
  let cs = 0;
  let ic = 0;
  for (let i = 0; i < groups.length; i++) {
    cs = cs + measureSortedness(groups[i] as string[], CASE_SENSITIVE);
    ic = ic + measureSortedness(groups[i] as string[], IGNORING_CASE);
  }
  return cs < ic ? CASE_SENSITIVE : IGNORING_CASE;
}

/** `compareImportOrExportSpecifiers`: (isType, name) of each. */
function compareSpecifiers(aType: boolean, aName: string, bType: boolean, bName: string, comparer: number, typeOrder: number): number {
  let byKind = 0;
  const x = aType ? 1 : 0;
  const y = bType ? 1 : 0;
  if (typeOrder === TYPE_ORDER_FIRST) byKind = y < x ? -1 : y > x ? 1 : 0;
  else if (typeOrder === TYPE_ORDER_LAST) byKind = x < y ? -1 : x > y ? 1 : 0;
  return byKind !== 0 ? byKind : compareWith(comparer, aName, bName);
}

class Detected {
  comparer: number;
  /** -1: none */
  typeOrder: number;
  constructor(comparer: number, typeOrder: number) {
    this.comparer = comparer;
    this.typeOrder = typeOrder;
  }
}

class NamedElement {
  isType: boolean;
  name: string;
  constructor(isType: boolean, name: string) {
    this.isType = isType;
    this.name = name;
  }
}

/** `detectNamedImportOrganizationBySort` */
function detectNamedImportOrganizationBySort(imports: Decl[], orders: number[]): Detected | null {
  const named: NamedElement[][] = [];
  for (let i = 0; i < imports.length; i++) {
    const imp = (imports[i] as Decl).imp();
    if (imp < 0) continue;
    const n = importNamedLen(imp);
    if (n === 0) continue;
    const elements: NamedElement[] = [];
    const ns = importNamedStart(imp);
    for (let k = 0; k < n; k++) {
      const spec = listAt(ns, k);
      elements.push(new NamedElement(importSpecIsTypeOnly(spec), identName(importSpecLocal(spec))));
    }
    named.push(elements);
  }
  if (named.length === 0) return null;
  let hasBoth = false;
  for (let i = 0; i < named.length; i++) {
    let anyType = false;
    let anyValue = false;
    for (let k = 0; k < (named[i] as NamedElement[]).length; k++) {
      if (((named[i] as NamedElement[])[k] as NamedElement).isType) anyType = true;
      else anyValue = true;
    }
    if (anyType && anyValue) hasBoth = true;
  }
  if (!hasBoth) {
    const names: string[][] = [];
    for (let i = 0; i < named.length; i++) names.push((named[i] as NamedElement[]).map((e: NamedElement): string => e.name));
    return new Detected(detectCaseSensitivityBySort(names), orders.length === 1 ? (orders[0] as number) : -1);
  }
  // For each order, the comparer that what is there is closest to being sorted by.
  let least = -1;
  let best: Detected | null = null;
  for (let o = 0; o < orders.length; o++) {
    const order = orders[o] as number;
    const unsortedness = (comparer: number): number => {
      let total = 0;
      for (let i = 0; i < named.length; i++) {
        const elements = named[i] as NamedElement[];
        for (let k = 0; k + 1 < elements.length; k++) {
          const a = elements[k] as NamedElement;
          const b = elements[k + 1] as NamedElement;
          if (compareSpecifiers(a.isType, a.name, b.isType, b.name, comparer, order) > 0) total = total + 1;
        }
      }
      return total;
    };
    const ignoring = unsortedness(IGNORING_CASE);
    const sensitive = unsortedness(CASE_SENSITIVE);
    const count = sensitive < ignoring ? sensitive : ignoring;
    if (least < 0 || count < least) {
      least = count;
      best = new Detected(sensitive < ignoring ? CASE_SENSITIVE : IGNORING_CASE, order);
    }
  }
  return best;
}

function identName(atom: number): string {
  const b = nameBytes(atom);
  return bytesString(b, 0, b.length);
}

/** `isExternalModuleNameRelative` */
function isRelative(name: string): boolean {
  if (name === "." || name === "..") return true;
  const c0 = name.charCodeAt(0);
  const c1 = name.charCodeAt(1);
  const c2 = name.charCodeAt(2);
  if (c0 === 47 || c0 === 92) return true;
  if (c0 === 46 && (c1 === 47 || c1 === 92)) return true;
  if (c0 === 46 && c1 === 46 && (c2 === 47 || c2 === 92)) return true;
  if (name.length >= 2 && c1 === 58) return (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
  return false;
}

/** `compareModuleSpecifiersWorker` */
function compareModuleSpecifiers(a: string | null, b: string | null, comparer: number): number {
  const an = a === null ? 1 : 0;
  const bn = b === null ? 1 : 0;
  if (an !== bn) return an < bn ? -1 : 1;
  const ar = a !== null && isRelative(a) ? 1 : 0;
  const br = b !== null && isRelative(b) ? 1 : 0;
  if (ar !== br) return ar < br ? -1 : 1;
  return compareWith(comparer, a === null ? "" : a, b === null ? "" : b);
}

const SPEC_WRITTEN = 0;
const SPEC_DEFAULT = 1;

/** An element of `NamedImports`. */
class Spec {
  kind: number;
  /** The import spec (`SPEC_WRITTEN`), or the atom and the position of the name (`SPEC_DEFAULT`). */
  id: number;
  pos: number;
  constructor(kind: number, id: number, pos: number) {
    this.kind = kind;
    this.id = id;
    this.pos = pos;
  }
  isType(): boolean {
    return this.kind === SPEC_WRITTEN ? importSpecIsTypeOnly(this.id) : false;
  }
  name(): string {
    return this.kind === SPEC_WRITTEN ? identName(importSpecLocal(this.id)) : identName(this.id);
  }
  same(o: Spec): boolean {
    return this.kind === o.kind && this.id === o.id;
  }
}

/** An `ImportDeclaration` that is written in place of the old ones. */
class NewImport {
  /** The declaration that it is an update of: what its comments, its module specifier and its attributes are those of. */
  base: Decl;
  nameAtom: number;
  namePos: number;
  namespaceAtom: number;
  namespacePos: number;
  /** null: none. Empty: `{}`. */
  named: Spec[] | null;
  /** The import whose `{ }` it has (-1: none), and whether all that is written there is still in them. */
  bracesImport: number;
  bracesAll: boolean;
  constructor(base: Decl) {
    this.base = base;
    this.nameAtom = -1;
    this.namePos = -1;
    this.namespaceAtom = -1;
    this.namespacePos = -1;
    this.named = null;
    this.bracesImport = -1;
    this.bracesAll = false;
  }
  static of(base: Decl, imp: number): NewImport {
    const n = new NewImport(base);
    n.nameAtom = importDefault(imp);
    n.namePos = importDefaultPos(imp);
    n.namespaceAtom = importNamespace(imp);
    n.namespacePos = importNamespacePos(imp);
    if (importHasNamedImports(imp)) {
      n.named = [];
      const len = importNamedLen(imp);
      const ns = importNamedStart(imp);
      for (let k = 0; k < len; k++) n.named.push(new Spec(SPEC_WRITTEN, listAt(ns, k), 0));
      n.bracesImport = imp;
      n.bracesAll = true;
    }
    return n;
  }
  copy(): NewImport {
    const n = new NewImport(this.base);
    n.nameAtom = this.nameAtom;
    n.namePos = this.namePos;
    n.namespaceAtom = this.namespaceAtom;
    n.namespacePos = this.namespacePos;
    n.named = this.named === null ? null : this.named.slice();
    n.bracesImport = this.bracesImport;
    n.bracesAll = this.bracesAll;
    return n;
  }
  hasClause(): boolean {
    return this.nameAtom >= 0 || this.namespaceAtom >= 0 || this.named !== null;
  }
  isTypeOnly(): boolean {
    if (!this.hasClause()) return false;
    const imp = this.base.imp();
    return imp >= 0 && importIsTypeOnly(imp);
  }
  /** `getImportKindOrder` */
  kindOrder(): number {
    if (!this.hasClause()) return 0;
    if (this.isTypeOnly()) return 1;
    if (this.namespaceAtom >= 0) return 2;
    if (this.nameAtom >= 0) return 3;
    return 4;
  }
  /** Whether it says what `base` says. */
  isUnchanged(): boolean {
    const imp = this.base.imp();
    if (imp < 0) return false;
    if (!sameIdent(this.nameAtom, this.namePos, importDefault(imp), importDefaultPos(imp))) return false;
    if (!sameIdent(this.namespaceAtom, this.namespacePos, importNamespace(imp), importNamespacePos(imp))) return false;
    if (this.named === null) return !importHasNamedImports(imp);
    if (!importHasNamedImports(imp) || this.named.length !== importNamedLen(imp)) return false;
    const ns = importNamedStart(imp);
    for (let k = 0; k < this.named.length; k++) {
      const old = listAt(ns, k);
      const spec = this.named[k] as Spec;
      if (!(spec.kind === SPEC_WRITTEN && spec.id === old)) return false;
      const redundant =
        importSpecIsRenamed(old) &&
        !identIsString(importSpecImportedPos(old)) &&
        sameName(importSpecImported(old), importSpecLocal(old));
      if (redundant) return false;
    }
    return true;
  }
}

function sameName(a: number, b: number): boolean {
  const x = nameBytes(a);
  const y = nameBytes(b);
  return sameBytes(x, 0, x.length, y, 0, y.length);
}

function identSpanOf(atom: number, pos: number): Span {
  identSpan(atom, pos);
  return new Span(SP[0] | 0, SP[1] | 0);
}

function sameIdent(aAtom: number, aPos: number, bAtom: number, bPos: number): boolean {
  if (aAtom < 0 || bAtom < 0) return aAtom < 0 && bAtom < 0;
  const a = identSpanOf(aAtom, aPos);
  const b = identSpanOf(bAtom, bPos);
  return a.start === b.start && a.end === b.end;
}

/** An element of named imports or exports that is written. */
class Element {
  /** Where it is in the file, if it is. */
  span: Span | null;
  code: Uint8Array;
  /** Where the statement starts that it is in, and which element of that it is. */
  placeStart: number;
  placeIndex: number;
  constructor(span: Span | null, code: Uint8Array, placeStart: number, placeIndex: number) {
    this.span = span;
    this.code = code;
    this.placeStart = placeStart;
    this.placeIndex = placeIndex;
  }
}

// Where `skipTrivia` stops: `stopAfterLineBreak`, `stopAtComments`.
const STOPS_AT_TOKEN = 0;
const STOPS_AFTER_LINE_BREAK = 1;
const STOPS_AT_COMMENT = 2;
const STOPS_AFTER_LINE_BREAK_OR_AT_COMMENT = 3;

function asciiBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) | 0;
  return b;
}

function isBlankByte(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
}

class Change {
  span: Span;
  text: Uint8Array;
  constructor(span: Span, text: Uint8Array) {
    this.span = span;
    this.text = text;
  }
}

function bufEndsWith(out: ByteBuf, tail: Uint8Array): boolean {
  if (out.len < tail.length) return false;
  for (let i = 0; i < tail.length; i++) if ((out.data[out.len - tail.length + i] | 0) !== (tail[i] | 0)) return false;
  return true;
}

class Organizer {
  text: Uint8Array;
  options: OrganizeOptions;
  endOfLine: Uint8Array;
  /** The comments of the file: where they start and end, and whether they are blocks. */
  cStart: number[] = [];
  cEnd: number[] = [];
  cBlock: boolean[] = [];
  moduleComparer: number = IGNORING_CASE;
  /** -1: there is nothing to tell it by. */
  namedComparer: number = -1;
  typeOrder: number = TYPE_ORDER_LAST;
  /** The names that JSX uses, if there is JSX and it uses any. */
  jsxNames: string[] = [];
  /** What replaces which part of the text. */
  changes: Change[] = [];
  usages: Map<number, Usage> = new Map<number, Usage>();

  constructor(text: Uint8Array, options: OrganizeOptions, endOfLine: string) {
    this.text = text;
    this.options = options;
    this.endOfLine = asciiBytes(endOfLine);
  }

  // ───────────────────────────── scanner.ts ─────────────────────────────

  /** The comment that starts at `at`, or -1. */
  commentAt(at: number): number {
    let lo = 0;
    let hi = this.cStart.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.cStart[mid] as number) < at) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.cStart.length && this.cStart[lo] === at ? lo : -1;
  }

  /** If a line break is at `at`, where it ends; else -1. */
  lineBreakEnd(at: number): number {
    const t = this.text;
    const b = t[at] | 0;
    if (at >= t.length) return -1;
    if (b === 13) return (t[at + 1] | 0) === 10 && at + 1 < t.length ? at + 2 : at + 1;
    if (b === 10) return at + 1;
    if (b === 0xe2 && (t[at + 1] | 0) === 0x80 && ((t[at + 2] | 0) === 0xa8 || (t[at + 2] | 0) === 0xa9) && at + 2 < t.length) return at + 3;
    return -1;
  }

  blankEnd(at: number): number {
    const t = this.text;
    if (at >= t.length) return -1;
    const b = t[at] | 0;
    if (b === 32 || b === 9 || b === 0x0b || b === 0x0c) return at + 1;
    if (b === 0xc2 && (t[at + 1] | 0) === 0xa0) return at + 2;
    if (b === 0xef && (t[at + 1] | 0) === 0xbb && (t[at + 2] | 0) === 0xbf) return at + 3;
    return -1;
  }

  /** `skipTrivia` */
  skipTrivia(at0: number, stops: number): number {
    let at = at0;
    const stopsAfterLineBreak = stops === STOPS_AFTER_LINE_BREAK || stops === STOPS_AFTER_LINE_BREAK_OR_AT_COMMENT;
    const stopsAtComments = stops === STOPS_AT_COMMENT || stops === STOPS_AFTER_LINE_BREAK_OR_AT_COMMENT;
    while (true) {
      const lb = this.lineBreakEnd(at);
      if (lb >= 0) {
        at = lb;
        if (stopsAfterLineBreak) return at;
        continue;
      }
      const be = this.blankEnd(at);
      if (be >= 0) {
        at = be;
        continue;
      }
      const c = stopsAtComments ? -1 : this.commentAt(at);
      if (c >= 0) {
        at = this.cEnd[c] as number;
        continue;
      }
      return at;
    }
  }

  /** `getTrailingCommentRanges`: the comments from `at` to the end of the line. */
  trailingComments(at0: number): number[] {
    let at = at0;
    const found: number[] = [];
    while (true) {
      const be = this.blankEnd(at);
      if (be >= 0) {
        at = be;
        continue;
      }
      const c = this.commentAt(at);
      if (c >= 0) {
        found.push(c);
        at = this.cEnd[c] as number;
        continue;
      }
      return found;
    }
  }

  /** `getLeadingCommentRanges`: the comments from the first line break after `at`, or from the start of the file, to the next token. */
  leadingComments(at0: number): number[] {
    let at = at0;
    const found: number[] = [];
    let isCollecting = at === 0;
    while (true) {
      const lb = this.lineBreakEnd(at);
      if (lb >= 0) {
        at = lb;
        isCollecting = true;
        continue;
      }
      const be = this.blankEnd(at);
      if (be >= 0) {
        at = be;
        continue;
      }
      const c = this.commentAt(at);
      if (c >= 0) {
        if (isCollecting) found.push(c);
        at = this.cEnd[c] as number;
        continue;
      }
      return found;
    }
  }

  /** `getLineStartPositionForPosition` */
  lineStart(at: number): number {
    const end = at < this.text.length ? at : this.text.length;
    for (let i = end - 1; i >= 0; i--) {
      const b = this.text[i] | 0;
      if (b === 10 || b === 13) return i + 1;
    }
    return 0;
  }

  nextLineStart(at: number): number {
    for (let i = at; i < this.text.length; i++) {
      const b = this.text[i] | 0;
      if (b === 10 || b === 13) {
        const e = this.lineBreakEnd(i);
        return e >= 0 ? e : i + 1;
      }
    }
    return this.text.length;
  }

  // ───────────────────────────── textChanges.ts ─────────────────────────────

  /** `getEndPositionOfMultilineTrailingComment`: -1 if there is none. */
  endOfMultilineTrailingComment(end: number): number {
    const comments = this.trailingComments(end);
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i] as number;
      if (!(this.cBlock[c] as boolean)) return -1;
      if (hasLineBreakIn(this.text, this.cStart[c] as number, this.cEnd[c] as number)) {
        return this.skipTrivia(this.cEnd[c] as number, STOPS_AFTER_LINE_BREAK_OR_AT_COMMENT);
      }
    }
    return -1;
  }

  /** `getAdjustedEndPosition` with `TrailingTriviaOption.Include` */
  adjustedEnd(end: number): number {
    const m = this.endOfMultilineTrailingComment(end);
    return m >= 0 ? m : this.skipTrivia(end, STOPS_AFTER_LINE_BREAK);
  }

  /** `getAdjustedStartPosition` without a `leadingTriviaOption` */
  adjustedStart(declaration: Decl, hasTrailingComment: boolean): number {
    const fullStart = declaration.fullStart;
    const start = declaration.start();
    const fullStartLine = this.lineStart(fullStart);
    if (fullStart === start || this.lineStart(start) === fullStartLine) return start;
    if (hasTrailingComment) {
      let comment = -1;
      const leading = this.leadingComments(fullStart);
      if (leading.length > 0) comment = leading[0] as number;
      else {
        const trailing = this.trailingComments(fullStart);
        if (trailing.length > 0) comment = trailing[0] as number;
      }
      if (comment >= 0) return this.skipTrivia(this.cEnd[comment] as number, STOPS_AFTER_LINE_BREAK_OR_AT_COMMENT);
    }
    const line = fullStart > 0 ? this.nextLineStart(fullStartLine) : fullStartLine;
    return this.lineStart(this.skipTrivia(line, STOPS_AT_COMMENT));
  }

  // ───────────────────────────── organizeImports.ts ─────────────────────────────

  /** `isNewGroup`: whether there are two line breaks, not counting those in comments, before `declaration`. */
  isNewGroup(declaration: Decl): boolean {
    let at = declaration.fullStart;
    let lineBreaks = 0;
    const start = declaration.start();
    while (at < start) {
      const lb = this.lineBreakEnd(at);
      if (lb >= 0) {
        at = lb;
        lineBreaks = lineBreaks + 1;
        if (lineBreaks >= 2) return true;
        continue;
      }
      const c = this.commentAt(at);
      if (c >= 0) at = this.cEnd[c] as number;
      else at = at + 1;
    }
    return false;
  }

  /** `groupByNewlineContiguous` */
  groupByNewlineContiguous(declarations: Decl[]): Decl[][] {
    const groups: Decl[][] = [];
    for (let i = 0; i < declarations.length; i++) {
      const declaration = declarations[i] as Decl;
      if (groups.length > 0 && !this.isNewGroup(declaration)) (groups[groups.length - 1] as Decl[]).push(declaration);
      else groups.push([declaration]);
    }
    return groups;
  }

  /** Whether a JSDoc comment names `name` where TypeScript takes it for a reference: in the type after a tag, as what a `{@link}` links to, or after `@see` and the like. */
  isNamedInJsdoc(name: string): boolean {
    const text = this.text;
    const nameBytes_ = new TextEncoder().encode(name);
    const isWord = (b: number): boolean => b >= 0 && ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b === 36 || b >= 0x80);
    for (let c = 0; c < this.cStart.length; c++) {
      if (!(this.cBlock[c] as boolean)) continue;
      const cs = this.cStart[c] as number;
      const ce = this.cEnd[c] as number;
      // One that follows something on its line documents nothing, unless that is a parameter.
      let beforeEnd = cs;
      while (beforeEnd > 0 && isBlankByte(text[beforeEnd - 1] | 0)) beforeEnd = beforeEnd - 1;
      const startsLine = beforeEnd === 0 || hasLineBreakIn(text, beforeEnd, cs);
      const lastBefore = beforeEnd > 0 ? text[beforeEnd - 1] | 0 : -1;
      if (!(containsAscii(text, cs, cs + 3, "/**") && cs + 3 <= ce) || !(startsLine || lastBefore === 40 || lastBefore === 44)) continue;
      let from = cs;
      while (true) {
        const found = indexOfBytes(text, from, ce, nameBytes_);
        if (found < 0) break;
        const start = found;
        const end = found + nameBytes_.length;
        from = end;
        const prev = start > cs ? text[start - 1] | 0 : -1;
        const next = end < ce ? text[end] | 0 : -1;
        if (isWord(prev) || isWord(next) || prev === 46) continue;
        let bEnd = start;
        while (bEnd > cs && isBlankByte(text[bEnd - 1] | 0)) bEnd = bEnd - 1;
        const lastOpen = lastIndexOf(text, cs, bEnd, 123);
        const lastClose = lastIndexOf(text, cs, bEnd, 125);
        const open = lastOpen >= 0 && lastClose < lastOpen ? lastOpen : -1;
        let isReference = false;
        if (open >= 0) {
          if (open + 1 < bEnd && (text[open + 1] | 0) === 64) {
            const tag = bytesString(text, open + 2, bEnd);
            isReference = tag === "link" || tag === "linkcode" || tag === "linkplain";
          } else {
            // `@param {A}`
            let bb = open;
            while (bb > cs && isBlankByte(text[bb - 1] | 0)) bb = bb - 1;
            let w = bb;
            while (w > cs && ((text[w - 1] | 0) >= 65 && (text[w - 1] | 0) <= 90 || (text[w - 1] | 0) >= 97 && (text[w - 1] | 0) <= 122)) w = w - 1;
            isReference = w > cs && w < bb && (text[w - 1] | 0) === 64;
          }
        } else {
          const tags = ["@see", "@extends", "@augments", "@implements", "@throws"];
          for (let t = 0; t < tags.length && !isReference; t++) {
            const tag = tags[t] as string;
            if (bEnd - cs >= tag.length && containsAscii(text, bEnd - tag.length, bEnd, tag) && sliceEqualsAscii(text, bEnd - tag.length, tag)) isReference = true;
          }
        }
        if (isReference) return true;
      }
    }
    return false;
  }

  /** `isDeclarationUsed` */
  isUsed(nameAtom: number, statement: number): boolean {
    const parent = nodeParent(nodeOfStmt(statement));
    const root = parent;
    let usage = this.usages.get(root);
    if (usage === undefined) {
      usage = usageOf(nodeKind(root) === N_FILE ? root : root);
      this.usages.set(root, usage);
    }
    const name = identName(nameAtom);
    if (this.jsxNames.indexOf(name) >= 0) return true;
    const n = usage.declarations.get(nameAtom);
    if (n !== undefined && n > 1) return true;
    if (usage.refs.has(nameAtom)) return true;
    return this.isNamedInJsdoc(name);
  }

  /** `removeUnusedImports` */
  removeUnusedImports(imports: NewImport[]): NewImport[] {
    const used: NewImport[] = [];
    for (let i = 0; i < imports.length; i++) {
      const imp = imports[i] as NewImport;
      if (!imp.hasClause()) {
        used.push(imp);
        continue;
      }
      const statement = imp.base.statement;
      if (imp.nameAtom >= 0 && !this.isUsed(imp.nameAtom, statement)) {
        imp.nameAtom = -1;
        imp.namePos = -1;
      }
      if (imp.namespaceAtom >= 0 && !this.isUsed(imp.namespaceAtom, statement)) {
        imp.namespaceAtom = -1;
        imp.namespacePos = -1;
      }
      if (imp.named !== null) {
        const count = imp.named.length;
        const kept: Spec[] = [];
        for (let k = 0; k < imp.named.length; k++) {
          const s = imp.named[k] as Spec;
          if (s.kind === SPEC_WRITTEN && this.isUsed(importSpecLocal(s.id), statement)) kept.push(s);
        }
        imp.named = kept;
        if (imp.bracesImport >= 0) imp.bracesAll = kept.length === count;
        if (kept.length === 0 && count > 0) imp.named = null;
      }
      if (imp.hasClause()) {
        used.push(imp);
      } else if (this.hasModuleDeclarationMatching(imp.base.module())) {
        // `declare module "m"` needs an import of it to be an augmentation.
        const original = imp.base.imp();
        if (!fileIsDeclarationFile() && original >= 0) used.push(NewImport.of(imp.base, original));
        else used.push(imp);
      }
    }
    return used;
  }

  /** `hasModuleDeclarationMatchingSpecifier` */
  hasModuleDeclarationMatching(module: string | null): boolean {
    const n = fileBodyLen();
    const bs = fileBodyStart();
    for (let i = 0; i < n; i++) {
      const s = listAt(bs, i);
      if (stmtTag(s) !== STMT_MODULE) continue;
      const m = stmtModuleModule(s);
      if (moduleNameKind(m) === MODNAME_STRING && module !== null && identName(moduleName(m)) === module) return true;
    }
    return false;
  }

  /** What the imports that are combined have to have in common. */
  attributesKey(declaration: Decl): string {
    const row = stmtImportAttributes(declaration.statement);
    if (row < 0) return "";
    const start = importAttributesEntriesStart(row);
    const n = importAttributesEntriesLen(row);
    const entries: string[][] = [];
    for (let k = 0; k < n; k++) {
      const p = listAt(start, k);
      const owner = nodeOfProp(p);
      const v = propValue(p);
      if (v < 0) continue;
      const key = keyName(owner);
      if (key < 0) continue;
      exprSpan(v);
      const vs = SP[0] | 0;
      const ve = SP[1] | 0;
      if (ve - vs < 1) continue;
      entries.push([identName(key), bytesString(this.text, vs + 1, ve - 1)]);
    }
    const places = stableOrder(entries.length, (a: number, b: number): number => compareBytesStr((entries[a] as string[])[0] as string, (entries[b] as string[])[0] as string));
    importAttributesKeywordSpan(row);
    let key = bytesString(this.text, SP[0] | 0, SP[1] | 0) + " ";
    for (let i = 0; i < entries.length; i++) {
      const e = entries[places[i] | 0] as string[];
      key += (e[0] as string) + ':"' + (e[1] as string) + '"';
    }
    return key;
  }

  /** `coalesceImportsWorker` */
  coalesceImports(imports: NewImport[]): NewImport[] {
    const byAttributesKeys: string[] = [];
    const byAttributes: NewImport[][] = [];
    for (let i = 0; i < imports.length; i++) {
      const imp = imports[i] as NewImport;
      const key = this.attributesKey(imp.base);
      const at = byAttributesKeys.indexOf(key);
      if (at >= 0) (byAttributes[at] as NewImport[]).push(imp);
      else {
        byAttributesKeys.push(key);
        byAttributes.push([imp]);
      }
    }
    const coalesced: NewImport[] = [];
    for (let g = 0; g < byAttributes.length; g++) {
      const group = byAttributes[g] as NewImport[];
      for (let i = 0; i < group.length; i++) {
        if (!(group[i] as NewImport).hasClause()) {
          coalesced.push((group[i] as NewImport).copy());
          break;
        }
      }
      for (let pass = 0; pass < 2; pass++) {
        const isTypeOnly = pass === 1;
        const ofKind: NewImport[] = [];
        for (let i = 0; i < group.length; i++) {
          const it = group[i] as NewImport;
          if (it.hasClause() && it.isTypeOnly() === isTypeOnly) ofKind.push(it);
        }
        const defaults = ofKind.filter((it: NewImport): boolean => it.nameAtom >= 0);
        const namespaces = ofKind.filter((it: NewImport): boolean => it.namespaceAtom >= 0);
        const named = ofKind.filter((it: NewImport): boolean => it.named !== null);
        if (!isTypeOnly && defaults.length === 1 && namespaces.length === 1 && named.length === 0) {
          const n = (defaults[0] as NewImport).copy();
          n.namespaceAtom = (namespaces[0] as NewImport).namespaceAtom;
          n.namespacePos = (namespaces[0] as NewImport).namespacePos;
          n.named = null;
          coalesced.push(n);
          continue;
        }
        const places = stableOrder(namespaces.length, (a: number, b: number): number =>
          compareWith(this.moduleComparer, identName((namespaces[a] as NewImport).namespaceAtom), identName((namespaces[b] as NewImport).namespaceAtom)),
        );
        for (let i = 0; i < namespaces.length; i++) {
          const n = (namespaces[places[i] | 0] as NewImport).copy();
          n.nameAtom = -1;
          n.namePos = -1;
          n.named = null;
          coalesced.push(n);
        }
        const base = defaults.length > 0 ? (defaults[0] as NewImport) : named.length > 0 ? (named[0] as NewImport) : null;
        if (base === null) continue;
        const specifiers: Spec[] = [];
        let newDefaultAtom = -1;
        let newDefaultPos = -1;
        if (defaults.length === 1) {
          newDefaultAtom = (defaults[0] as NewImport).nameAtom;
          newDefaultPos = (defaults[0] as NewImport).namePos;
        } else {
          for (let i = 0; i < defaults.length; i++) {
            const d = defaults[i] as NewImport;
            if (d.nameAtom >= 0) specifiers.push(new Spec(SPEC_DEFAULT, d.nameAtom, d.namePos));
          }
        }
        for (let i = 0; i < named.length; i++) {
          const list = (named[i] as NewImport).named as Spec[];
          for (let k = 0; k < list.length; k++) specifiers.push(list[k] as Spec);
        }
        const comparer = this.namedComparer >= 0 ? this.namedComparer : IGNORING_CASE;
        const sp = stableOrder(specifiers.length, (a: number, b: number): number => {
          const x = specifiers[a] as Spec;
          const y = specifiers[b] as Spec;
          return compareSpecifiers(x.isType(), x.name(), y.isType(), y.name(), comparer, this.typeOrder);
        });
        const sorted: Spec[] = [];
        for (let i = 0; i < specifiers.length; i++) sorted.push(specifiers[sp[i] | 0] as Spec);
        const newNamed: Spec[] | null = sorted.length > 0 || newDefaultAtom < 0 ? sorted : null;
        const bracesFrom = named.length > 0 ? (named[0] as NewImport) : null;
        const make = (b: NewImport, nameAtom: number, namePos: number, namedList: Spec[] | null): NewImport => {
          const n = new NewImport(b.base);
          n.nameAtom = nameAtom;
          n.namePos = namePos;
          n.named = namedList;
          if (bracesFrom !== null) {
            n.bracesImport = bracesFrom.bracesImport;
            n.bracesAll = bracesFrom.bracesAll;
          }
          return n;
        };
        if (isTypeOnly && newDefaultAtom >= 0 && newNamed !== null) {
          coalesced.push(make(base, newDefaultAtom, newDefaultPos, null));
          coalesced.push(make(named.length > 0 ? (named[0] as NewImport) : base, -1, -1, newNamed));
        } else {
          coalesced.push(make(base, newDefaultAtom, newDefaultPos, newNamed));
        }
      }
    }
    return coalesced;
  }

  /** The groups of `declarations` by module, sorted. */
  sortedByModule(declarations: Decl[]): Decl[][] {
    const byModule: Decl[][] = [];
    for (let i = 0; i < declarations.length; i++) {
      const declaration = declarations[i] as Decl;
      const m = declaration.module();
      let found = -1;
      for (let k = 0; k < byModule.length; k++) {
        if (((byModule[k] as Decl[])[0] as Decl).module() === m) {
          found = k;
          break;
        }
      }
      if (found >= 0) (byModule[found] as Decl[]).push(declaration);
      else byModule.push([declaration]);
    }
    const places = stableOrder(byModule.length, (a: number, b: number): number =>
      compareModuleSpecifiers(((byModule[a] as Decl[])[0] as Decl).module(), ((byModule[b] as Decl[])[0] as Decl).module(), this.moduleComparer),
    );
    const out: Decl[][] = [];
    for (let i = 0; i < byModule.length; i++) out.push(byModule[places[i] | 0] as Decl[]);
    return out;
  }

  /** The comments that the printer writes before and after the declaration `base`, around `code`. */
  withComments(base: Decl, hasLeadingComments: boolean, code: Uint8Array, out: ByteBuf): void {
    if (hasLeadingComments) {
      const leading = this.leadingComments(base.fullStart);
      for (let i = 0; i < leading.length; i++) {
        const c = leading[i] as number;
        out.append(this.text, this.cStart[c] as number, this.cEnd[c] as number);
        const isOnItsOwnLine = !(this.cBlock[c] as boolean) || this.lineBreakEnd(this.skipBlanks(this.cEnd[c] as number)) >= 0;
        if (isOnItsOwnLine) out.append(this.endOfLine, 0, this.endOfLine.length);
        else out.push(32);
      }
    }
    out.append(code, 0, code.length);
    const trailing = this.trailingComments(base.end());
    for (let i = 0; i < trailing.length; i++) {
      const c = trailing[i] as number;
      out.push(32);
      out.append(this.text, this.cStart[c] as number, this.cEnd[c] as number);
    }
  }

  skipBlanks(at0: number): number {
    let at = at0;
    while (true) {
      const be = this.blankEnd(at);
      if (be < 0) return at;
      at = be;
    }
  }

  /** `getFullStart()` of what starts at `start`: where the token before it ends. */
  fullStartOf(start: number): number {
    let at = start;
    while (true) {
      while (at > 0 && isBlankByte(this.text[at - 1] | 0)) at = at - 1;
      // The comment that ends at `at`.
      let lo = 0;
      let hi = this.cEnd.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((this.cEnd[mid] as number) < at) lo = mid + 1;
        else hi = mid;
      }
      if (lo < this.cEnd.length && this.cEnd[lo] === at) at = this.cStart[lo] as number;
      else return at;
    }
  }

  hasLineBreakBetween(from: number, to: number): boolean {
    if (to <= from) return false;
    return hasLineBreakIn(this.text, from, to);
  }

  writeComment(c: number, out: ByteBuf): void {
    out.append(this.text, this.cStart[c] as number, this.cEnd[c] as number);
    const endsLine = !(this.cBlock[c] as boolean) || this.lineBreakEnd(this.skipBlanks(this.cEnd[c] as number)) >= 0;
    if (endsLine) out.append(this.endOfLine, 0, this.endOfLine.length);
    else out.push(32);
  }

  /** The comments on the lines after `at`, up to the next token: `emitLeadingCommentsOfPosition`. */
  writeLeadingComments(at: number, out: ByteBuf): void {
    const leading = this.leadingComments(at);
    // `emitNewLineBeforeLeadingCommentOfPosition`
    if (leading.length > 0) this.writeLine(out);
    for (let i = 0; i < leading.length; i++) this.writeComment(leading[i] as number, out);
  }

  /** `writer.writeLine()`: nothing at the start of a line. */
  writeLine(out: ByteBuf): void {
    if (out.len > 0 && (out.data[out.len - 1] | 0) === 32) out.len = out.len - 1;
    if (!bufEndsWith(out, this.endOfLine)) out.append(this.endOfLine, 0, this.endOfLine.length);
  }

  /** The comments from `at` to the end of the line. */
  writeTrailingComments(at: number, out: ByteBuf): void {
    if (at < 0) return;
    const comments = this.trailingComments(at);
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i] as number;
      out.push(32);
      out.append(this.text, this.cStart[c] as number, this.cEnd[c] as number);
      if (!(this.cBlock[c] as boolean)) out.append(this.endOfLine, 0, this.endOfLine.length);
    }
  }

  /** `emitNodeListItems` for the elements of named imports or exports, with the comments that the printer writes with them. `list`: the list that the braces are those of. */
  writeElements(elements: Element[], list: number, prefersNewLines: boolean, hasTrailingComma: boolean, out: ByteBuf): void {
    if (elements.length === 0) {
      out.appendAscii("{ }");
      return;
    }
    out.push(123);
    // `getLeadingLineTerminatorCount`
    let startsOnNewLine = prefersNewLines;
    if (!startsOnNewLine) {
      const first = elements[0] as Element;
      if (first.placeStart === list && first.span !== null) startsOnNewLine = this.hasLineBreakBetween(this.fullStartOf(first.span.start), first.span.start);
    }
    if (startsOnNewLine) out.append(this.endOfLine, 0, this.endOfLine.length);
    else out.push(32);
    // Whether what is between the `,` before an element and the end of that line is written.
    let writesInterveningComments = !startsOnNewLine;
    let previous: Element | null = null;
    for (let e = 0; e < elements.length; e++) {
      const element = elements[e] as Element;
      const fullStart = element.span === null ? -1 : this.fullStartOf(element.span.start);
      if (previous !== null) {
        if (previous.span !== null) this.writeLeadingComments(previous.span.end, out);
        out.push(44);
        // `getSeparatingLineTerminatorCount`
        let isOnNewLine: boolean;
        if (previous.span !== null && element.span !== null && previous.placeStart === element.placeStart && previous.placeIndex === element.placeIndex - 1) {
          isOnNewLine = this.hasLineBreakBetween(previous.span.end, element.span.start);
        } else {
          isOnNewLine = prefersNewLines;
        }
        if (isOnNewLine) {
          if (writesInterveningComments) this.writeTrailingComments(fullStart, out);
          this.writeLine(out);
          writesInterveningComments = false;
        } else {
          out.push(32);
        }
      }
      if (writesInterveningComments && fullStart >= 0) {
        const tc = this.trailingComments(fullStart);
        for (let i = 0; i < tc.length; i++) this.writeComment(tc[i] as number, out);
      }
      writesInterveningComments = true;
      if (fullStart >= 0) this.writeLeadingComments(fullStart, out);
      out.append(element.code, 0, element.code.length);
      this.writeTrailingComments(element.span === null ? -1 : element.span.end, out);
      previous = element;
    }
    if (previous !== null && previous.span !== null) {
      const last = previous.span;
      if (hasTrailingComma) {
        // `emitTokenWithComment`
        this.writeLeadingComments(last.end, out);
        out.push(44);
        this.writeTrailingComments(this.skipTrivia(last.end, STOPS_AT_TOKEN) + 1, out);
      } else {
        this.writeLeadingComments(last.end, out);
      }
    } else if (hasTrailingComma && previous !== null) {
      out.push(44);
    }
    if (prefersNewLines) this.writeLine(out);
    else if (!bufEndsWith(out, this.endOfLine)) out.push(32);
    out.push(125);
  }

  /** The `{ .. }` in `within`: null if there is none. */
  bracesIn(within: Span): Span | null {
    let at = within.start;
    while (at < within.end && (this.text[at] | 0) !== 123) {
      const c = this.commentAt(at);
      at = c >= 0 ? (this.cEnd[c] as number) : at + 1;
    }
    if (at < within.end && (this.text[within.end - 1] | 0) === 125) return new Span(at, within.end);
    return null;
  }

  /** `"m" with { type: "json" };` */
  writeSource(statement: number, out: ByteBuf): void {
    if (!stmtModuleSpecifierSpan(statement)) return;
    const start = SP[0] | 0;
    let end = SP[1] | 0;
    const row = stmtImportAttributes(statement);
    if (row >= 0) {
      importAttributesBracesSpan(row);
      end = SP[1] | 0;
    }
    out.append(this.text, start, end);
  }

  importCode(imp: NewImport): Uint8Array {
    if (this.isWrittenAlike(imp)) return this.asWritten(imp.base);
    const original = imp.base.imp();
    // What is before and after the braces is written as it is, with its comments.
    let ownBraces: Span | null = null;
    if (original >= 0 && imp.named !== null && imp.bracesImport === original) {
      importClauseSpan(original);
      ownBraces = this.bracesIn(new Span(SP[0] | 0, SP[1] | 0));
    }
    let hasSameName = imp.namespaceAtom < 0;
    if (hasSameName) {
      const originalDefault = original >= 0 ? importDefault(original) : -1;
      if (imp.nameAtom >= 0 || originalDefault >= 0) {
        hasSameName = imp.nameAtom >= 0 && originalDefault >= 0 && sameIdent(imp.nameAtom, imp.namePos, originalDefault, importDefaultPos(original));
      }
    }
    const out = new ByteBuf(128);
    if (ownBraces !== null && hasSameName) {
      out.append(this.text, imp.base.start(), ownBraces.start);
    } else {
      out.appendAscii("import ");
      if (imp.isTypeOnly()) out.appendAscii("type ");
      else if (imp.hasClause() && original >= 0 && importIsDeferred(original)) out.appendAscii("defer ");
      if (imp.nameAtom >= 0) {
        const s = identSpanOf(imp.nameAtom, imp.namePos);
        out.append(this.text, s.start, s.end);
        if (imp.namespaceAtom >= 0 || imp.named !== null) out.appendAscii(", ");
      }
      if (imp.namespaceAtom >= 0) {
        out.appendAscii("* as ");
        const s = identSpanOf(imp.namespaceAtom, imp.namespacePos);
        out.append(this.text, s.start, s.end);
      }
    }
    if (imp.named !== null) {
      const elements: Element[] = [];
      for (let k = 0; k < imp.named.length; k++) {
        const specifier = imp.named[k] as Spec;
        if (specifier.kind === SPEC_DEFAULT) {
          const s = identSpanOf(specifier.id, specifier.pos);
          const code = new ByteBuf(32);
          code.appendAscii("default as ");
          code.append(this.text, s.start, s.end);
          elements.push(new Element(null, bufBytes(code), 0, 0));
        } else {
          const it = specifier.id;
          const isRedundant = importSpecIsRenamed(it) && !identIsString(importSpecImportedPos(it)) && sameName(importSpecImported(it), importSpecLocal(it));
          importSpecSpan(it);
          const span = new Span(SP[0] | 0, SP[1] | 0);
          let code: Uint8Array;
          if (isRedundant) {
            const b = new ByteBuf(32);
            if (importSpecIsTypeOnly(it)) b.appendAscii("type ");
            const l = identSpanOf(importSpecLocal(it), importSpecLocalPos(it));
            b.append(this.text, l.start, l.end);
            code = bufBytes(b);
          } else {
            code = this.text.slice(span.start, span.end);
          }
          const impId = importSpecImport(it);
          stmtSpan(importStmt(impId));
          const placeStart = SP[0] | 0;
          let index = 0;
          const ns = importNamedStart(impId);
          for (let q = 0; q < importNamedLen(impId); q++) {
            if (listAt(ns, q) === it) {
              index = q;
              break;
            }
          }
          elements.push(new Element(span, code, placeStart, index));
        }
      }
      let braces: Span | null = null;
      let bracesStmtStart = 0;
      let bracesList = 0;
      if (imp.bracesImport >= 0) {
        importClauseSpan(imp.bracesImport);
        braces = this.bracesIn(new Span(SP[0] | 0, SP[1] | 0));
        stmtSpan(importStmt(imp.bracesImport));
        bracesStmtStart = SP[0] | 0;
        bracesList = bracesStmtStart;
      }
      const isMultiLine = braces !== null && this.hasLineBreakBetween(braces.start, braces.end);
      let hasTrailingComma = false;
      if (braces !== null && imp.bracesAll) {
        const bi = imp.bracesImport;
        const n = importNamedLen(bi);
        if (n > 0) {
          importSpecSpan(listAt(importNamedStart(bi), n - 1));
          const afterLast = this.skipTrivia(SP[1] | 0, STOPS_AT_TOKEN);
          hasTrailingComma = (this.text[afterLast] | 0) === 44;
        }
      }
      this.writeElements(elements, braces === null ? 0 : bracesList, isMultiLine, hasTrailingComma, out);
    }
    if (ownBraces !== null) {
      out.append(this.text, ownBraces.end, imp.base.end());
      if (!(out.len > 0 && (out.data[out.len - 1] | 0) === 59)) out.push(59);
      return bufBytes(out);
    }
    if (imp.hasClause()) out.appendAscii(" from ");
    this.writeSource(imp.base.statement, out);
    out.push(59);
    return bufBytes(out);
  }

  /** `organizeDeclsWorker`, once what replaces `old` is known: for each new declaration, the old one that it has the comments of, and its code. */
  replace(old: Decl[], bases: Decl[], codes: Uint8Array[]): void {
    if (old.length === 0) return;
    const first = old[0] as Decl;
    if (bases.length === 0) {
      for (let i = 0; i < old.length; i++) {
        const d = old[i] as Decl;
        this.changes.push(new Change(new Span(d.start(), this.adjustedEnd(d.end())), new Uint8Array(0)));
      }
      return;
    }
    const text = new ByteBuf(256);
    for (let index = 0; index < bases.length; index++) {
      const base = bases[index] as Decl;
      if (index > 0) text.append(this.endOfLine, 0, this.endOfLine.length);
      this.withComments(base, base.start() !== first.start() || base.end() !== first.end(), codes[index] as Uint8Array, text);
    }
    text.append(this.endOfLine, 0, this.endOfLine.length);
    this.changes.push(new Change(new Span(first.start(), this.adjustedEnd(first.end())), bufBytes(text)));
    let hasTrailingComment = this.endOfMultilineTrailingComment(first.end()) >= 0;
    for (let i = 1; i < old.length; i++) {
      const d = old[i] as Decl;
      const start = this.adjustedStart(d, hasTrailingComment);
      this.changes.push(new Change(new Span(start, this.adjustedEnd(d.end())), new Uint8Array(0)));
      hasTrailingComment = this.endOfMultilineTrailingComment(d.end()) >= 0;
    }
  }

  /** Whether writing `declarations` anew in the same order changes nothing: no other statement is between them, no comment that is written with the second or a later one, and none has its `;` on a later line. */
  isPlain(declarations: Decl[]): boolean {
    for (let i = 0; i < declarations.length; i++) if (this.beforeFarSemicolon(declarations[i] as Decl) !== null) return false;
    for (let i = 0; i + 1 < declarations.length; i++) {
      const a = declarations[i] as Decl;
      const b = declarations[i + 1] as Decl;
      if (!(a.end() === b.fullStart && (this.cStart.length === 0 || this.leadingComments(b.fullStart).length === 0))) return false;
    }
    return true;
  }

  /** Of a declaration with its `;` on a later line, what is before the `;`: (start, end), or null. */
  beforeFarSemicolon(declaration: Decl): Span | null {
    const start = declaration.start();
    const end = declaration.end();
    if (end <= start || (this.text[end - 1] | 0) !== 59) return null;
    let e = end - 1;
    while (e > start && isBlankByte(this.text[e - 1] | 0)) e = e - 1;
    // A comment ends there.
    let lo = 0;
    let hi = this.cEnd.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.cEnd[mid] as number) < e) lo = mid + 1;
      else hi = mid;
    }
    const isAfterComment = lo < this.cEnd.length && this.cEnd[lo] === e;
    if (!isAfterComment && hasLineBreakIn(this.text, e, end - 1)) return new Span(start, e);
    return null;
  }

  /** `declaration` the way it is written, with its `;` where the printer writes it. */
  asWritten(declaration: Decl): Uint8Array {
    const before = this.beforeFarSemicolon(declaration);
    if (before !== null) {
      const b = new ByteBuf(before.end - before.start + 1);
      b.append(this.text, before.start, before.end);
      b.push(59);
      return bufBytes(b);
    }
    return this.text.slice(declaration.start(), declaration.end());
  }

  hasCommentIn(span: Span): boolean {
    let lo = 0;
    let hi = this.cStart.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.cStart[mid] as number) < span.start) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.cStart.length && (this.cEnd[lo] as number) <= span.end;
  }

  /** Whether the printer writes `import` the way it is written. It makes a new list of what is in the braces, and leaves out some of the comments there. */
  isWrittenAlike(imp: NewImport): boolean {
    if (!imp.isUnchanged()) return false;
    const original = imp.base.imp();
    if (original >= 0) {
      importClauseSpan(original);
      const braces = this.bracesIn(new Span(SP[0] | 0, SP[1] | 0));
      if (braces !== null && this.hasCommentIn(braces)) return false;
    }
    return true;
  }

  /** `organizeImportsWorker` */
  organizeImports(old: Decl[]): void {
    let news: NewImport[] = [];
    const modules = this.sortedByModule(old);
    for (let g = 0; g < modules.length; g++) {
      const group = modules[g] as Decl[];
      let imports: NewImport[] = [];
      for (let i = 0; i < group.length; i++) {
        const imp = (group[i] as Decl).imp();
        if (imp >= 0) imports.push(NewImport.of(group[i] as Decl, imp));
      }
      if (!this.options.skipsDestructiveCodeActions) imports = this.removeUnusedImports(imports);
      imports = this.coalesceImports(imports);
      const places = stableOrder(imports.length, (a: number, b: number): number => {
        const x = (imports[a] as NewImport).kindOrder();
        const y = (imports[b] as NewImport).kindOrder();
        return x < y ? -1 : x > y ? 1 : 0;
      });
      for (let i = 0; i < imports.length; i++) news.push(imports[places[i] | 0] as NewImport);
    }
    let isSame = news.length === old.length && this.isPlain(old);
    if (isSame) {
      for (let i = 0; i < news.length; i++) {
        const n = news[i] as NewImport;
        const o = old[i] as Decl;
        if (!(n.base.start() === o.start() && n.base.end() === o.end() && this.isWrittenAlike(n))) {
          isSame = false;
          break;
        }
      }
    }
    if (!isSame) {
      const bases: Decl[] = [];
      const codes: Uint8Array[] = [];
      for (let i = 0; i < news.length; i++) {
        bases.push((news[i] as NewImport).base);
        codes.push(this.importCode(news[i] as NewImport));
      }
      this.replace(old, bases, codes);
    }
  }

  exportCode(base: Decl, items: number[]): Uint8Array {
    const stmt = base.statement;
    const x = stmtExportNamedExport(stmt);
    const out = new ByteBuf(128);
    out.appendAscii(exportIsTypeOnly(x) ? "export type " : "export ");
    const elements: Element[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as number;
      exportSpecSpan(it);
      const span = new Span(SP[0] | 0, SP[1] | 0);
      const exportId = exportSpecExport(it);
      stmtSpan(exportStmt(exportId));
      const placeStart = SP[0] | 0;
      let index = 0;
      const start = exportItemsStart(exportId);
      for (let q = 0; q < exportItemsLen(exportId); q++) {
        if (listAt(start, q) === it) {
          index = q;
          break;
        }
      }
      elements.push(new Element(span, this.text.slice(span.start, span.end), placeStart, index));
    }
    this.writeElements(elements, base.start(), false, false, out);
    if (exportHasFrom(x)) {
      out.appendAscii(" from ");
      this.writeSource(base.statement, out);
    }
    out.push(59);
    return bufBytes(out);
  }

  /** `organizeExportsWorker` */
  organizeExports(old: Decl[]): void {
    const typeOrder = this.options.typeOrder >= 0 ? this.options.typeOrder : TYPE_ORDER_LAST;
    const bases: Decl[] = [];
    const codes: Uint8Array[] = [];
    let isSame = true;
    const modules = this.sortedByModule(old);
    for (let g = 0; g < modules.length; g++) {
      const group = modules[g] as Decl[];
      // `coalesceExportsWorker`
      const stars = group.filter((it: Decl): boolean => stmtTag(it.statement) === STMT_EXPORT_STAR && stmtExportStarAlias(it.statement) < 0);
      if (stars.length > 0) {
        bases.push(stars[0] as Decl);
        codes.push(this.asWritten(stars[0] as Decl));
      }
      isSame = isSame && stars.length <= 1;
      for (let pass = 0; pass < 2; pass++) {
        const isTypeOnly = pass === 1;
        const ofKind = group.filter((it: Decl): boolean => {
          const tag = stmtTag(it.statement);
          if (tag === STMT_EXPORT_NAMED) return exportIsTypeOnly(stmtExportNamedExport(it.statement)) === isTypeOnly;
          if (tag === STMT_EXPORT_STAR && stmtExportStarAlias(it.statement) >= 0) return ((stmtExportStarFlags(it.statement) & 1) !== 0) === isTypeOnly;
          return false;
        });
        if (ofKind.length === 0) continue;
        const first = ofKind[0] as Decl;
        isSame = isSame && ofKind.length === 1;
        if (stmtTag(first.statement) !== STMT_EXPORT_NAMED) {
          bases.push(first);
          codes.push(this.asWritten(first));
          continue;
        }
        const written: number[] = [];
        for (let i = 0; i < ofKind.length; i++) {
          const d = ofKind[i] as Decl;
          if (stmtTag(d.statement) !== STMT_EXPORT_NAMED) continue;
          const x = stmtExportNamedExport(d.statement);
          const s = exportItemsStart(x);
          for (let k = 0; k < exportItemsLen(x); k++) written.push(listAt(s, k));
        }
        const comparer = this.namedComparer >= 0 ? this.namedComparer : CASE_SENSITIVE;
        const places = stableOrder(written.length, (a: number, b: number): number => {
          const x = written[a] as number;
          const y = written[b] as number;
          return compareSpecifiers(exportSpecIsTypeOnly(x), identName(exportSpecExported(x)), exportSpecIsTypeOnly(y), identName(exportSpecExported(y)), comparer, typeOrder);
        });
        const items: number[] = [];
        for (let i = 0; i < written.length; i++) items.push(written[places[i] | 0] as number);
        let isSorted = !this.hasCommentIn(new Span(first.start(), first.end()));
        for (let i = 0; i < items.length && isSorted; i++) if (items[i] !== written[i]) isSorted = false;
        isSame = isSame && isSorted;
        bases.push(first);
        codes.push(isSorted && ofKind.length === 1 ? this.asWritten(first) : this.exportCode(first, items));
      }
    }
    if (isSame) {
      isSame = bases.length === old.length && this.isPlain(old);
      for (let i = 0; isSame && i < bases.length; i++) {
        if (!((bases[i] as Decl).start() === (old[i] as Decl).start() && (bases[i] as Decl).end() === (old[i] as Decl).end())) isSame = false;
      }
    }
    if (!isSame) this.replace(old, bases, codes);
  }

  /**
   * The imports, and the groups of exports (`getTopLevelExportGroups`), among `statements`, before which the token before ends at `start`.
   */
  declarationsIn(statementsStart: number, statementsLen: number, start: number, imports: Decl[], exports: Decl[][]): void {
    exports.push([]);
    let fullStart = start;
    // Exports without a `from` that follow each other end a group.
    let isInLocalRun = false;
    for (let i = 0; i < statementsLen; i++) {
      const statement = listAt(statementsStart, i);
      const declaration = new Decl(statement, fullStart);
      fullStart = declaration.end();
      const tag = stmtTag(statement);
      const isExport = tag === STMT_EXPORT_NAMED || tag === STMT_EXPORT_STAR;
      if (isInLocalRun && !isExport) {
        isInLocalRun = false;
        exports.push([]);
      }
      if (tag === STMT_IMPORT) {
        imports.push(declaration);
      } else if (isExport) {
        isInLocalRun = isInLocalRun || declaration.module() === null;
        (exports[exports.length - 1] as Decl[]).push(declaration);
      }
    }
  }
}

function compareBytesStr(a: string, b: string): number {
  return compareCodePoints(a, b);
}

function indexOfBytes(text: Uint8Array, from: number, end: number, needle: Uint8Array): number {
  const n = needle.length;
  for (let i = from; i + n <= end; i++) {
    let same = true;
    for (let k = 0; k < n; k++) {
      if ((text[i + k] | 0) !== (needle[k] | 0)) {
        same = false;
        break;
      }
    }
    if (same) return i;
  }
  return -1;
}

function lastIndexOf(text: Uint8Array, from: number, end: number, b: number): number {
  for (let i = end - 1; i >= from; i--) if ((text[i] | 0) === b) return i;
  return -1;
}

function sliceEqualsAscii(text: Uint8Array, at: number, lit: string): boolean {
  for (let i = 0; i < lit.length; i++) if ((text[at + i] | 0) !== lit.charCodeAt(i)) return false;
  return true;
}

/** The text that the plugin hands to Prettier in place of the file. null: the same text, or one that is formatted the same. */
export function preprocess(options: OrganizeOptions, endOfLine: string): Uint8Array | null {
  const hir$ = hir;
  const text = hir$.text.subarray(0, hir$.sourceLen | 0);
  if (containsAscii(text, 0, text.length, "// organize-imports-ignore") || containsAscii(text, 0, text.length, "// tslint:disable:ordered-imports")) return null;
  const n = fileBodyLen();
  const bs = fileBodyStart();
  let anyDeclaration = false;
  for (let i = 0; i < n; i++) {
    const tag = stmtTag(listAt(bs, i));
    if (tag === STMT_IMPORT || tag === STMT_EXPORT_NAMED || tag === STMT_EXPORT_STAR || tag === STMT_MODULE) anyDeclaration = true;
  }
  if (!anyDeclaration) return null;
  const organizer = new Organizer(text, options, endOfLine);
  let shebangEnd = 0;
  const cn = commentsLen();
  for (let i = 0; i < cn; i++) {
    if (commentKindAt(i) === TK_SHEBANG) {
      if (i === 0) shebangEnd = commentEndAt(i);
      continue;
    }
    organizer.cStart.push(commentStartAt(i));
    organizer.cEnd.push(commentEndAt(i));
    organizer.cBlock.push(commentKindAt(i) === TK_BLOCK);
  }
  const imports: Decl[] = [];
  const exports: Decl[][] = [];
  organizer.declarationsIn(bs, n, shebangEnd, imports, exports);
  const groups = organizer.groupByNewlineContiguous(imports);

  const names: string[][] = [];
  for (let g = 0; g < groups.length; g++) {
    const list: string[] = [];
    const group = groups[g] as Decl[];
    for (let i = 0; i < group.length; i++) {
      const m = (group[i] as Decl).module();
      list.push(m === null ? "" : m);
    }
    names.push(list);
  }
  organizer.moduleComparer = detectCaseSensitivityBySort(names);
  const orders = options.typeOrder >= 0 ? [options.typeOrder] : [TYPE_ORDER_LAST, TYPE_ORDER_INLINE, TYPE_ORDER_FIRST];
  const detected = detectNamedImportOrganizationBySort(imports, orders);
  organizer.namedComparer = detected === null ? -1 : detected.comparer;
  organizer.typeOrder = options.typeOrder >= 0 ? options.typeOrder : detected !== null && detected.typeOrder >= 0 ? detected.typeOrder : TYPE_ORDER_LAST;

  let hasJsx = false;
  if (options.jsxNeedsImport) {
    for (let e = 0; e < hir$.nExprs; e++) {
      if ((hir$.exprTag[e] | 0) === EXPR_JSX) {
        hasJsx = true;
        break;
      }
    }
  }
  if (hasJsx) {
    // `/** @jsx h */`
    fileProgramSpan();
    const firstToken = SP[0] | 0;
    const pragma = (name: string): string | null => {
      for (let c = 0; c < organizer.cStart.length; c++) {
        if ((organizer.cEnd[c] as number) > firstToken) break;
        if (!(organizer.cBlock[c] as boolean)) continue;
        const cs = organizer.cStart[c] as number;
        const ce = organizer.cEnd[c] as number;
        const at = indexOfBytes(text, cs, ce, asciiBytes(name));
        if (at < 0) continue;
        let p = at + name.length;
        if ((text[p] | 0) !== 32) continue;
        p = p + 1;
        while (p < ce && isBlankByte(text[p] | 0)) p = p + 1;
        let q = p;
        while (q < ce) {
          const b = text[q] | 0;
          if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b === 36) q = q + 1;
          else break;
        }
        return bytesString(text, p, q);
      }
      return null;
    };
    const ns = pragma("@jsx");
    organizer.jsxNames.push(ns !== null ? ns : options.jsxNamespace);
    const frag = pragma("@jsxFrag");
    const fragment = frag !== null ? frag : options.jsxFragmentFactory.length > 0 ? options.jsxFragmentFactory : null;
    if (fragment !== null) organizer.jsxNames.push(fragment);
  }

  for (let g = 0; g < groups.length; g++) organizer.organizeImports(groups[g] as Decl[]);
  for (let g = 0; g < exports.length; g++) {
    const subgroups = organizer.groupByNewlineContiguous(exports[g] as Decl[]);
    for (let k = 0; k < subgroups.length; k++) organizer.organizeExports(subgroups[k] as Decl[]);
  }
  for (let i = 0; i < n; i++) {
    const statement = listAt(bs, i);
    if (stmtTag(statement) !== STMT_MODULE) continue;
    const m = stmtModuleModule(statement);
    // `ModuleName::String(_) | ModuleName::Global`
    if (!moduleBodySpan(m)) continue;
    const bodyStart = SP[0] | 0;
    const moduleImports: Decl[] = [];
    const moduleExports: Decl[][] = [];
    organizer.declarationsIn(moduleBodyStart(m), moduleBodyLen(m), bodyStart + 1, moduleImports, moduleExports);
    const importGroups = organizer.groupByNewlineContiguous(moduleImports);
    for (let k = 0; k < importGroups.length; k++) organizer.organizeImports(importGroups[k] as Decl[]);
    const flat: Decl[] = [];
    for (let k = 0; k < moduleExports.length; k++) for (let q = 0; q < (moduleExports[k] as Decl[]).length; q++) flat.push((moduleExports[k] as Decl[])[q] as Decl);
    organizer.organizeExports(flat);
  }

  const changes = organizer.changes;
  if (changes.length === 0) return null;
  const places = stableOrder(changes.length, (a: number, b: number): number => {
    const x = (changes[a] as Change).span.start;
    const y = (changes[b] as Change).span.start;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const out = new ByteBuf(text.length + 64);
  let at = 0;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[places[i] | 0] as Change;
    const upTo = c.span.start > at ? c.span.start : at;
    out.append(text, at, upTo > text.length ? text.length : upTo);
    out.append(c.text, 0, c.text.length);
    if (c.span.end > at) at = c.span.end;
  }
  if (at < text.length) out.append(text, at, text.length);
  return bufBytes(out);
}
