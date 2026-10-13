// Port of vendor/bun/src/format/js/sort_imports/oxfmt/options.rs: the value of `sortImports`: oxfmt's `to_sort_imports`,
// `SortImportsOptions::validate` and `GroupMatcher::new`.
import { J_ARR, J_BOOL, J_NULL, J_OBJ, J_STR, JV, parseJson } from "../../../../driver/jsonv.ts";
import { Glob } from "../../../../driver/glob.ts";
import { stableOrder } from "../sort.ts";

/** What kind of import it is, or where it is from. In the order of their priority. */
export const SEL_TYPE: number = 0;
export const SEL_SIDE_EFFECT_STYLE: number = 1;
export const SEL_SIDE_EFFECT: number = 2;
export const SEL_STYLE: number = 3;
export const SEL_INDEX: number = 4;
export const SEL_SIBLING: number = 5;
export const SEL_PARENT: number = 6;
export const SEL_SUBPATH: number = 7;
export const SEL_INTERNAL: number = 8;
export const SEL_BUILTIN: number = 9;
export const SEL_EXTERNAL: number = 10;
export const SEL_IMPORT: number = 11;

function parseSelector(name: string): number {
  switch (name) {
    case "type":
      return SEL_TYPE;
    case "side_effect_style":
      return SEL_SIDE_EFFECT_STYLE;
    case "side_effect":
      return SEL_SIDE_EFFECT;
    case "style":
      return SEL_STYLE;
    case "index":
      return SEL_INDEX;
    case "sibling":
      return SEL_SIBLING;
    case "parent":
      return SEL_PARENT;
    case "subpath":
      return SEL_SUBPATH;
    case "internal":
      return SEL_INTERNAL;
    case "builtin":
      return SEL_BUILTIN;
    case "external":
      return SEL_EXTERNAL;
    case "import":
      return SEL_IMPORT;
    default:
      return -1;
  }
}

export function selectorBit(selector: number): number {
  return 1 << selector;
}

/** How an import is written. In the order of their priority. */
export const MOD_SIDE_EFFECT: number = 0;
export const MOD_TYPE: number = 1;
export const MOD_VALUE: number = 2;
export const MOD_DEFAULT: number = 3;
export const MOD_WILDCARD: number = 4;
export const MOD_NAMED: number = 5;

function parseModifier(name: string): number {
  switch (name) {
    case "side_effect":
      return MOD_SIDE_EFFECT;
    case "type":
      return MOD_TYPE;
    case "value":
      return MOD_VALUE;
    case "default":
      return MOD_DEFAULT;
    case "wildcard":
      return MOD_WILDCARD;
    case "named":
      return MOD_NAMED;
    default:
      return -1;
  }
}

export function modifierBit(modifier: number): number {
  return 1 << modifier;
}

function bits(modifiers: number[]): number {
  let b = 0;
  for (let i = 0; i < modifiers.length; i++) b = b | modifierBit(modifiers[i] as number);
  return b;
}

/** `type-external`: modifiers, sorted, and a selector. */
class GroupName {
  selector: number;
  modifiers: number[];
  constructor(selector: number, modifiers: number[]) {
    this.selector = selector;
    this.modifiers = modifiers;
  }
}

/** null: it is no name of a predefined group. */
function parseGroupName(name: string): GroupName | null {
  const parts = name.split("-");
  const selector = parseSelector(parts[parts.length - 1] as string);
  if (selector < 0) return null;
  const modifiers: number[] = [];
  for (let i = 0; i + 1 < parts.length; i++) {
    const m = parseModifier(parts[i] as string);
    if (m < 0) return null;
    modifiers.push(m);
  }
  modifiers.sort((a: number, b: number): number => a - b);
  const deduped: number[] = [];
  for (let i = 0; i < modifiers.length; i++) if (i === 0 || modifiers[i] !== modifiers[i - 1]) deduped.push(modifiers[i] as number);
  return new GroupName(selector, deduped);
}

/** An element of `customGroups` that `groups` has. */
class CustomGroup {
  elementNamePattern: Glob[];
  /** -1: none */
  selector: number;
  modifiers: number;
  /** Where it is in `groups`. */
  group: number;
  constructor(elementNamePattern: Glob[], selector: number, modifiers: number, group: number) {
    this.elementNamePattern = elementNamePattern;
    this.selector = selector;
    this.modifiers = modifiers;
    this.group = group;
  }
}

/** By priority: a selector, modifiers, and where it is in `groups`. */
class PredefinedGroup {
  selector: number;
  modifiers: number;
  group: number;
  constructor(selector: number, modifiers: number, group: number) {
    this.selector = selector;
    this.modifiers = modifiers;
    this.group = group;
  }
}

