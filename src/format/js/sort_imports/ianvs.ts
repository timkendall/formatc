// Port of vendor/bun/src/format/js/sort_imports/ianvs.rs: `@ianvs/prettier-plugin-sort-imports` 4.7: its `preprocessor`.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { isBuiltinModule } from "../../../lint/ast/index.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../../text.ts";
import {
  Attached,
  Comment,
  Declaration,
  Directive,
  Lines,
  List,
  Model,
  N_EMPTY,
  N_IMPORT,
  N_NEW_LINE,
  N_SPECIFIER,
  SPEC_DEFAULT,
  SPEC_NAMED,
  SPEC_NAMESPACE,
  Specifier,
  WHICH_INNER,
  WHICH_LEADING,
  WHICH_TRAILING,
  mkNode,
  nodeKindOf,
  nodePayload,
} from "./babel.ts";
import { localeCompareNumericBase, naturalSortCaseSensitive } from "./compare.ts";
import { PIECE_COMMENT, PROLOGUE_INCLUDED, Piece, Printer } from "./generator.ts";
import { isUnchanged } from "./layout.ts";
import { stableOrder } from "./sort.ts";
import { Span, bufBytes, bytesString } from "./util.ts";

export const THIRD_PARTY_MODULES = "<THIRD_PARTY_MODULES>";
export const BUILTIN_MODULES = "<BUILTIN_MODULES>";
export const TYPES = "<TYPES>";

export const M_SEPARATOR: number = 0;
export const M_THIRD_PARTY: number = 1;
export const M_BUILTIN: number = 2;
/** `<TYPES>` and nothing else. */
export const M_TYPES: number = 3;
export const M_REGEX: number = 4;

/** An element of `importOrder`. */
export class IanvsGroup {
  matcher: number;
  regex: RegExp | null;
  /** For `M_REGEX`: it has `<TYPES>` in it. */
  isForTypes: boolean;
  /** The first element with the same text: they are one group. */
  sameAs: number;
  constructor(matcher: number, regex: RegExp | null, isForTypes: boolean, sameAs: number) {
    this.matcher = matcher;
    this.regex = regex;
    this.isForTypes = isForTypes;
    this.sameAs = sameAs;
  }
}

export class IanvsOptions {
  /** `importOrder`, normalized. */
  order: IanvsGroup[] = [];
  combineTypeAndValueImports: boolean = true;
  isCaseSensitive: boolean = false;
  safeSideEffects: RegExp[] = [];

  hasSeparators(): boolean {
    for (let i = 0; i < this.order.length; i++) if ((this.order[i] as IanvsGroup).matcher === M_SEPARATOR) return true;
    return false;
  }

  hasTypes(): boolean {
    for (let i = 0; i < this.order.length; i++) {
      const g = this.order[i] as IanvsGroup;
      if (g.matcher === M_TYPES || (g.matcher === M_REGEX && g.isForTypes)) return true;
    }
    return false;
  }

  compare(a: string, b: string): number {
    return this.isCaseSensitive ? naturalSortCaseSensitive(a, b) : localeCompareNumericBase(a, b);
  }

  /** `getImportNodesMatchedGroup`. -1: there is no such group, which is an error. */
  groupOf(source: string, sourceBytes: Uint8Array, isType: boolean): number {
    const hasTypes = this.hasTypes();
    for (let i = 0; i < this.order.length; i++) {
      const group = this.order[i] as IanvsGroup;
      let isMatched = false;
      if (group.matcher === M_BUILTIN) isMatched = !(hasTypes && isType) && isBuiltinModule(sourceBytes, 0, sourceBytes.length);
      else if (group.matcher === M_REGEX && group.isForTypes) isMatched = isType && (group.regex as RegExp).test(source);
      else if (group.matcher === M_REGEX) isMatched = !(hasTypes && isType) && (group.regex as RegExp).test(source);
      if (isMatched) return group.sameAs;
    }
    const want = hasTypes && isType ? M_TYPES : M_THIRD_PARTY;
    for (let i = 0; i < this.order.length; i++) if ((this.order[i] as IanvsGroup).matcher === want) return i;
    return -1;
  }
}

