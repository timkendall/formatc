// Port of vendor/bun/src/format/js/sort_imports/settings.rs: the options, as they are in a configuration file.
import { J_ARR, J_STR, JV, parseJson } from "../../../driver/jsonv.ts";
import {
  HOW_IANVS,
  HOW_NATIVE,
  HOW_ORGANIZE,
  HOW_OXFMT,
  HOW_TRIVAGO,
  SortImports,
} from "./how.ts";
import {
  BUILTIN_MODULES as IANVS_BUILTIN_MODULES,
  IanvsGroup,
  IanvsOptions,
  M_BUILTIN,
  M_REGEX,
  M_SEPARATOR,
  M_THIRD_PARTY,
  M_TYPES,
  THIRD_PARTY_MODULES as IANVS_THIRD_PARTY_MODULES,
  TYPES as IANVS_TYPES,
} from "./ianvs.ts";
import {
  OrganizeOptions,
  TYPE_ORDER_FIRST,
  TYPE_ORDER_INLINE,
  TYPE_ORDER_LAST,
} from "./organize.ts";
import { compile as compileOxfmt, compileError as oxfmtError } from "./oxfmt/options.ts";
import {
  BY_LENGTH_ASCENDING,
  BY_LENGTH_DESCENDING,
  BY_LENGTH_NONE,
  THIRD_PARTY_MODULES as TRIVAGO_THIRD_PARTY_MODULES,
  TYPES as TRIVAGO_TYPES,
  TrivagoExclude,
  TrivagoGroup,
  TrivagoOptions,
} from "./trivago.ts";

const OF_TRIVAGO: string[] = [
  "importOrderSeparation",
  "importOrderSortSpecifiers",
  "importOrderGroupNamespaceSpecifiers",
  "importOrderCaseInsensitive",
  "importOrderSideEffects",
  "importOrderSortByLength",
  "importOrderImportAttributesKeyword",
  "importOrderExclude",
];

const OF_IANVS: string[] = ["importOrderTypeScriptVersion", "importOrderCaseSensitive", "importOrderSafeSideEffects"];

/** How the names of `@trivago/prettier-plugin-sort-imports`, of `@ianvs/prettier-plugin-sort-imports` and of their forks end. */
const SORT_IMPORTS = "/prettier-plugin-sort-imports";
const ORGANIZE_IMPORTS = "prettier-plugin-organize-imports";
const OF_BUN = "bun.sortImports";

function invalid(name: string, value: string): string {
  return "Invalid " + name + " value: " + value + ".";
}

/**
 * The options that are about imports, by name, with their values as they are written in JSON, a string without its quotes.
 *
 * | whose | options |
 * | --- | --- |
 * | both plugins | `plugins`, `importOrder`, `importOrderParserPlugins` |
 * | `@trivago/prettier-plugin-sort-imports` | `importOrderSeparation`, `importOrderSortSpecifiers`, `importOrderGroupNamespaceSpecifiers`, `importOrderCaseInsensitive`, `importOrderSideEffects`, `importOrderSortByLength`, `importOrderImportAttributesKeyword`, `importOrderExclude` |
 * | `@ianvs/prettier-plugin-sort-imports` | `importOrderTypeScriptVersion`, `importOrderCaseSensitive`, `importOrderSafeSideEffects` |
 * | `prettier-plugin-organize-imports` | `organizeImportsSkipDestructiveCodeActions`, `organizeImportsTypeOrder` |
 * | the `compilerOptions` of the `tsconfig.json` of the file, which that plugin reads | `tsconfig.jsx`, `tsconfig.jsxFactory`, `tsconfig.jsxFragmentFactory`, `tsconfig.reactNamespace` |
 * | oxfmt | `sortImports`, which used to be `experimentalSortImports` |
 * | Bun | `bun.sortImports`, set by `sortImports` under `[fmt]` in bunfig.toml or by `--sort-imports` |
 */
export class Settings {
  names: string[] = [];
  values: string[] = [];
  /** What `compile` says is wrong, if it returns null for that reason. */
  error: string = "";

