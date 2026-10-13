// The sorting of oxfmt's `sortImports` (the part of vendor/bun/src/format/js/sort_imports/oxfmt/run.rs that does not write): the lines of a run,
// the imports, their groups, and the plan of what is written. A leaf: it knows nothing of the formatter, so that it can be used from the modules
// of `format/js` that are in an import cycle (SC1016).
import { I32Vec } from "../../../../base/i32vec.ts";
import {
  importDefault,
  importIsSideEffect,
  importIsTypeOnly,
  importNamedLen,
  importNamespace,
} from "../../../../lint/ast/index.ts";
import { isBuiltinModule } from "../../../../lint/utils/node.ts";
import { OxfmtOptions, MOD_DEFAULT, MOD_NAMED, MOD_SIDE_EFFECT, MOD_TYPE, MOD_VALUE, MOD_WILDCARD, SEL_BUILTIN, SEL_EXTERNAL, SEL_IMPORT, SEL_INDEX, SEL_INTERNAL, SEL_PARENT, SEL_SIBLING, SEL_SIDE_EFFECT, SEL_SIDE_EFFECT_STYLE, SEL_STYLE, SEL_SUBPATH, SEL_TYPE, modifierBit, selectorBit } from "./options.ts";
import { natord } from "../compare.ts";
import { stableOrder } from "../sort.ts";

export const LINE_IMPORT: number = 0;
export const LINE_EMPTY: number = 1;
export const LINE_COMMENT: number = 2;

/** oxc's `SourceLine`. The ranges are of the formatter's pool. */
export class Line {
  kind: number;
  start: number;
  end: number;
  /** Which import of the run. */
  index: number;
  constructor(kind: number, start: number, end: number, index: number) {
    this.kind = kind;
    this.start = start;
    this.end = end;
    this.index = index;
  }
}

/** An import, and what oxc makes of what is written for it: it goes by the text in the document, where a comment is text like any other. */
export class Written {
  statement: number;
  import: number;
  /** The first text after the `from`, or after the `import` if there is none: without its quotes it is the path. */
  source: string;
  /** There is text before the `*`. */
  hasCommentForDefault: boolean;
  constructor(statement: number, imp: number, source: string, hasCommentForDefault: boolean) {
    this.statement = statement;
    this.import = imp;
    this.source = source;
    this.hasCommentForDefault = hasCommentForDefault;
  }
}

/** oxc's `SortableImport` */
export class Unit {
  /** The comments directly before it, without an empty line between: a range of the lines. */
  leadingFrom: number;
  leadingTo: number;
  line: Line;
  group: number;
  source: string;
  isSideEffect: boolean;
  /** It stays where it is. */
  isIgnored: boolean;
  constructor(leadingFrom: number, leadingTo: number, line: Line, group: number, source: string, isSideEffect: boolean, isIgnored: boolean) {
    this.leadingFrom = leadingFrom;
    this.leadingTo = leadingTo;
    this.line = line;
    this.group = group;
    this.source = source;
    this.isSideEffect = isSideEffect;
    this.isIgnored = isIgnored;
  }
}

/** Comments that an empty line separates from the next import. They stay where they are. */
export class Orphan {
  lines: Line[];
  /** After which import. -1: before the first. */
  afterSlot: number;
  constructor(lines: Line[], afterSlot: number) {
    this.lines = lines;
    this.afterSlot = afterSlot;
  }
}

// What `transform` writes: (OP_RANGE, start, end) of the pool, (OP_HARD, 0, 0) or (OP_EMPTY, 0, 0).
export const OP_RANGE: number = 0;
export const OP_HARD: number = 1;
export const OP_EMPTY: number = 2;

export class Plan {
  ops: I32Vec = new I32Vec(64);
  push(kind: number, a: number, b: number): void {
    this.ops.push(kind);
    this.ops.push(a);
    this.ops.push(b);
  }
}

/** `Line::write` */
function writeLine(line: Line, preservesEmptyLine: boolean, out: Plan): void {
  if (line.kind === LINE_EMPTY) {
    if (preservesEmptyLine) out.push(OP_EMPTY, 0, 0);
    return;
  }
  out.push(OP_RANGE, line.start, line.end);
  out.push(OP_HARD, 0, 0);
}