/** `hasIgnoreNextNode` */
function hasIgnoreNextNode(model: Model, comments: number[]): boolean {
  for (let i = 0; i < comments.length; i++) {
    const v = model.commentValue(comments[i] as number);
    const s = trimJsWhitespaceStart(model.text, v.start, v.end);
    const e = trimJsWhitespaceEnd(model.text, s, v.end);
    if (bytesString(model.text, s, e) === "prettier-ignore") return true;
  }
  return false;
}

function hasKind(model: Model, declaration: Declaration, kind: number): boolean {
  const specifiers = model.specifiersOf(declaration);
  for (let i = 0; i < specifiers.length; i++) if ((model.specifiers[specifiers[i] as number] as Specifier).kind === kind) return true;
  return false;
}

/** `mergeNodes`: whether `forget` has been merged into `keep`. */
function mergeNodes(model: Model, keep: number, forget: number): boolean {
  const kept = (model.declarations[keep] as Declaration).copy();
  const forgotten = (model.declarations[forget] as Declaration).copy();
  // `mergeIsSafe`
  if (hasKind(model, kept, SPEC_NAMESPACE) || hasKind(model, forgotten, SPEC_NAMESPACE)) return false;
  if (hasKind(model, kept, SPEC_DEFAULT) && hasKind(model, forgotten, SPEC_DEFAULT)) return false;
  if ((kept.isType && hasKind(model, kept, SPEC_DEFAULT)) || (forgotten.isType && hasKind(model, forgotten, SPEC_DEFAULT))) return false;
  // `convertTypeImportToValueImport`
  if (kept.isType !== forgotten.isType) {
    const converted = kept.isType ? keep : forget;
    const d = model.declarations[converted] as Declaration;
    d.isType = false;
    for (let at = d.specifiersStart; at < d.specifiersStart + d.specifiersLen; at++) {
      const specifier = model.specifiers[model.orders[at] as number] as Specifier;
      specifier.isType = specifier.isType || specifier.kind === SPEC_NAMED;
    }
  }
  const all: number[] = model.specifiersOf(kept).concat(model.specifiersOf(forgotten));
  const specifiers = model.newSpecifiers(all);
  const comments = new Attached();
  comments.leading = model.concat(kept.comments.leading, forgotten.comments.leading);
  comments.inner = model.concat(kept.comments.inner, forgotten.comments.inner);
  comments.trailing = model.concat(kept.comments.trailing, forgotten.comments.trailing);
  const target = model.declarations[keep] as Declaration;
  target.specifiersStart = specifiers.start;
  target.specifiersLen = specifiers.end;
  target.comments = comments;
  return true;
}

/** `mergeNodesWithMatchingImportFlavors` */
function mergeNodesWithMatchingImportFlavors(model: Model, nodes: number[], options: IanvsOptions): number[] {
  const textStart = model.textStart();
  const deleted: number[] = [];
  // By source, the node that others are merged into.
  let context: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const isType = pass === 1;
    if (!options.combineTypeAndValueImports) context = [];
    for (let n = 0; n < nodes.length; n++) {
      const node = nodes[n] as number;
      const declaration = model.declarations[node] as Declaration;
      if (
        hasIgnoreNextNode(model, model.list(declaration.comments.leading)) ||
        declaration.specifiersLen === 0 ||
        declaration.isType !== isType ||
        deleted.indexOf(node) >= 0
      ) {
        continue;
      }
      const source = sourceKey(model, declaration);
      let at = -1;
      for (let k = 0; k < context.length; k++) {
        if (sourceKey(model, model.declarations[context[k] as number] as Declaration) === source) {
          at = k;
          break;
        }
      }
      if (at < 0) {
        context.push(node);
        continue;
      }
      const existing = context[at] as number;
      const start = (index: number): number => {
        const d = model.declarations[index] as Declaration;
        return d.hasSpan ? d.start - textStart : 0;
      };
      if (start(existing) !== 0 && start(node) !== 0 && start(existing) > start(node)) {
        if (mergeNodes(model, node, existing)) {
          deleted.push(existing);
          context[at] = node;
        }
      } else if (mergeNodes(model, existing, node)) {
        deleted.push(node);
      }
    }
  }
  const kept: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (deleted.indexOf(nodes[i] as number) < 0) kept.push(nodes[i] as number);
  return kept;
}