  /** Takes the option `name` if it is about imports. A later value replaces an earlier one. */
  set(name: string, value: string): boolean {
    const isKnown =
      name === "plugins" ||
      name === "importOrder" ||
      name === "importOrderParserPlugins" ||
      name === "sortImports" ||
      name === "experimentalSortImports" ||
      name === OF_BUN ||
      name.startsWith("organizeImports") ||
      name === "tsconfig.jsx" ||
      name === "tsconfig.jsxFactory" ||
      name === "tsconfig.jsxFragmentFactory" ||
      name === "tsconfig.reactNamespace" ||
      OF_TRIVAGO.indexOf(name) >= 0 ||
      OF_IANVS.indexOf(name) >= 0;
    if (isKnown) {
      const at = this.names.indexOf(name);
      if (at >= 0) {
        this.names.splice(at, 1);
        this.values.splice(at, 1);
      }
      this.names.push(name);
      this.values.push(value);
    }
    return isKnown;
  }

  /** Also counts `name` as one of the `plugins`: `--plugin`. */
  addPlugin(name: string): void {
    const plugins = this.get("plugins");
    this.set("plugins", (plugins === null ? "" : plugins) + " " + name);
  }

  /** Whether one of the `plugins` is `name`, or ends with it. */
  namesPlugin(name: string): boolean {
    const plugins = this.get("plugins");
    return plugins !== null && plugins.indexOf(name) >= 0;
  }

  /** Whether `prettier-plugin-organize-imports` is named, which asks the `tsconfig.json`. */
  organizesImports(): boolean {
    return this.namesPlugin(ORGANIZE_IMPORTS);
  }

  /** The options, with their values, of a plugin that is not named: Prettier does not know them. Appended to `outNames` and `outValues`. */
  ofPluginsNotNamed(outNames: string[], outValues: string[]): void {
    for (let i = 0; i < this.names.length; i++) {
      const name = this.names[i] as string;
      let known = true;
      if (name.startsWith("importOrder")) known = this.namesPlugin(SORT_IMPORTS);
      else if (name.startsWith("organizeImports")) known = this.namesPlugin(ORGANIZE_IMPORTS);
      if (!known) {
        outNames.push(name);
        outValues.push(this.values[i] as string);
      }
    }
  }

  get(name: string): string | null {
    for (let i = 0; i < this.names.length; i++) if (this.names[i] === name) return this.values[i] as string;
    return null;
  }

  /** 0 or 1, or -1 (and `error` is set). */
  boolean(name: string, dflt: boolean): number {
    const v = this.get(name);
    if (v === null) return dflt ? 1 : 0;
    if (v === "true") return 1;
    if (v === "false") return 0;
    this.error = invalid(name, v);
    return -1;
  }

  /** An array of strings. One string is an array of one. null: there is none, or (if `error` is set) it is no array of strings. */
  strings(name: string): string[] | null {
    const value = this.get(name);
    if (value === null) return null;
    let at = 0;
    while (at < value.length && (value.charCodeAt(at) === 32 || (value.charCodeAt(at) >= 9 && value.charCodeAt(at) <= 13))) at = at + 1;
    if (value.charCodeAt(at) !== 91) return [value];
    const parsed = parseJson(value);
    if (parsed === null || parsed.kind !== J_ARR) {
      this.error = invalid(name, value);
      return null;
    }
    const out: string[] = [];
    for (let i = 0; i < parsed.items.length; i++) {
      const item = parsed.items[i] as JV;
      if (item.kind !== J_STR) {
        this.error = invalid(name, value);
        return null;
      }
      out.push(item.s);
    }
    return out;
  }

