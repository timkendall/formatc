// Port of vendor/bun/src/format/js/sort_imports/trivago.rs: `@trivago/prettier-plugin-sort-imports` 6.0: its `preprocessor`.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { Glob, fromMinimatch } from "../../../driver/glob.ts";
import { fileName, isBuiltinModule } from "../../../lint/ast/index.ts";
import {
  Attached,
  Comment,
  Declaration,
  Model,
  NO_LIST,
  N_IMPORT,
  N_NEW_LINE,
  SPEC_NAMESPACE,
  Specifier,
  mkNode,
  nodeKindOf,
  nodePayload,
} from "./babel.ts";
import { localeCompare, naturalSort } from "./compare.ts";
import { PIECE_COMMENT, PROLOGUE_OMITTED, Piece, Printer } from "./generator.ts";
import { isUnchanged } from "./layout.ts";
import { stableOrder } from "./sort.ts";
import { Span, bufBytes, bytesString, utf16Len } from "./util.ts";

export const THIRD_PARTY_MODULES = "<THIRD_PARTY_MODULES>";
export const BUILTIN_MODULES = "<BUILTIN_MODULES>";
export const THIRD_PARTY_TYPES = "<THIRD_PARTY_TS_TYPES>";
export const TYPES = "<TS_TYPES>";
export const SEPARATOR = "<SEPARATOR>";

/** An element of `importOrder`. */
export class TrivagoGroup {
  text: string;
  regex: RegExp;
  /** The first element with the same text: they are one group. */
  sameAs: number;
  constructor(text: string, regex: RegExp, sameAs: number) {
    this.text = text;
    this.regex = regex;
    this.sameAs = sameAs;
  }
  isForTypes(): boolean {
    return this.text.startsWith(TYPES);
  }
}

export const BY_LENGTH_NONE: number = 0;
export const BY_LENGTH_ASCENDING: number = 1;
export const BY_LENGTH_DESCENDING: number = 2;

/** An element of `importOrderExclude`: a Minimatch with its default options. */
export class TrivagoExclude {
  /** null: a `#` comment, which matches nothing. */
  glob: Glob | null;
  isNegated: boolean;
  hasSlash: boolean;
  constructor(pattern: string) {
    let bangs = 0;
    while (bangs < pattern.length && pattern.charCodeAt(bangs) === 33) bangs = bangs + 1;
    this.glob = pattern.startsWith("#") ? null : new Glob(fromMinimatch(pattern.substring(bangs)));
    this.isNegated = bangs % 2 === 1;
    this.hasSlash = pattern.indexOf("/") >= 0;
  }
  matches(path: string): boolean {
    if (this.glob === null) return false;
    const withoutSlash = path.endsWith("/") ? path.substring(0, path.length - 1) : null;
    const hit = this.glob.matches(path) || (withoutSlash !== null && this.glob.matches(withoutSlash));
    return hit !== this.isNegated;
  }
}

export class TrivagoOptions {
  /** `importOrder`, with `<THIRD_PARTY_MODULES>` before it if it does not have it. */
  order: TrivagoGroup[] = [];
  isCaseInsensitive: boolean = false;
  separation: boolean = false;
  groupNamespaceSpecifiers: boolean = false;
  sortSpecifiers: boolean = false;
  sortByLength: number = BY_LENGTH_NONE;
  sideEffects: boolean = true;
  attributesKeyword: string = "with";
  exclude: TrivagoExclude[] = [];

  indexOf(text: string): number {
    for (let i = 0; i < this.order.length; i++) if ((this.order[i] as TrivagoGroup).text === text) return i;
    return -1;
  }

  /** `shouldSkipFile` */
  skips(path: string): boolean {
    const name = fileName(path);
    for (let i = 0; i < this.exclude.length; i++) {
      const it = this.exclude[i] as TrivagoExclude;
      if (it.matches(it.hasSlash ? path : name)) return true;
    }
    return false;
  }