function sourceKey(model: Model, declaration: Declaration): string {
  const b = model.sourceOf(declaration);
  return bytesString(b, 0, b.length);
}

/** `explodeTypeAndValueSpecifiers` */
function explodeTypeAndValueSpecifiers(model: Model, nodes: number[]): number[] {
  const exploded: number[] = [];
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n] as number;
    const declaration = model.declarations[node] as Declaration;
    const specifiers = model.specifiersOf(declaration);
    const types: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < specifiers.length; i++) {
      const s = model.specifiers[specifiers[i] as number] as Specifier;
      if (s.kind === SPEC_NAMED && s.isType) types.push(specifiers[i] as number);
      else values.push(specifiers[i] as number);
    }
    if (declaration.isType || specifiers.length <= 1 || types.length === 0 || types.length === specifiers.length) {
      exploded.push(node);
      continue;
    }
    for (let pass = 0; pass < 2; pass++) {
      const isType = pass === 1;
      const list = isType ? types : values;
      for (let i = 0; i < list.length; i++) (model.specifiers[list[i] as number] as Specifier).isType = false;
      exploded.push(model.declarations.length);
      const range = model.newSpecifiers(list);
      const d = declaration.copy();
      d.hasSpan = false;
      d.hasLines = false;
      d.isType = isType;
      d.specifiersStart = range.start;
      d.specifiersLen = range.end;
      d.hasAttributes = false;
      d.comments = new Attached();
      model.declarations.push(d);
    }
  }
  return exploded;
}

/** `getSortedImportSpecifiers` */
function sortSpecifiers(model: Model, index: number, options: IanvsOptions): void {
  const declaration = model.declarations[index] as Declaration;
  const start = declaration.specifiersStart;
  const len = declaration.specifiersLen;
  const slice = model.orders.slice(start, start + len);
  const places = stableOrder(slice.length, (ai: number, bi: number): number => {
    const a = model.specifiers[slice[ai] as number] as Specifier;
    const b = model.specifiers[slice[bi] as number] as Specifier;
    if (a.kind !== b.kind) return a.kind === SPEC_DEFAULT ? -1 : 1;
    if (a.isType === b.isType) {
      const ab = a.localBytes();
      const bb = b.localBytes();
      return options.compare(bytesString(ab, 0, ab.length), bytesString(bb, 0, bb.length));
    }
    return a.isType ? 1 : -1;
  });
  for (let i = 0; i < slice.length; i++) model.orders[start + i] = slice[places[i] | 0] as number;
}