  /**
   * Whether the behaviour is that of `@ianvs/prettier-plugin-sort-imports`, where it differs from `@trivago/prettier-plugin-sort-imports`,
   * which it is a fork of. What says so, in this order: the plugin that is named, an option or a special word that only one of them has.
   * Otherwise the more popular one it is.
   */
  isIanvs(order: string[] | null): boolean {
    const plugins = this.get("plugins");
    const p = plugins === null ? "" : plugins;
    const namesIanvs = p.indexOf("@ianvs/prettier-plugin-sort-imports") >= 0;
    const namesTrivago = p.indexOf("@trivago/prettier-plugin-sort-imports") >= 0;
    if (namesIanvs || namesTrivago) return namesIanvs;
    let hasIanvs = false;
    let hasTrivago = false;
    for (let i = 0; i < this.names.length; i++) {
      if (OF_IANVS.indexOf(this.names[i] as string) >= 0) hasIanvs = true;
      if (OF_TRIVAGO.indexOf(this.names[i] as string) >= 0) hasTrivago = true;
    }
    if (hasIanvs || hasTrivago) return hasIanvs;
    if (order === null) return false;
    for (let i = 0; i < order.length; i++) {
      const group = order[i] as string;
      if (group.trim().length === 0 || group.indexOf("<TYPES>") >= 0) return true;
    }
    return false;
  }

  /** null if it fails (and `error` is set). */
  trivago(order0: string[] | null): TrivagoOptions | null {
    const order: string[] = order0 === null ? [] : order0.slice();
    if (order.indexOf(TRIVAGO_THIRD_PARTY_MODULES) < 0) order.unshift(TRIVAGO_THIRD_PARTY_MODULES);
    const groups: TrivagoGroup[] = [];
    for (let index = 0; index < order.length; index++) {
      const text = order[index] as string;
      const regex = this.regex(text.startsWith(TRIVAGO_TYPES) ? text.substring(TRIVAGO_TYPES.length) : text);
      if (regex === null) return null;
      const first = order.indexOf(text);
      groups.push(new TrivagoGroup(text, regex, first >= 0 ? first : index));
    }
    const options = new TrivagoOptions();
    options.order = groups;
    const flags: number[] = [];
    const flagNames = ["importOrderCaseInsensitive", "importOrderSeparation", "importOrderGroupNamespaceSpecifiers", "importOrderSortSpecifiers"];
    for (let i = 0; i < flagNames.length; i++) {
      const b = this.boolean(flagNames[i] as string, false);
      if (b < 0) return null;
      flags.push(b);
    }
    options.isCaseInsensitive = flags[0] === 1;
    options.separation = flags[1] === 1;
    options.groupNamespaceSpecifiers = flags[2] === 1;
    options.sortSpecifiers = flags[3] === 1;
    const byLength = this.get("importOrderSortByLength");
    if (byLength === null || byLength === "null") options.sortByLength = BY_LENGTH_NONE;
    else if (byLength === "asc") options.sortByLength = BY_LENGTH_ASCENDING;
    else if (byLength === "desc") options.sortByLength = BY_LENGTH_DESCENDING;
    else {
      this.error = invalid("importOrderSortByLength", byLength);
      return null;
    }
    const sideEffects = this.boolean("importOrderSideEffects", true);
    if (sideEffects < 0) return null;
    options.sideEffects = sideEffects === 1;
    const keyword = this.get("importOrderImportAttributesKeyword");
    if (keyword === null || keyword === "with") options.attributesKeyword = "with";
    else if (keyword === "assert") options.attributesKeyword = "assert";
    else if (keyword === "with-legacy") options.attributesKeyword = "with-legacy";
    else {
      this.error = invalid("importOrderImportAttributesKeyword", keyword);
      return null;
    }
    const exclude = this.strings("importOrderExclude");
    if (exclude === null && this.error !== "") return null;
    if (exclude !== null) for (let i = 0; i < exclude.length; i++) options.exclude.push(new TrivagoExclude(exclude[i] as string));
    return options;
  }