  /** `getImportNodesMatchedGroup` */
  groupOf(source: string, sourceBytes: Uint8Array, isType: boolean): number {
    const builtin = this.indexOf(BUILTIN_MODULES);
    if (builtin >= 0 && isBuiltinModule(sourceBytes, 0, sourceBytes.length)) return builtin;
    let first = -1;
    let firstIsTypes = false;
    let typed = -1;
    for (let i = 0; i < this.order.length; i++) {
      const group = this.order[i] as TrivagoGroup;
      if (!((isType || !group.isForTypes()) && group.regex.test(source))) continue;
      if (first < 0) {
        first = group.sameAs;
        firstIsTypes = group.isForTypes();
        if (!(isType && !firstIsTypes)) break;
      } else if (group.isForTypes()) {
        typed = group.sameAs;
        break;
      }
    }
    if (first < 0) {
      const forTypes = isType ? this.indexOf(THIRD_PARTY_TYPES) : -1;
      if (forTypes >= 0) return forTypes;
      const third = this.indexOf(THIRD_PARTY_MODULES);
      return third >= 0 ? third : 0;
    }
    if (isType && !firstIsTypes) return typed >= 0 ? typed : first;
    return first;
  }
}

/** `isSortImportsIgnored` */
function isIgnored(model: Model, comments: number[]): boolean {
  for (let i = 0; i < comments.length; i++) {
    const v = model.commentValue(comments[i] as number);
    let s = v.start;
    while (s < v.end) {
      const b = model.text[s] | 0;
      if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13 || b === 0x0b) s = s + 1;
      else break;
    }
    const lit = "sort-imports-ignore";
    if (v.end - s >= lit.length) {
      let same = true;
      for (let k = 0; k < lit.length; k++) {
        if ((model.text[s + k] | 0) !== lit.charCodeAt(k)) {
          same = false;
          break;
        }
      }
      if (same) return true;
    }
  }
  return false;
}

function hasNamespace(model: Model, declaration: Declaration): boolean {
  const specifiers = model.specifiersOf(declaration);
  for (let i = 0; i < specifiers.length; i++) if ((model.specifiers[specifiers[i] as number] as Specifier).kind === SPEC_NAMESPACE) return true;
  return false;
}

function sourceString(model: Model, declaration: Declaration): string {
  const b = model.sourceOf(declaration);
  return bytesString(b, 0, b.length);
}