export class OxfmtOptions {
  partitionByNewline: boolean = false;
  partitionByComment: boolean = false;
  sortSideEffects: boolean = false;
  isDescending: boolean = false;
  ignoreCase: boolean = true;
  newlinesBetween: boolean = true;
  internalPattern: string[] = [];
  /** For each boundary between two groups, what a `{ "newlinesBetween": .. }` there says: 1, 0, or -1 for none. Empty if there is none. */
  newlineBoundaryOverrides: number[] = [];
  customGroups: CustomGroup[] = [];
  predefinedGroups: PredefinedGroup[] = [];
  unknownGroup: number = 0;
  /** A group takes all imports with side effects, so they are moved there even though they are not sorted. */
  regroupsSideEffect: boolean = false;
  regroupsSideEffectStyle: boolean = false;
  /** Treat side-effect imports as barriers. oxfmt only keeps them at their index and lets other imports move past them. */
  stopsAtSideEffects: boolean = false;

  /** `GroupMatcher::compute_group_index` */
  groupOf(source: string, selectors: number, modifiers: number): number {
    for (let i = 0; i < this.customGroups.length; i++) {
      const group = this.customGroups[i] as CustomGroup;
      let matchesName = group.elementNamePattern.length === 0;
      for (let k = 0; k < group.elementNamePattern.length && !matchesName; k++) {
        if ((group.elementNamePattern[k] as Glob).matches(source)) matchesName = true;
      }
      if (
        matchesName &&
        (group.selector < 0 || (selectors & selectorBit(group.selector)) !== 0) &&
        (group.modifiers & ~modifiers) === 0
      ) {
        return group.group;
      }
    }
    for (let i = 0; i < this.predefinedGroups.length; i++) {
      const group = this.predefinedGroups[i] as PredefinedGroup;
      if ((selectors & selectorBit(group.selector)) !== 0 && (group.modifiers & ~modifiers) === 0) return group.group;
    }
    return this.unknownGroup;
  }
}

/** What compile says about a value that it refuses: "" if there is nothing to say. */
export class CompileError {
  message: string = "";
}
export const compileError = new CompileError();

function invalid(what: string): string {
  return "Invalid `sortImports` configuration: " + what;
}

function fail(what: string): null {
  compileError.message = invalid(what);
  return null;
}

/** The array of strings in `value`, or null (after `compileError` is set). */
function stringsOf(value: JV, name: string): string[] | null {
  if (value.kind !== J_ARR) {
    fail("`" + name + "` must be an array of strings");
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < value.items.length; i++) {
    const item = value.items[i] as JV;
    if (item.kind !== J_STR) {
      fail("`" + name + "` must be an array of strings");
      return null;
    }
    out.push(item.s);
  }
  return out;
}

/** `config.get(name)` that is not null. */
function present(config: JV, name: string): JV | null {
  const v = config.get(name);
  if (v === null || v.kind === J_NULL) return null;
  return v;
}

/** -1 if it is not a boolean (and `compileError` is set), else 0 or 1. */
function boolean(config: JV, name: string, dflt: boolean): number {
  const v = config.get(name);
  if (v === null || v.kind === J_NULL) return dflt ? 1 : 0;
  if (v.kind === J_BOOL) return v.b ? 1 : 0;
  fail("`" + name + "` must be a boolean");
  return -1;
}

class Definition {
  name: string = "";
  elementNamePattern: string[] = [];
  selector: number = -1;
  modifiers: number[] = [];
}

function isMarker(item: JV): boolean {
  return item.kind === J_OBJ;
}

/**
 * `value`: as it is written in JSON. null: imports are left as they are, or, if `compileError.message` is not empty, the value is
 * not valid (that is the message).
 */