  /** `examineAndNormalizePluginOptions`. null: failed (`error` is set) or `importOrder` is empty, which turns the plugin off (`error` is ""). */
  ianvs(order0: string[] | null): IanvsOptions | null {
    const isSeparator = (group: string): boolean => group.trim().length === 0;
    const order: string[] = order0 === null ? [IANVS_BUILTIN_MODULES, IANVS_THIRD_PARTY_MODULES, "^[.]"] : order0.slice();
    if (order.length === 0) return null;
    const at = isSeparator(order[0] as string) ? 1 : 0;
    const words = [IANVS_THIRD_PARTY_MODULES, IANVS_BUILTIN_MODULES];
    for (let w = 0; w < words.length; w++) if (order.indexOf(words[w] as string) < 0) order.splice(at, 0, words[w] as string);
    const groups: IanvsGroup[] = [];
    for (let index = 0; index < order.length; index++) {
      const text = order[index] as string;
      const first = order.indexOf(text);
      const sameAs = first >= 0 ? first : index;
      if (isSeparator(text)) groups.push(new IanvsGroup(M_SEPARATOR, null, false, sameAs));
      else if (text === IANVS_THIRD_PARTY_MODULES) groups.push(new IanvsGroup(M_THIRD_PARTY, null, false, sameAs));
      else if (text === IANVS_BUILTIN_MODULES) groups.push(new IanvsGroup(M_BUILTIN, null, false, sameAs));
      else if (text === IANVS_TYPES) groups.push(new IanvsGroup(M_TYPES, null, false, sameAs));
      else {
        const t = text.indexOf(IANVS_TYPES);
        if (t >= 0) {
          const regex = this.regex(text.substring(0, t) + text.substring(t + IANVS_TYPES.length));
          if (regex === null) return null;
          groups.push(new IanvsGroup(M_REGEX, regex, true, sameAs));
        } else {
          const regex = this.regex(text);
          if (regex === null) return null;
          groups.push(new IanvsGroup(M_REGEX, regex, false, sameAs));
        }
      }
    }
    let hasTypes = false;
    for (let i = 0; i < order.length; i++) if ((order[i] as string).indexOf(IANVS_TYPES) >= 0) hasTypes = true;
    const parserPlugins = this.strings("importOrderParserPlugins");
    if (parserPlugins === null && this.error !== "") return null;
    const hasTypescript = parserPlugins === null || parserPlugins.indexOf("typescript") >= 0;
    const versionText = this.get("importOrderTypeScriptVersion");
    // `version < ((4, 5, 0), true)`
    let versionIsLess = false;
    if (versionText !== null) {
      const v = semver(versionText);
      if (v !== null) versionIsLess = v[0] !== 4 ? (v[0] as number) < 4 : v[1] !== 5 ? (v[1] as number) < 5 : v[2] !== 0 ? (v[2] as number) < 0 : v[3] === 0;
      else versionIsLess = true; // (1, 0, 0), false
    } else {
      versionIsLess = true;
    }
    const safe = this.strings("importOrderSafeSideEffects");
    if (safe === null && this.error !== "") return null;
    const safeSideEffects: RegExp[] = [];
    if (safe !== null) {
      for (let i = 0; i < safe.length; i++) {
        const r = this.regex(safe[i] as string);
        if (r === null) return null;
        safeSideEffects.push(r);
      }
    }
    const caseSensitive = this.boolean("importOrderCaseSensitive", false);
    if (caseSensitive < 0) return null;
    const options = new IanvsOptions();
    options.order = groups;
    options.combineTypeAndValueImports = !hasTypes && !(hasTypescript && versionIsLess);
    options.isCaseSensitive = caseSensitive === 1;
    options.safeSideEffects = safeSideEffects;
    return options;
  }

  /** `new RegExp(pattern)`; null (and `error` is set) if it is not valid. */
  regex(pattern: string): RegExp | null {
    try {
      return new RegExp(pattern);
    } catch (e) {
      this.error = "Invalid regular expression in importOrder: " + (e instanceof Error ? e.message : "Invalid regular expression: /" + pattern + "/");
      return null;
    }
  }