/** `extract_source_path`: `"./a.js?b"` is `./a.js`. */
function sourcePath(written: string): string {
  let start = 0;
  let end = written.length;
  for (let q = 0; q < 2; q++) {
    const quote = q === 0 ? 0x22 : 0x27;
    while (start < end && written.charCodeAt(start) === quote) start = start + 1;
    while (end > start && written.charCodeAt(end - 1) === quote) end = end - 1;
  }
  const source = written.substring(start, end);
  const mark = source.indexOf("?");
  return mark >= 0 ? source.substring(0, mark) : source;
}

/** `Path::new(source).extension()` is that of a style sheet. */
function isStyle(source: string): boolean {
  let trimmed = source.length;
  while (trimmed > 0 && source.charCodeAt(trimmed - 1) === 0x2f) trimmed = trimmed - 1;
  const path = source.substring(0, trimmed);
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.substring(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && name !== "..") {
    const ext = name.substring(dot + 1);
    return ext === "css" || ext === "scss" || ext === "sass" || ext === "less" || ext === "styl" || ext === "pcss" || ext === "sss";
  }
  return false;
}

function isBuiltin(source: string): boolean {
  const bytes = new TextEncoder().encode(source);
  return isBuiltinModule(bytes, 0, bytes.length);
}

/** `to_path_kind` */
function pathKind(source: string, options: OxfmtOptions): number {
  if (source.startsWith("node:") || source.startsWith("bun:") || isBuiltin(source)) return SEL_BUILTIN;
  if (
    source === "." ||
    source === "./" ||
    source === "./index" ||
    source === "./index.js" ||
    source === "./index.ts" ||
    source === "./index.d.ts" ||
    source === "./index.d.js"
  ) {
    return SEL_INDEX;
  }
  if (source.startsWith("..")) return SEL_PARENT;
  if (source.startsWith(".")) return SEL_SIBLING;
  for (let i = 0; i < options.internalPattern.length; i++) {
    if (source.startsWith(options.internalPattern[i] as string)) return SEL_INTERNAL;
  }
  return SEL_EXTERNAL;
}

class Classified {
  group: number = 0;
  isIgnored: boolean = false;
}
const classified = new Classified();

/** `compute_import_metadata`: the group, and whether the import stays where it is (in `classified`). */
function classify(written: Written, source: string, options: OxfmtOptions): void {
  const imp = written.import;
  const isSideEffect = importIsSideEffect(imp);
  const style = isStyle(source);
  const typeOnly = importIsTypeOnly(imp);
  let selectors = selectorBit(SEL_IMPORT);
  if (isSideEffect && style) selectors = selectors | selectorBit(SEL_SIDE_EFFECT_STYLE);
  if (isSideEffect) selectors = selectors | selectorBit(SEL_SIDE_EFFECT);
  if (style) selectors = selectors | selectorBit(SEL_STYLE);
  if (typeOnly) selectors = selectors | selectorBit(SEL_TYPE);
  if (source.startsWith("#")) selectors = selectors | selectorBit(SEL_SUBPATH);
  selectors = selectors | selectorBit(pathKind(source, options));

  let modifiers = typeOnly ? modifierBit(MOD_TYPE) : modifierBit(MOD_VALUE);
  if (isSideEffect) modifiers = modifiers | modifierBit(MOD_SIDE_EFFECT);
  if (importDefault(imp) >= 0 || written.hasCommentForDefault) modifiers = modifiers | modifierBit(MOD_DEFAULT);
  if (importNamespace(imp) >= 0) modifiers = modifiers | modifierBit(MOD_WILDCARD);
  if (importNamedLen(imp) > 0) modifiers = modifiers | modifierBit(MOD_NAMED);

  classified.isIgnored = !options.sortSideEffects && isSideEffect && !options.regroupsSideEffect && !(style && options.regroupsSideEffectStyle);
  classified.group = options.groupOf(source, selectors, modifiers);
}