/** `getSortedNodesByImportOrder`. false: an import belongs to no group. */
function sortedByImportOrder(model: Model, nodes: number[], options: IanvsOptions, out: number[]): boolean {
  const n = nodes.length;
  const groups: number[] = [];
  const sources = new Map<number, string>();
  for (let i = 0; i < n; i++) {
    const index = nodes[i] as number;
    const declaration = model.declarations[index] as Declaration;
    const source = sourceKey(model, declaration);
    sources.set(index, source);
    const group = options.groupOf(source, model.sourceOf(declaration), declaration.isType);
    if (group < 0) return false;
    groups.push(group);
  }
  const byGroup = stableOrder(n, (a: number, b: number): number => {
    const x = groups[a] as number;
    const y = groups[b] as number;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const items: number[] = [];
  const itemGroup: number[] = [];
  for (let i = 0; i < n; i++) {
    items.push(nodes[byGroup[i] | 0] as number);
    itemGroup.push(groups[byGroup[i] | 0] as number);
  }
  let start = 0;
  while (start < n) {
    let end = start;
    while (end < n && itemGroup[end] === itemGroup[start]) end = end + 1;
    const slice = items.slice(start, end);
    const places = stableOrder(slice.length, (ai: number, bi: number): number =>
      options.compare(sources.get(slice[ai] as number) as string, sources.get(slice[bi] as number) as string),
    );
    for (let i = 0; i < slice.length; i++) items[start + i] = slice[places[i] | 0] as number;
    start = end;
  }
  for (let i = 0; i < n; i++) sortSpecifiers(model, items[i] as number, options);
  const first = out.length;
  for (let g = 0; g < options.order.length; g++) {
    const group = options.order[g] as IanvsGroup;
    if (group.matcher === M_SEPARATOR) {
      if (out.length === first || out[out.length - 1] === mkNode(N_NEW_LINE, 0)) continue;
      out.push(mkNode(N_NEW_LINE, 0));
    } else {
      for (let i = 0; i < n; i++) if (itemGroup[i] === group.sameAs) out.push(mkNode(N_IMPORT, items[i] as number));
    }
  }
  return true;
}

const OWNER_DECLARATION = 0;
const OWNER_SPECIFIER = 1;

/** `CommentEntry` */
class Entry {
  ownerKind: number;
  ownerIndex: number;
  comment: number;
  association: number;
  needsTopOfFileOwner: boolean;
  needsLastSpecifierOwner: boolean;
  processingPriority: number;
  constructor(ownerKind: number, ownerIndex: number, comment: number, association: number, priority: number) {
    this.ownerKind = ownerKind;
    this.ownerIndex = ownerIndex;
    this.comment = comment;
    this.association = association;
    this.needsTopOfFileOwner = false;
    this.needsLastSpecifierOwner = false;
    this.processingPriority = priority;
  }
  copy(): Entry {
    const e = new Entry(this.ownerKind, this.ownerIndex, this.comment, this.association, this.processingPriority);
    e.needsTopOfFileOwner = this.needsTopOfFileOwner;
    e.needsLastSpecifierOwner = this.needsLastSpecifierOwner;
    return e;
  }
}

class Registry {
  entries: Entry[] = [];
  isRegistered: boolean[] = [];
  deferred: Entry[] = [];

  set(entry: Entry): void {
    this.isRegistered[entry.comment] = true;
    this.entries.push(entry);
  }

  /** `attachCommentsToRegistryMap` */
  attach(model: Model, which: number, comments: List, ownerKind: number, ownerIndex: number): void {
    let ownerLines: Lines | null;
    if (ownerKind === OWNER_DECLARATION) {
      const d = model.declarations[ownerIndex] as Declaration;
      ownerLines = d.hasLines ? d.lines : null;
    } else {
      ownerLines = model.lines(mkNode(N_SPECIFIER, ownerIndex));
    }
    const isSpecifier = ownerKind === OWNER_SPECIFIER;
    let counter = 0;
    for (let k = 0; k < comments.len; k++) {
      const id = model.listAt(comments, k);
      if (this.isRegistered[id] as boolean) continue;
      const comment = model.comments[id] as Comment;
      const entry = new Entry(ownerKind, ownerIndex, id, which, counter);
      counter = counter + 1;
      if (which === WHICH_INNER) {
        this.set(entry);
      } else if (which === WHICH_TRAILING) {
        if (ownerLines !== null && ownerLines.start === comment.startLine) {
          this.set(entry);
        } else if (isSpecifier) {
          const e = entry.copy();
          e.needsLastSpecifierOwner = true;
          e.processingPriority = entry.processingPriority + 30000;
          this.deferred.push(e);
        }
      } else if (ownerKind === OWNER_DECLARATION && ownerIndex === 0 && comment.endLine < (ownerLines === null ? 0 : ownerLines.start)) {
        const e = entry.copy();
        e.needsTopOfFileOwner = true;
        e.association = WHICH_TRAILING;
        e.processingPriority = entry.processingPriority + 20000;
        this.deferred.push(e);
      } else if (isSpecifier) {
        const e = entry.copy();
        e.processingPriority = entry.processingPriority + 10000;
        this.deferred.push(e);
      } else {
        this.set(entry);
      }
    }
  }
}

function sortEntries(entries: Entry[]): Entry[] {
  const places = stableOrder(entries.length, (a: number, b: number): number => {
    const x = (entries[a] as Entry).processingPriority;
    const y = (entries[b] as Entry).processingPriority;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const out: Entry[] = [];
  for (let i = 0; i < entries.length; i++) out.push(entries[places[i] | 0] as Entry);
  return out;
}

/** `getCommentRegistryFromImportDeclarations` */
function commentRegistry(model: Model, output: number[]): Entry[] {
  const registry = new Registry();
  for (let i = 0; i < model.comments.length; i++) registry.isRegistered.push(false);
  for (let w = 0; w < 3; w++) {
    const which = w === 0 ? WHICH_INNER : w === 1 ? WHICH_TRAILING : WHICH_LEADING;
    for (let o = 0; o < output.length; o++) {
      const index = output[o] as number;
      const declaration = model.declarations[index] as Declaration;
      registry.attach(model, which, declaration.comments.get(which), OWNER_DECLARATION, index);
      const specifiers = model.specifiersOf(declaration);
      for (let s = 0; s < specifiers.length; s++) {
        registry.attach(model, which, (model.specifiers[specifiers[s] as number] as Specifier).comments.get(which), OWNER_SPECIFIER, specifiers[s] as number);
      }
    }
  }
  const deferred = sortEntries(registry.deferred);
  // The first specifier on a line.
  const specifierOn = (line: number): number => {
    for (let o = 0; o < output.length; o++) {
      const specifiers = model.specifiersOf(model.declarations[output[o] as number] as Declaration);
      for (let s = 0; s < specifiers.length; s++) {
        const lines = model.lines(mkNode(N_SPECIFIER, specifiers[s] as number));
        if (lines !== null && lines.start === line) return specifiers[s] as number;
      }
    }
    return -1;
  };
  for (let d = 0; d < deferred.length; d++) {
    const entry = deferred[d] as Entry;
    if (registry.isRegistered[entry.comment] as boolean) continue;
    if (entry.ownerKind !== OWNER_SPECIFIER) {
      registry.set(entry);
      continue;
    }
    const found = specifierOn((model.comments[entry.comment] as Comment).startLine);
    const ownerIndex = found >= 0 ? found : entry.ownerIndex;
    const e = entry.copy();
    e.ownerKind = OWNER_SPECIFIER;
    e.ownerIndex = ownerIndex;
    e.association = entry.association === WHICH_LEADING && ownerIndex !== entry.ownerIndex ? WHICH_TRAILING : entry.association;
    registry.set(e);
  }
  return sortEntries(registry.entries);
}

/** `attachCommentsToOutputNodes` */
function attachCommentsToOutputNodes(model: Model, entries: Entry[], nodes: number[], providesGap: boolean): void {
  if (nodes.length === 0) return;
  const newFirstImport = nodes[0] as number;
  let hasPatched = false;
  const topOfFileComments: number[] = [];
  for (let e = 0; e < entries.length; e++) {
    const entry = entries[e] as Entry;
    if (entry.needsTopOfFileOwner) {
      // `ensureEmptyStatementAtFront`
      if (nodes[0] !== mkNode(N_EMPTY, 0)) nodes.unshift(mkNode(N_EMPTY, 0));
      if (!hasPatched) {
        patchNewFirstImportLocation(model, newFirstImport);
        hasPatched = true;
      }
      topOfFileComments.push(entry.comment);
    }
    let owner: number;
    if (entry.needsTopOfFileOwner) owner = mkNode(N_EMPTY, 0);
    else if (entry.ownerKind === OWNER_DECLARATION) owner = mkNode(N_IMPORT, entry.ownerIndex);
    else owner = mkNode(N_SPECIFIER, entry.ownerIndex);
    if (entry.needsLastSpecifierOwner && entry.ownerKind === OWNER_SPECIFIER) {
      const specifier = entry.ownerIndex;
      let parent: Declaration | null = null;
      for (let i = 0; i < nodes.length && parent === null; i++) {
        const node = nodes[i] as number;
        if (nodeKindOf(node) !== N_IMPORT) continue;
        const d = model.declarations[nodePayload(node)] as Declaration;
        if (model.specifiersOf(d).indexOf(specifier) >= 0) parent = d;
      }
      if (parent === null) continue;
      const list = model.specifiersOf(parent);
      if (list.length === 0) continue;
      owner = mkNode(N_SPECIFIER, list[list.length - 1] as number);
      const ownerLines = model.lines(owner);
      (model.comments[entry.comment] as Comment).startLine = (ownerLines === null ? 0 : ownerLines.end) + 1;
    }
    if (owner === newFirstImport && entry.association !== WHICH_LEADING && !entry.needsLastSpecifierOwner) {
      const lines = model.lines(owner);
      if (lines !== null) (model.comments[entry.comment] as Comment).startLine = lines.start;
    }
    const one = model.newList([entry.comment]);
    model.attach(owner, entry.association, one);
  }
  if (providesGap && hasPatched && !hasIgnoreNextNode(model, topOfFileComments) && nodeKindOf(newFirstImport) === N_IMPORT) {
    const d = model.declarations[nodePayload(newFirstImport)] as Declaration;
    if (d.hasLines) d.lines = new Lines(d.lines.start + 1, d.lines.end);
  }
}

/** `patchNewFirstImportLocationOnlyOnce` */
function patchNewFirstImportLocation(model: Model, newFirstImport: number): void {
  if (nodeKindOf(newFirstImport) !== N_IMPORT) return;
  const index = nodePayload(newFirstImport);
  const first = model.declarations[0] as Declaration;
  const target = model.declarations[index] as Declaration;
  if (!first.hasLines || !target.hasLines) return;
  const original = target.lines;
  // `getHeightOfLeadingComments`
  const comments = target.comments;
  let height = 0;
  if (comments.leading.len > 0) {
    const d = original.start - (model.comments[model.listAt(comments.leading, 0)] as Comment).startLine;
    height = d > 0 ? d : 0;
  }
  const patched = new Lines(first.lines.start + height, first.lines.end + height);
  target.lines = patched;
  const moved = original.start - patched.start;
  for (let w = 0; w < 3; w++) {
    const which = w === 0 ? WHICH_INNER : w === 1 ? WHICH_TRAILING : WHICH_LEADING;
    const list = comments.get(which);
    for (let at = 0; at < list.len; at++) {
      const c = model.comments[model.listAt(list, at)] as Comment;
      c.startLine = c.startLine - moved;
      c.endLine = c.endLine - moved;
    }
  }
}

/** `getSortedNodes`. null: an import belongs to no group. */
function sortedNodes(model: Model, options: IanvsOptions): number[] | null {
  // `getChunkTypeOfNode`
  const isUnsortable = (index: number): boolean => {
    const declaration = model.declarations[index] as Declaration;
    if (hasIgnoreNextNode(model, model.list(declaration.comments.leading))) return true;
    if (declaration.specifiersLen !== 0) return false;
    const source = sourceKey(model, declaration);
    for (let i = 0; i < options.safeSideEffects.length; i++) if ((options.safeSideEffects[i] as RegExp).test(source)) return false;
    return true;
  };
  const count = model.declarations.length;
  const nodes: number[] = [];
  let start = 0;
  while (start < count) {
    const kind = isUnsortable(start);
    let end = start;
    while (end < count && isUnsortable(end) === kind) end = end + 1;
    if (kind) {
      const hasSeparators = options.hasSeparators();
      if (hasSeparators && (model.declarations[start] as Declaration).comments.leading.isEmpty()) nodes.push(mkNode(N_NEW_LINE, 0));
      for (let i = start; i < end; i++) nodes.push(mkNode(N_IMPORT, i));
      if (hasSeparators) nodes.push(mkNode(N_NEW_LINE, 0));
    } else {
      let chunk: number[] = [];
      for (let i = start; i < end; i++) chunk.push(i);
      chunk = mergeNodesWithMatchingImportFlavors(model, chunk, options);
      if (options.hasTypes()) chunk = explodeTypeAndValueSpecifiers(model, chunk);
      if (!sortedByImportOrder(model, chunk, options, nodes)) return null;
    }
    start = end;
  }
  nodes.push(mkNode(N_NEW_LINE, 0));

  // `adjustCommentsOnSortedNodes`
  const output: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (nodeKindOf(nodes[i] as number) === N_IMPORT) output.push(nodePayload(nodes[i] as number));
  if (model.comments.length === 0 || output.length === 0) return nodes;
  const entries = commentRegistry(model, output);
  for (let o = 0; o < output.length; o++) {
    const d = model.declarations[output[o] as number] as Declaration;
    d.comments = new Attached();
    for (let at = d.specifiersStart; at < d.specifiersStart + d.specifiersLen; at++) {
      (model.specifiers[model.orders[at] as number] as Specifier).comments = new Attached();
    }
  }
  const providesGap = options.order.length > 0 && (options.order[0] as IanvsGroup).matcher === M_SEPARATOR;
  attachCommentsToOutputNodes(model, entries, nodes, providesGap);
  return nodes;
}

/** The text that the plugin hands to Prettier in place of the file of `model`. null: it is formatted the same. */
export function preprocess(model: Model, options: IanvsOptions, endOfLine: string): Uint8Array | null {
  const originalCount = model.declarations.length;
  const nodes = sortedNodes(model, options);
  if (nodes === null) return null;

  // `getCodeFromAst`
  const removed: Span[] = [];
  for (let i = 0; i < originalCount; i++) {
    const d = model.declarations[i] as Declaration;
    if (d.hasSpan) removed.push(new Span(d.start, d.end));
  }
  const removeComments = (attached: Attached): void => {
    for (let w = 0; w < 3; w++) {
      const list = attached.get(w === 0 ? WHICH_LEADING : w === 1 ? WHICH_INNER : WHICH_TRAILING);
      for (let k = 0; k < list.len; k++) {
        const c = model.comments[model.listAt(list, k)] as Comment;
        removed.push(new Span(c.start, c.end));
      }
    }
  };
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as number;
    const kind = nodeKindOf(node);
    if (kind === N_IMPORT) {
      const declaration = model.declarations[nodePayload(node)] as Declaration;
      removeComments(declaration.comments);
      const specifiers = model.specifiersOf(declaration);
      for (let s = 0; s < specifiers.length; s++) removeComments((model.specifiers[specifiers[s] as number] as Specifier).comments);
    } else if (kind === N_EMPTY) {
      removeComments(model.empty);
    }
  }
  for (let i = 0; i < model.directives.length; i++) removeComments((model.directives[i] as Directive).comments);
  if (model.interpreter !== null) removeComments(model.interpreter.comments);
  for (let i = 0; i < model.directives.length; i++) {
    const d = model.directives[i] as Directive;
    removed.push(new Span(d.start, d.end));
  }
  if (model.interpreter !== null) removed.push(new Span(model.interpreter.start, model.interpreter.end));
  const places = stableOrder(removed.length, (a: number, b: number): number => {
    const x = (removed[a] as Span).start;
    const y = (removed[b] as Span).start;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  const printer = new Printer(model, "with", endOfLine);
  printer.generate(PROLOGUE_INCLUDED, nodes);
  if (printer.hasFailed) return null;

  // `removeNodesFromOriginalCode`, and `trim`
  const text = model.text;
  const from = model.textStart();
  const code = printer.code();
  const out = new ByteBuf(model.restStart + code.length + 64);
  out.append(text, 0, from);
  const moved = out.len;
  const pieces: Piece[] = [];
  for (let i = 0; i < printer.pieces.length; i++) {
    const p = printer.pieces[i] as Piece;
    pieces.push(new Piece(p.kind, p.id, p.start + moved, p.end + moved));
  }
  out.append(code, 0, code.length);
  const headerEnd = out.len;
  let commentAt = 0;
  const keep = (at0: number, to: number): void => {
    let at = at0;
    if (out.len === headerEnd) {
      const trimmed = trimJsWhitespaceStart(text, at, to);
      at = trimmed;
    }
    while (commentAt < model.comments.length && (model.comments[commentAt] as Comment).start < to) {
      const comment = model.comments[commentAt] as Comment;
      if (comment.start >= at) {
        const start = out.len + comment.start - at;
        pieces.push(new Piece(PIECE_COMMENT, commentAt, start, start + (comment.end - comment.start)));
      }
      commentAt = commentAt + 1;
    }
    out.append(text, at, to);
  };
  let at = from;
  for (let i = 0; i < removed.length; i++) {
    const span = removed[places[i] | 0] as Span;
    if (span.start > at) keep(at, span.start);
    if (span.end > at) at = span.end;
  }
  const restStart = model.restStart > at ? model.restStart : at;
  keep(at, restStart);

  const newFrom = from + (nodes[0] === mkNode(N_EMPTY, 0) && model.interpreter === null && model.directives.length === 0 ? 1 : 0);
  if (!printer.hasChangedComment && isUnchanged(model, from, out.data.subarray(0, out.len), newFrom, pieces, out.len)) return null;
  out.append(text, restStart, text.length);
  const trimmedEnd = trimJsWhitespaceEnd(out.data, headerEnd, out.len);
  out.len = trimmedEnd;
  return bufBytes(out);
}