  /** null: imports are left as they are (`error` is "") or it is wrong (`error` is the reason, for the user). */
  compile(): SortImports | null {
    this.error = "";
    // The last one set wins.
    let wholeAt = -1;
    for (let i = this.names.length - 1; i >= 0; i--) {
      const n = this.names[i] as string;
      if (n === "sortImports" || n === "experimentalSortImports" || n === OF_BUN) {
        wholeAt = i;
        break;
      }
    }
    if (wholeAt >= 0) {
      const isNative = this.names[wholeAt] === OF_BUN;
      const options = compileOxfmt(this.values[wholeAt] as string, isNative);
      if (options === null) {
        this.error = oxfmtError.message;
        return null;
      }
      const how = new SortImports(isNative ? HOW_NATIVE : HOW_OXFMT);
      how.oxfmt = options;
      return how;
    }
    // Prettier does not know the options of a plugin that is not named.
    if (!this.namesPlugin(SORT_IMPORTS)) {
      if (!this.namesPlugin(ORGANIZE_IMPORTS)) return null;
      const options = new OrganizeOptions();
      const skips = this.boolean("organizeImportsSkipDestructiveCodeActions", false);
      if (skips < 0) return null;
      options.skipsDestructiveCodeActions = skips === 1;
      const typeOrder = this.get("organizeImportsTypeOrder");
      if (typeOrder === null) options.typeOrder = -1;
      else if (typeOrder === "last") options.typeOrder = TYPE_ORDER_LAST;
      else if (typeOrder === "first") options.typeOrder = TYPE_ORDER_FIRST;
      else if (typeOrder === "inline") options.typeOrder = TYPE_ORDER_INLINE;
      else {
        this.error = invalid("organizeImportsTypeOrder", typeOrder);
        return null;
      }
      const jsx = this.get("tsconfig.jsx");
      options.jsxNeedsImport = jsx === "react" || jsx === "react-native";
      const factory = this.get("tsconfig.jsxFactory");
      const reactNamespace = this.get("tsconfig.reactNamespace");
      options.jsxNamespace = factory !== null ? firstName(factory) : reactNamespace !== null ? reactNamespace : "React";
      const fragment = this.get("tsconfig.jsxFragmentFactory");
      options.jsxFragmentFactory = fragment === null ? "" : firstName(fragment);
      const how = new SortImports(HOW_ORGANIZE);
      how.organize = options;
      return how;
    }
    const order = this.strings("importOrder");
    if (order === null && this.error !== "") return null;
    if (this.isIanvs(order)) {
      const options = this.ianvs(order);
      if (options === null) return null;
      const how = new SortImports(HOW_IANVS);
      how.ianvs = options;
      return how;
    }
    const options = this.trivago(order);
    if (options === null) return null;
    const how = new SortImports(HOW_TRIVAGO);
    how.trivago = options;
    return how;
  }
}

/** `semver.valid(version)`: the three numbers, and whether it is a release and not a prerelease (1 or 0). null: not valid. */
function semver(version0: string): number[] | null {
  let version = version0.trim();
  if (version.startsWith("=")) version = version.substring(1);
  if (version.startsWith("v")) version = version.substring(1);
  const plus = version.indexOf("+");
  if (plus >= 0) version = version.substring(0, plus);
  let numbers = version;
  let prerelease: string | null = null;
  const dash = version.indexOf("-");
  if (dash >= 0) {
    numbers = version.substring(0, dash);
    prerelease = version.substring(dash + 1);
  }
  if (prerelease !== null && prerelease.length === 0) return null;
  const parts = numbers.split(".");
  if (parts.length !== 3) return null;
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const part = parts[i] as string;
    if (part.length === 0) return null;
    for (let k = 0; k < part.length; k++) {
      const c = part.charCodeAt(k);
      if (c < 48 || c > 57) return null;
    }
    if (part.length > 1 && part.charCodeAt(0) === 48) return null;
    out.push(Number(part));
  }
  out.push(prerelease === null ? 1 : 0);
  return out;
}

/** The `a` of `a.b.c`. */
function firstName(entity: string): string {
  const dot = entity.indexOf(".");
  return dot >= 0 ? entity.substring(0, dot) : entity;
}