/** `sort_within_group`: sorts `indices[from..to)`. */
function sortWithinGroup(indices: number[], from: number, to: number, units: Unit[], options: OxfmtOptions): void {
  const compareSources = (a: number, b: number): number => {
    const order = natord((units[a] as Unit).source, (units[b] as Unit).source, options.ignoreCase);
    return options.isDescending ? -order : order;
  };
  const bySource = (items: number[]): void => {
    const places = stableOrder(items.length, (a: number, b: number): number => compareSources(items[a] as number, items[b] as number));
    const given = items.slice();
    for (let i = 0; i < items.length; i++) items[i] = given[places[i] | 0] as number;
  };
  if (options.sortSideEffects) {
    const items: number[] = indices.slice(from, to);
    bySource(items);
    for (let i = 0; i < items.length; i++) indices[from + i] = items[i] as number;
    return;
  }
  // Those with side effects keep their places among the others.
  const others: number[] = [];
  for (let i = from; i < to; i++) if (!(units[indices[i] as number] as Unit).isSideEffect) others.push(indices[i] as number);
  bySource(others);
  let next = 0;
  for (let i = from; i < to; i++) {
    if (!(units[indices[i] as number] as Unit).isSideEffect) {
      indices[i] = others[next] as number;
      next = next + 1;
    }
  }
}