/** `getSortedNodesByImportOrder` */
function sortedByImportOrder(model: Model, nodes: number[], options: TrivagoOptions, out: number[]): void {
  const grouped: number[] = []; // [group, index] pairs
  for (let i = 0; i < nodes.length; i++) {
    const index = nodes[i] as number;
    const declaration = model.declarations[index] as Declaration;
    const sourceBytes = model.sourceOf(declaration);
    grouped.push(options.groupOf(sourceString(model, declaration), sourceBytes, declaration.isType));
    grouped.push(index);
  }
  const n = nodes.length;
  // `getSortedNodesGroup`, for each group.
  const byGroup = stableOrder(n, (a: number, b: number): number => {
    const x = grouped[a * 2] as number;
    const y = grouped[b * 2] as number;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const items: number[] = []; // indices of declarations, sorted by group
  const itemGroup: number[] = [];
  for (let i = 0; i < n; i++) {
    items.push(grouped[(byGroup[i] | 0) * 2 + 1] as number);
    itemGroup.push(grouped[(byGroup[i] | 0) * 2] as number);
  }
  const sources = new Map<number, string>();
  const lengths = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const d = model.declarations[items[i] as number] as Declaration;
    sources.set(items[i] as number, sourceString(model, d));
    lengths.set(items[i] as number, d.hasSpan ? utf16Len(model.text, d.start, d.end) : 0);
  }
  let start = 0;
  while (start < n) {
    let end = start;
    while (end < n && itemGroup[end] === itemGroup[start]) end = end + 1;
    const slice = items.slice(start, end);
    const places = stableOrder(slice.length, (ai: number, bi: number): number => {
      const a = slice[ai] as number;
      const b = slice[bi] as number;
      let order = 0;
      if (options.groupNamespaceSpecifiers) {
        const ha = hasNamespace(model, model.declarations[a] as Declaration) ? 1 : 0;
        const hb = hasNamespace(model, model.declarations[b] as Declaration) ? 1 : 0;
        // `has_namespace(b).cmp(&has_namespace(a))`
        order = hb === ha ? 0 : hb > ha ? 1 : -1;
      }
      if (order !== 0) return order;
      const aSource = sources.get(a) as string;
      const bSource = sources.get(b) as string;
      if (options.sortByLength === BY_LENGTH_ASCENDING || options.sortByLength === BY_LENGTH_DESCENDING) {
        const la = lengths.get(a) as number;
        const lb = lengths.get(b) as number;
        const byLength = options.sortByLength === BY_LENGTH_ASCENDING ? (la < lb ? -1 : la > lb ? 1 : 0) : lb < la ? -1 : lb > la ? 1 : 0;
        return byLength !== 0 ? byLength : localeCompare(aSource, bSource);
      }
      return naturalSort(aSource, bSource, options.isCaseInsensitive);
    });
    for (let i = 0; i < slice.length; i++) items[start + i] = slice[places[i] | 0] as number;
    start = end;
  }

  if (options.sortSpecifiers) {
    for (let i = 0; i < n; i++) sortSpecifiers(model, items[i] as number, options);
  }

  const hasUserProvidedSeparators = options.indexOf(SEPARATOR) >= 0;
  let isSafeToAddNewLine = false;
  for (let g = 0; g < options.order.length; g++) {
    const group = options.order[g] as TrivagoGroup;
    if (options.separation && group.text === SEPARATOR && isSafeToAddNewLine) out.push(mkNode(N_NEW_LINE, 0));
    const before = out.length;
    for (let i = 0; i < n; i++) if (itemGroup[i] === group.sameAs) out.push(mkNode(N_IMPORT, items[i] as number));
    if (out.length === before) continue;
    isSafeToAddNewLine = true;
    if (options.separation && !hasUserProvidedSeparators) out.push(mkNode(N_NEW_LINE, 0));
  }
}

/** `getSortedImportSpecifiers` */
function sortSpecifiers(model: Model, index: number, options: TrivagoOptions): void {
  const declaration = model.declarations[index] as Declaration;
  const start = declaration.specifiersStart;
  const len = declaration.specifiersLen;
  const slice = model.orders.slice(start, start + len);
  const places = stableOrder(slice.length, (ai: number, bi: number): number => {
    const a = model.specifiers[slice[ai] as number] as Specifier;
    const b = model.specifiers[slice[bi] as number] as Specifier;
    if (a.kind === b.kind) {
      const ab = a.localBytes();
      const bb = b.localBytes();
      return naturalSort(bytesString(ab, 0, ab.length), bytesString(bb, 0, bb.length), options.isCaseInsensitive);
    }
    return a.kind === 0 ? -1 : 1;
  });
  for (let i = 0; i < slice.length; i++) model.orders[start + i] = slice[places[i] | 0] as number;
}

/** `getSortedNodes` */
function sortedNodes(model: Model, options: TrivagoOptions): number[] {
  const isSideEffect = (index: number): boolean => !options.sideEffects && (model.declarations[index] as Declaration).specifiersLen === 0;
  const count = model.declarations.length;
  const nodes: number[] = [];
  let start = 0;
  while (start < count) {
    const kind = isSideEffect(start);
    let end = start;
    while (end < count && isSideEffect(end) === kind) end = end + 1;
    if (kind) {
      for (let i = start; i < end; i++) nodes.push(mkNode(N_IMPORT, i));
    } else {
      const chunk: number[] = [];
      for (let i = start; i < end; i++) chunk.push(i);
      sortedByImportOrder(model, chunk, options, nodes);
    }
    if (options.separation) nodes.push(mkNode(N_NEW_LINE, 0));
    start = end;
  }
  if (nodes.length > 0 && !options.separation) nodes.push(mkNode(N_NEW_LINE, 0));

  // `adjustCommentsOnSortedNodes`
  const firstComments = (model.declarations[0] as Declaration).comments.leading;
  for (let i = 0; i < model.declarations.length; i++) {
    const declaration = model.declarations[i] as Declaration;
    const attached = new Attached();
    attached.leading = declaration.comments.leading;
    declaration.comments = attached;
  }
  (model.declarations[0] as Declaration).comments.leading = NO_LIST;
  for (let at = 0; at < firstComments.len; at++) {
    const comment = model.listAt(firstComments, at);
    (model.comments[comment] as Comment).hasLoc = false;
  }
  if (nodes.length > 0 && nodeKindOf(nodes[0] as number) === N_IMPORT) {
    const first = nodePayload(nodes[0] as number);
    const own = (model.declarations[first] as Declaration).comments.leading;
    (model.declarations[first] as Declaration).comments.leading = model.concat(firstComments, own);
  }
  return nodes;
}

/**
 * The text that the plugin hands to Prettier in place of the file of `model`. null: it is formatted the same.
 */
export function preprocess(model: Model, options: TrivagoOptions, endOfLine: string, path: string): Uint8Array | null {
  if (options.skips(path)) return null;
  const firstStatement = model.firstStatement;
  if (firstStatement === null) return null;
  if (isIgnored(model, model.list(firstStatement.list))) return null;
  for (let i = 0; i < model.declarations.length; i++) {
    if (isIgnored(model, model.list((model.declarations[i] as Declaration).comments.leading))) return null;
  }
  const firstList = model.list(firstStatement.list);
  const injectAt = firstList.length > 0 ? (model.comments[firstList[0] as number] as Comment).start : firstStatement.start;

  const nodes = sortedNodes(model, options);
  const printer = new Printer(model, options.attributesKeyword, endOfLine);
  printer.generate(PROLOGUE_OMITTED, nodes);
  if (printer.hasFailed) return null;

  // `assembleUpdatedCode`
  const removed: Span[] = [];
  for (let i = 0; i < model.declarations.length; i++) {
    const d = model.declarations[i] as Declaration;
    if (d.hasSpan) removed.push(new Span(d.start, d.end));
  }
  for (let i = 0; i < model.declarations.length; i++) {
    const d = model.declarations[i] as Declaration;
    const list = model.list(d.comments.leading);
    for (let k = 0; k < list.length; k++) {
      const c = model.comments[list[k] as number] as Comment;
      removed.push(new Span(c.start, c.end));
    }
  }
  const places = stableOrder(removed.length, (a: number, b: number): number => {
    const x = (removed[a] as Span).start;
    const y = (removed[b] as Span).start;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const text = model.text;
  const code = printer.code();
  const out = new ByteBuf(model.restStart + code.length + 64);
  const pieces: Piece[] = [];
  let commentAt = 0;
  let isInjected = false;
  // Appends the text from `at` to `to`, with the code in it.
  const keep = (at0: number, to: number): void => {
    let at = at0;
    if (!isInjected && injectAt <= to) {
      isInjected = true;
      const upTo = injectAt > at ? injectAt : at;
      out.append(text, at, upTo);
      at = upTo;
      const moved = out.len;
      for (let i = 0; i < printer.pieces.length; i++) {
        const p = printer.pieces[i] as Piece;
        pieces.push(new Piece(p.kind, p.id, p.start + moved, p.end + moved));
      }
      out.append(code, 0, code.length);
    }
    // The comments that stay.
    while (commentAt < model.comments.length && (model.comments[commentAt] as Comment).start < to) {
      const comment = model.comments[commentAt] as Comment;
      if (comment.start >= (at > injectAt ? at : injectAt)) {
        const start = out.len + comment.start - at;
        pieces.push(new Piece(PIECE_COMMENT, commentAt, start, start + (comment.end - comment.start)));
      }
      commentAt = commentAt + 1;
    }
    out.append(text, at, to);
  };
  let at = 0;
  for (let i = 0; i < removed.length; i++) {
    const span = removed[places[i] | 0] as Span;
    if (span.start > at) keep(at, span.start);
    if (span.end > at) at = span.end;
  }
  const restStart = model.restStart > at ? model.restStart : at;
  keep(at, restStart);
  const newRestStart = out.len;
  const outBytes = out.data.subarray(0, out.len);
  if (!printer.hasChangedComment && isUnchanged(model, injectAt, outBytes, injectAt, pieces, newRestStart)) return null;
  out.append(text, restStart, text.length);
  return bufBytes(out);
}