export function compile(value: string, stopsAtSideEffects: boolean): OxfmtOptions | null {
  compileError.message = "";
  const parsed = parseJson(value);
  let config: JV;
  if (parsed !== null && parsed.kind === J_BOOL && !parsed.b) return null;
  if (parsed !== null && parsed.kind === J_BOOL) config = JV.obj();
  else if (parsed !== null && parsed.kind === J_OBJ) config = parsed;
  else return fail("it must be a boolean or an object");

  // The names in `groups`, and the markers between them.
  const groups: string[][] = [];
  const overrides: number[] = [];
  const groupsValue = present(config, "groups");
  if (groupsValue === null) {
    groups.push(["builtin"]);
    groups.push(["external"]);
    groups.push(["internal", "subpath"]);
    groups.push(["parent", "sibling", "index"]);
    groups.push(["style"]);
    groups.push(["unknown"]);
  } else {
    if (groupsValue.kind !== J_ARR) return fail("`groups` must be an array");
    const items = groupsValue.items;
    if (items.length > 0 && isMarker(items[0] as JV)) {
      return fail('`{ "newlinesBetween" }` marker cannot appear at the start of `groups`');
    }
    if (items.length > 0 && isMarker(items[items.length - 1] as JV)) {
      return fail('`{ "newlinesBetween" }` marker cannot appear at the end of `groups`');
    }
    for (let i = 0; i + 1 < items.length; i++) {
      if (isMarker(items[i] as JV) && isMarker(items[i + 1] as JV)) {
        return fail('consecutive `{ "newlinesBetween" }` markers are not allowed in `groups`');
      }
    }
    let pending = -1;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as JV;
      let names: string[];
      if (item.kind === J_OBJ) {
        const marker = item.get("newlinesBetween");
        if (marker === null || marker.kind !== J_BOOL) {
          return fail('a marker in `groups` must be `{ "newlinesBetween": boolean }`');
        }
        pending = marker.b ? 1 : 0;
        continue;
      } else if (item.kind === J_STR) {
        names = [item.s];
      } else {
        const strs = stringsOf(item, "groups");
        if (strs === null) return null;
        names = strs;
      }
      if (groups.length > 0) {
        overrides.push(pending);
        pending = -1;
      }
      groups.push(names);
    }
  }

  const definitions: Definition[] = [];
  const customValue = present(config, "customGroups");
  if (customValue !== null) {
    if (customValue.kind !== J_ARR) return fail("`customGroups` must be an array");
    for (let i = 0; i < customValue.items.length; i++) {
      const item = customValue.items[i] as JV;
      const definition = new Definition();
      const name = present(item, "groupName");
      if (name !== null && name.kind === J_STR) definition.name = name.s;
      const pattern = present(item, "elementNamePattern");
      if (pattern !== null) {
        const strs = stringsOf(pattern, "elementNamePattern");
        if (strs === null) return null;
        definition.elementNamePattern = strs;
      }
      const selector = present(item, "selector");
      if (selector !== null) {
        const s = selector.kind === J_STR ? parseSelector(selector.s) : -1;
        if (s < 0) return fail("unknown `selector` in `customGroups`");
        definition.selector = s;
      }
      const modifiers = present(item, "modifiers");
      if (modifiers !== null) {
        const strs = stringsOf(modifiers, "modifiers");
        if (strs === null) return null;
        for (let k = 0; k < strs.length; k++) {
          const m = parseModifier(strs[k] as string);
          if (m < 0) return fail("unknown modifier in `customGroups`");
          definition.modifiers.push(m);
        }
      }
      definitions.push(definition);
    }
  }

  const partitionByNewline = boolean(config, "partitionByNewline", false);
  if (partitionByNewline < 0) return null;
  const newlinesBetween = boolean(config, "newlinesBetween", true);
  if (newlinesBetween < 0) return null;
  const sortSideEffects = boolean(config, "sortSideEffects", false);
  if (sortSideEffects < 0) return null;

  // `SortImportsOptions::validate`
  let hasOverride = false;
  for (let i = 0; i < overrides.length; i++) if ((overrides[i] as number) >= 0) hasOverride = true;
  if (partitionByNewline === 1 && hasOverride) {
    return fail('`partitionByNewline` and per-group `{ "newlinesBetween" }` markers cannot be used together');
  }
  if (partitionByNewline === 1 && newlinesBetween === 1) {
    return fail("`partitionByNewline: true` and `newlinesBetween: true` cannot be used together");
  }
  for (let g = 0; g < groups.length; g++) {
    const names = groups[g] as string[];
    for (let k = 0; k < names.length; k++) {
      const name = names[k] as string;
      if (name === "unknown" || parseGroupName(name) !== null) continue;
      let defined = false;
      for (let d = 0; d < definitions.length; d++) if ((definitions[d] as Definition).name === name) defined = true;
      if (!defined) return fail("unknown group name `" + name + "` in `groups`");
    }
  }
  for (let d = 0; d < definitions.length; d++) {
    const name = (definitions[d] as Definition).name;
    if (name === "unknown" || parseGroupName(name) !== null) {
      return fail(
        "`customGroups` name `" +
          name +
          "` conflicts with a predefined group name; predefined names and `unknown` cannot be used as `groupName`",
      );
    }
  }

  // `GroupMatcher::new`
  let unknownGroup = groups.length;
  const predefined: PredefinedGroupName[] = [];
  for (let index = 0; index < groups.length; index++) {
    const names = groups[index] as string[];
    for (let k = 0; k < names.length; k++) {
      const name = names[k] as string;
      if (name === "unknown") {
        unknownGroup = index;
        continue;
      }
      const group = parseGroupName(name);
      if (group !== null) predefined.push(new PredefinedGroupName(group, index));
    }
  }
  const order: number[] = [];
  for (let i = 0; i < predefined.length; i++) order.push(i);
  // A stable sort: by selector, then the group with more modifiers first, then by modifiers.
  const placed = stableOrder(order.length, (a: number, b: number): number => comparePredefined(predefined[a] as PredefinedGroupName, predefined[b] as PredefinedGroupName));
  const sortedPredefined: PredefinedGroupName[] = [];
  for (let i = 0; i < placed.length; i++) sortedPredefined.push(predefined[placed[i] | 0] as PredefinedGroupName);

  const customGroups: CustomGroup[] = [];
  for (let d = 0; d < definitions.length; d++) {
    const definition = definitions[d] as Definition;
    let at = -1;
    for (let g = groups.length - 1; g >= 0 && at < 0; g--) {
      if ((groups[g] as string[]).indexOf(definition.name) >= 0) at = g;
    }
    if (at < 0) continue;
    const globs: Glob[] = [];
    for (let k = 0; k < definition.elementNamePattern.length; k++) globs.push(new Glob(definition.elementNamePattern[k] as string));
    customGroups.push(new CustomGroup(globs, definition.selector, bits(definition.modifiers), at));
  }
  const hasCatchAllGroupFor = (selector: number): boolean => {
    for (let i = 0; i < sortedPredefined.length; i++) {
      const group = (sortedPredefined[i] as PredefinedGroupName).name;
      if (group.selector === selector && group.modifiers.length === 0) return true;
    }
    for (let i = 0; i < customGroups.length; i++) {
      const group = customGroups[i] as CustomGroup;
      if (group.selector === selector && group.elementNamePattern.length === 0 && group.modifiers === 0) return true;
    }
    return false;
  };

  const partitionByComment = boolean(config, "partitionByComment", false);
  if (partitionByComment < 0) return null;
  const options = new OxfmtOptions();
  options.partitionByNewline = partitionByNewline === 1;
  options.partitionByComment = partitionByComment === 1;
  options.sortSideEffects = sortSideEffects === 1;
  const orderValue = present(config, "order");
  if (orderValue === null || (orderValue.kind === J_STR && orderValue.s === "asc")) options.isDescending = false;
  else if (orderValue.kind === J_STR && orderValue.s === "desc") options.isDescending = true;
  else return fail('`order` must be "asc" or "desc"');
  const ignoreCase = boolean(config, "ignoreCase", true);
  if (ignoreCase < 0) return null;
  options.ignoreCase = ignoreCase === 1;
  options.newlinesBetween = newlinesBetween === 1;
  const internalValue = present(config, "internalPattern");
  if (internalValue === null) {
    options.internalPattern = ["~/", "@/", "#"];
  } else {
    const strs = stringsOf(internalValue, "internalPattern");
    if (strs === null) return null;
    options.internalPattern = strs;
  }
  options.regroupsSideEffect = hasCatchAllGroupFor(SEL_SIDE_EFFECT);
  options.regroupsSideEffectStyle = hasCatchAllGroupFor(SEL_SIDE_EFFECT_STYLE);
  options.stopsAtSideEffects =
    stopsAtSideEffects && sortSideEffects !== 1 && !hasCatchAllGroupFor(SEL_SIDE_EFFECT) && !hasCatchAllGroupFor(SEL_SIDE_EFFECT_STYLE);
  options.newlineBoundaryOverrides = overrides;
  for (let i = 0; i < sortedPredefined.length; i++) {
    const p = sortedPredefined[i] as PredefinedGroupName;
    options.predefinedGroups.push(new PredefinedGroup(p.name.selector, bits(p.name.modifiers), p.index));
  }
  options.customGroups = customGroups;
  options.unknownGroup = unknownGroup;
  return options;
}

class PredefinedGroupName {
  name: GroupName;
  index: number;
  constructor(name: GroupName, index: number) {
    this.name = name;
    this.index = index;
  }
}

function comparePredefined(a: PredefinedGroupName, b: PredefinedGroupName): number {
  if (a.name.selector !== b.name.selector) return a.name.selector < b.name.selector ? -1 : 1;
  const la = a.name.modifiers.length;
  const lb = b.name.modifiers.length;
  if (la !== lb) return la > lb ? -1 : 1;
  for (let i = 0; i < la; i++) {
    const x = a.name.modifiers[i] as number;
    const y = b.name.modifiers[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