/** `SortSortableImports::sort`: the order of `units`. */
function sortedOrder(units: Unit[], options: OxfmtOptions): number[] {
  const sortable: number[] = [];
  for (let i = 0; i < units.length; i++) if (!(units[i] as Unit).isIgnored) sortable.push(i);
  const places = stableOrder(sortable.length, (a: number, b: number): number => {
    const x = (units[sortable[a] as number] as Unit).group;
    const y = (units[sortable[b] as number] as Unit).group;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const given = sortable.slice();
  for (let i = 0; i < sortable.length; i++) sortable[i] = given[places[i] | 0] as number;
  let start = 0;
  while (start < sortable.length) {
    const group = (units[sortable[start] as number] as Unit).group;
    let end = start;
    while (end < sortable.length && (units[sortable[end] as number] as Unit).group === group) end = end + 1;
    sortWithinGroup(sortable, start, end, units, options);
    start = end;
  }
  const order: number[] = [];
  let next = 0;
  for (let index = 0; index < units.length; index++) {
    if ((units[index] as Unit).isIgnored) {
      order.push(index);
    } else {
      order.push(next < sortable.length ? (sortable[next] as number) : index);
      next = next + 1;
    }
  }
  return order;
}

/** `should_insert_newline_between` */
function shouldInsertNewlineBetween(options: OxfmtOptions, previous: number, current: number, slotHadLeadingBlank: boolean): boolean {
  if (previous > current) return slotHadLeadingBlank;
  const overrides = options.newlineBoundaryOverrides;
  if (overrides.length === 0) return options.newlinesBetween;
  for (let at = previous; at < current; at++) {
    const o = at < overrides.length ? (overrides[at] as number) : -1;
    if (o < 0 ? options.newlinesBetween : o === 1) return true;
  }
  return false;
}

/** Writes the lines of a chunk, in which nothing is a boundary, with its imports sorted. */
function writeSorted(lines: Line[], from: number, to: number, imports: Written[], options: OxfmtOptions, isBeforeBoundary: boolean, out: Plan): void {
  // `into_sorted_import_units`
  const units: Unit[] = [];
  const orphans: Orphan[] = [];
  const slotHadLeadingBlank: boolean[] = [];
  // The lines since the last import up to the last empty line, and where those after it start.
  let orphanPending: Line[] = [];
  let currentPending = from;
  for (let at = from; at < to; at++) {
    const line = lines[at] as Line;
    if (line.kind === LINE_IMPORT) {
      let hasBlank = false;
      for (let k = 0; k < orphanPending.length; k++) if ((orphanPending[k] as Line).kind === LINE_EMPTY) hasBlank = true;
      slotHadLeadingBlank.push(hasBlank);
      const afterSlot = units.length - 1;
      let orphan = orphanPending;
      orphanPending = [];
      if (afterSlot >= 0) {
        const kept: Line[] = [];
        for (let k = 0; k < orphan.length; k++) if ((orphan[k] as Line).kind === LINE_COMMENT) kept.push(orphan[k] as Line);
        orphan = kept;
      }
      if (orphan.length > 0) orphans.push(new Orphan(orphan, afterSlot));
      if (line.index >= imports.length) continue;
      const written = imports[line.index] as Written;
      const source = sourcePath(written.source);
      classify(written, source, options);
      units.push(new Unit(currentPending, at, line, classified.group, source, importIsSideEffect(written.import), classified.isIgnored));
      currentPending = at + 1;
    } else if (line.kind === LINE_EMPTY) {
      for (let k = currentPending; k <= at; k++) orphanPending.push(lines[k] as Line);
      currentPending = at + 1;
    }
  }
  for (let k = currentPending; k < to; k++) orphanPending.push(lines[k] as Line);
  const trailing = orphanPending;
  const order = sortedOrder(units, options);

  for (let o = 0; o < orphans.length; o++) {
    const orphan = orphans[o] as Orphan;
    if (orphan.afterSlot >= 0) continue;
    for (let k = 0; k < orphan.lines.length; k++) writeLine(orphan.lines[k] as Line, true, out);
  }
  let previousGroup = -1;
  let hasSeenNotIgnored = false;
  let slot = 0;
  for (let i = 0; i < order.length; i++) {
    const unitIndex = order[i] as number;
    if (unitIndex >= units.length) continue;
    const unit = units[unitIndex] as Unit;
    if (
      previousGroup >= 0 &&
      previousGroup !== unit.group &&
      hasSeenNotIgnored &&
      shouldInsertNewlineBetween(options, previousGroup, unit.group, slot < slotHadLeadingBlank.length ? (slotHadLeadingBlank[slot] as boolean) : false)
    ) {
      out.push(OP_EMPTY, 0, 0);
    }
    previousGroup = unit.group;
    if (!unit.isIgnored) hasSeenNotIgnored = true;
    for (let k = unit.leadingFrom; k < unit.leadingTo; k++) writeLine(lines[k] as Line, options.partitionByNewline, out);
    writeLine(unit.line, false, out);
    for (let o = 0; o < orphans.length; o++) {
      const orphan = orphans[o] as Orphan;
      if (orphan.afterSlot !== slot) continue;
      for (let k = 0; k < orphan.lines.length; k++) writeLine(orphan.lines[k] as Line, false, out);
    }
    slot = slot + 1;
  }
  for (let at = 0; at < trailing.length; at++) {
    const line = trailing[at] as Line;
    const isLastEmptyLine = at + 1 === trailing.length && line.kind === LINE_EMPTY;
    writeLine(line, !isLastEmptyLine || isBeforeBoundary, out);
  }
}

function isBoundary(line: Line, imports: Written[], options: OxfmtOptions): boolean {
  if (line.kind === LINE_IMPORT) {
    return options.stopsAtSideEffects && line.index < imports.length && importIsSideEffect((imports[line.index] as Written).import);
  }
  if (line.kind === LINE_EMPTY) return options.partitionByNewline;
  return options.partitionByComment;
}

/** oxc's `transform` */
export function transform(lines: Line[], imports: Written[], options: OxfmtOptions, out: Plan): void {
  let start = 0;
  while (start < lines.length) {
    if (isBoundary(lines[start] as Line, imports, options)) {
      writeLine(lines[start] as Line, true, out);
      start = start + 1;
      continue;
    }
    let end = start;
    while (end < lines.length && !isBoundary(lines[end] as Line, imports, options)) end = end + 1;
    writeSorted(lines, start, end, imports, options, end < lines.length, out);
    start = end;
  }
  // Every line is written with a line break after it. What comes after the run writes its own.
  if (out.ops.len >= 3) out.ops.len = out.ops.len - 3;
}

/** The state of the run that is being written (`ImportRun`). */
export class RunState {
  options: OxfmtOptions | null = null;
  /** Where the capture of the run that is being written starts. -1: none. */
  slot: number = -1;
  /** Whether the next statement can be part of a run, if that is known: -1 not known, 0, 1. */
  isNextSortable: number = -1;
  lines: Line[] = [];
  imports: Written[] = [];
  /** Where the line that is being written starts. */
  lineStart: number = 0;
}
export const state = new RunState();
export const plan = new Plan();

