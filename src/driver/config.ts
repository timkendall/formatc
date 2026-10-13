// Finds and reads the configuration of the formatter: Prettier's `resolveConfig`. Port of
// vendor/bun/src/lint/driver/fmt/config.rs (the Prettier flavor; oxfmt configuration files are refused).
import * as cli from "./cli.ts";
import { EditorConfigFile, Found as EcFound, readEditorConfig, optionsFor as editorconfigOptionsFor } from "./editorconfig.ts";
import { EditorConfigOx, optionsForOxfmt, optionsOfRootForOxfmt, readAsOxfmt } from "./editorconfig_oxfmt.ts";
import { globRefusal, OxcGlob } from "./oxfmt.ts";
import * as fsx from "./fsx.ts";
import { Glob, globOfPrettier, MICROMATCH } from "./glob.ts";
import * as gitignore from "./gitignore.ts";
import type { Chain } from "./gitignore.ts";
import {
  J_ARR,
  J_BOOL,
  J_NULL,
  J_NUM,
  J_OBJ,
  J_STR,
  JV,
  numberToText,
  parseJson,
  jsonError,
  parseToml,
  tomlError,
  tomlErrorLine,
  tomlErrorColumn,
  parseYaml,
  yamlError,
  toJsonText,
} from "./jsonv.ts";
import * as kinds from "./kinds.ts";
import { NO_END, Resolved, isOptionOfPrettier, isOptionWithString, isValidOption, notAnInteger } from "./options.ts";
import * as paths from "./paths.ts";
import { Settings as SortSettings } from "../format/js/sort_imports/mod.ts";

// A message for the user that ends the run (or the file).
export class Fatal extends Error {
  constructor(message: string) {
    super(message);
  }
}

// The names of configuration files, by priority: oxfmt's, then Prettier's `CONFIG_FILES`.
export const NAMES: string[] = [
  ".oxfmtrc.json",
  ".oxfmtrc.jsonc",
  "oxfmt.config.ts",
  "oxfmt.config.mts",
  "package.json",
  "package.yaml",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.js",
  "prettier.config.js",
  ".prettierrc.ts",
  "prettier.config.ts",
  ".prettierrc.mjs",
  "prettier.config.mjs",
  ".prettierrc.mts",
  "prettier.config.mts",
  ".prettierrc.cjs",
  "prettier.config.cjs",
  ".prettierrc.cts",
  "prettier.config.cts",
  ".prettierrc.toml",
];
const NAMES_OF_OXFMT = 4;

const OTHER_KEYS = ["$schema", "overrides", "plugins", "filepath"];
const SORT_IMPORTS_OF_BUN = "bun.sortImports";

const PLUGIN_FOR_CLASSES = "prettier-plugin-tailwindcss";
const PLUGIN_OF_OXC = "@prettier/plugin-oxc";

const PLUGINS_FOR_LANGUAGES_NAMES: string[] = [
  "prettier-plugin-packagejson",
  "prettier-plugin-svelte",
  "prettier-plugin-astro",
  "@prettier/plugin-pug",
  "@prettier/plugin-php",
  "@prettier/plugin-ruby",
  "@prettier/plugin-xml",
  "prettier-plugin-toml",
  "prettier-plugin-java",
  "prettier-plugin-kotlin",
  "prettier-plugin-sh",
  "prettier-plugin-prisma",
  "prettier-plugin-solidity",
  "prettier-plugin-sql",
  "prettier-plugin-rust",
  "prettier-plugin-nginx",
  "prettier-plugin-ini",
  "prettier-plugin-properties",
  "prettier-plugin-gherkin",
  "prettier-plugin-apex",
  "prettier-plugin-marko",
  "prettier-plugin-ejs",
  "prettier-plugin-elm",
];
const PLUGINS_FOR_LANGUAGES_ENDINGS: string[][] = [
  ["/package.json"],
  [".svelte"],
  [".astro"],
  [".pug", ".jade"],
  [".php"],
  [".rb", ".rake", ".gemspec", ".rbs", ".haml"],
  [".xml", ".svg", ".xsd", ".xsl", ".xslt", ".wsdl"],
  [".toml"],
  [".java"],
  [".kt", ".kts"],
  [".sh", ".bash", ".zsh", "Dockerfile", ".env"],
  [".prisma"],
  [".sol"],
  [".sql"],
  [".rs"],
  [".nginx", ".nginxconf"],
  [".ini"],
  [".properties"],
  [".feature"],
  [".cls", ".trigger", ".apex"],
  [".marko"],
  [".ejs"],
  [".elm"],
];

// The package that `name` belongs to.
export function packageOf(name: string): string {
  const folder = "node_modules";
  const at = name.lastIndexOf(folder);
  if (at < 0) return name;
  const after = name.substring(at + folder.length);
  if (after.length === 0 || (after.charCodeAt(0) !== 47 && after.charCodeAt(0) !== 92)) return name;
  const inside = after.substring(1);
  const endOfPart = (from: number): number => {
    for (let i = from; i < inside.length; i++) {
      const c = inside.charCodeAt(i);
      if (c === 47 || c === 92) return i;
    }
    return -1;
  };
  let end: number;
  if (inside.charCodeAt(0) === 64) {
    const scope = endOfPart(0);
    end = scope < 0 ? -1 : endOfPart(scope + 1);
  } else end = endOfPart(0);
  return end < 0 ? inside : inside.substring(0, end);
}

export function isBuiltInPlugin(name: string): boolean {
  const pkg = packageOf(name);
  return pkg.endsWith("/prettier-plugin-sort-imports") || pkg === "prettier-plugin-organize-imports" || pkg === PLUGIN_FOR_CLASSES || pkg === PLUGIN_OF_OXC;
}

function endingsOfPlugin(name: string): string[] | null {
  const pkg = packageOf(name);
  for (let i = 0; i < PLUGINS_FOR_LANGUAGES_NAMES.length; i++) {
    if (PLUGINS_FOR_LANGUAGES_NAMES[i] === pkg) return PLUGINS_FOR_LANGUAGES_ENDINGS[i];
  }
  return null;
}

export function isMissingPlugin(name: string): boolean {
  return !isBuiltInPlugin(name) && endingsOfPlugin(name) === null;
}

function nameOfPlugin(plugin: JV): string | null {
  if (plugin.kind === J_STR) return plugin.s;
  const opts = plugin.get("options");
  if (opts !== null && opts.get("tailwindConfig") !== null) return PLUGIN_FOR_CLASSES;
  const parsers = plugin.get("parsers");
  if (parsers !== null && parsers.get("oxc") !== null) return PLUGIN_OF_OXC;
  return null;
}

export class Plugins {
  namesOthers = false;
  sortsClasses = false;
  missing: string[] = [];
  endings: string[] = [];
  packages: string[] = [];

  // `json`: the options that may have `plugins`.
  static of(json: JV): Plugins | null {
    const plugins = json.get("plugins");
    if (plugins === null || plugins.kind !== J_ARR) return null;
    const p = new Plugins();
    for (let i = 0; i < plugins.items.length; i++) {
      const item = plugins.items[i];
      const name = nameOfPlugin(item);
      if (name === null || !isBuiltInPlugin(name)) p.namesOthers = true;
      if (name !== null && packageOf(name) === PLUGIN_FOR_CLASSES) p.sortsClasses = true;
      const shown = name === null ? "(an object)" : name;
      if (isMissingPlugin(shown)) p.missing.push(shown);
      if (item.kind === J_STR) {
        const s = item.s;
        if (!s.startsWith(".") && !s.startsWith("/") && !s.startsWith("file:")) p.packages.push(s);
        const e = endingsOfPlugin(s);
        if (e !== null) for (let k = 0; k < e.length; k++) p.endings.push(e[k]);
      }
    }
    return p;
  }
}

// Something that tells whether a path matches.
export interface PathMatcher {
  matches(path: string): boolean;
}

class Pattern {
  glob: PathMatcher;
  text: string;
  hasSlash: boolean;
  constructor(glob: PathMatcher, text: string) {
    this.glob = glob;
    this.text = text;
    this.hasSlash = text.indexOf("/") >= 0;
  }
}

function stringsOf(v: JV | null): string[] {
  const out: string[] = [];
  if (v === null) return out;
  if (v.kind === J_STR) out.push(v.s);
  else if (v.kind === J_ARR) {
    for (let i = 0; i < v.items.length; i++) if (v.items[i].kind === J_STR) out.push(v.items[i].s);
  }
  return out;
}

// Options by name, with their values as JSON text (a string without its quotes).
export class Settings {
  names: string[] = [];
  values: string[] = [];
  push(name: string, value: string): void {
    this.names.push(name);
    this.values.push(value);
  }
}

// An element of `overrides`.
export class OverrideRule {
  files: Pattern[] = [];
  excluded: Pattern[] = [];
  settings: Settings = new Settings();
  plugins: Plugins | null = null;
  // The patterns are Bun's globs (bunfig.toml) or oxfmt's: `excludeFiles` matches against the path like `files`.
  isBunfig = false;

  // Prettier's `pathMatchesGlobs`. `relative`: from the directory of the configuration file.
  matches(relative: string): boolean {
    if (this.isBunfig) {
      let hit = false;
      for (let i = 0; i < this.files.length && !hit; i++) hit = this.files[i].glob.matches(relative);
      if (!hit) return false;
      for (let i = 0; i < this.excluded.length; i++) if (this.excluded[i].glob.matches(relative)) return false;
      return true;
    }
    const name = paths.basename(relative);
    for (let pass = 0; pass < 2; pass++) {
      const withSlashes = pass === 1;
      const target = withSlashes ? relative : name;
      let hit = false;
      for (let i = 0; i < this.files.length && !hit; i++) {
        const p = this.files[i];
        if (p.hasSlash !== withSlashes) continue;
        hit = p.glob.matches(target) || p.text === relative;
      }
      if (!hit) continue;
      let excluded = false;
      for (let i = 0; i < this.excluded.length && !excluded; i++) {
        const p = this.excluded[i];
        excluded = p.glob.matches(target) || p.text === relative;
      }
      if (!excluded) return true;
    }
    return false;
  }
}

// A configuration file that has been read.
export class Config {
  path: string;
  settings: Settings = new Settings();
  overrides: OverrideRule[] = [];
  isOxfmt = false;
  plugins: Plugins = new Plugins();
  // `ignorePatterns` of oxfmt.
  ignores: Chain = null;
  constructor(path: string) {
    this.path = path;
  }

  // What `of` makes of the last override that is for the file at `path`.
  lastOverrideWithPlugins(path: string): Plugins | null {
    const relative = paths.relative(paths.dirname(this.path), path);
    for (let i = this.overrides.length - 1; i >= 0; i--) {
      const o = this.overrides[i];
      if (o.plugins === null) continue;
      if (o.matches(relative)) return o.plugins;
    }
    return null;
  }
}

// What counts for the files of a directory.
export class Scope {
  config: Config | null;
  // From the farthest to the nearest.
  editorconfigs: EditorConfigFile[];
  // With oxfmt, the one `.editorconfig` that counts: the nearest to the working directory.
  oxEditorconfig: EditorConfigOx | null;
  id: number;
  constructor(config: Config | null, editorconfigs: EditorConfigFile[]) {
    this.config = config;
    this.editorconfigs = editorconfigs;
    this.oxEditorconfig = null;
    this.id = 0;
  }
}

export class Found {
  scope: Scope | null;
  error: string | null;
  constructor(scope: Scope | null, error: string | null) {
    this.scope = scope;
    this.error = error;
  }
}

function dtoa(n: number): string {
  return numberToText(n);
}

function settingsOf(json: JV, isOxfmt: boolean): Settings {
  const settings = new Settings();
  if (json.kind !== J_OBJ) return settings;
  for (let i = 0; i < json.keys.length; i++) {
    const name = json.keys[i];
    const value = json.items[i];
    const isOption = isOptionOfPrettier(name);
    if ((value.kind === J_NULL || value.kind === J_BOOL || value.kind === J_NUM || value.kind === J_STR) && !isOxfmt && name.startsWith("tailwind")) {
      settings.push(name, toJsonText(value));
      continue;
    }
    if (value.kind === J_STR && isOption && !isOptionWithString(name)) {
      settings.push(name, '"' + value.s + '"');
      continue;
    }
    if (value.kind === J_STR) {
      settings.push(name, value.s);
      continue;
    }
    if (value.kind === J_NULL && isOption && !isOxfmt) {
      settings.push(name, "null");
      continue;
    }
    if (value.kind === J_BOOL) {
      settings.push(name, value.b ? "true" : "false");
      continue;
    }
    if (value.kind === J_NUM) {
      if (value.n >= 4294967295) settings.push(name, NO_END);
      else settings.push(name, dtoa(value.n));
      continue;
    }
    if ((value.kind === J_ARR || value.kind === J_OBJ) && (name === "plugins" || name.startsWith("importOrder") || name.endsWith("ortImports") || (isOxfmt && isTailwind(name)))) {
      settings.push(name, toJsonText(value));
      continue;
    }
    if (value.kind === J_OBJ && (name === "sortPackageJson" || name === "experimentalSortPackageJson")) {
      const sc = value.get("sortScripts");
      const sorts = sc !== null && sc.kind === J_BOOL && sc.b;
      settings.push("sortPackageJson", "true");
      settings.push("sortPackageJson.sortScripts", sorts ? "true" : "false");
      continue;
    }
    if (value.kind === J_OBJ && name === "jsdoc") {
      settings.push(name, "{}");
      for (let k = 0; k < value.keys.length; k++) {
        const pv = value.items[k];
        if (pv.kind === J_STR) settings.push("jsdoc." + value.keys[k], pv.s);
        else if (pv.kind === J_BOOL) settings.push("jsdoc." + value.keys[k], pv.b ? "true" : "false");
      }
      continue;
    }
    // A feature of oxfmt that is configured, and so is on.
    if (value.kind === J_OBJ && isOxfmt) {
      settings.push(name, "true");
      continue;
    }
    if ((value.kind === J_ARR || value.kind === J_OBJ) && !isOxfmt && OTHER_KEYS.indexOf(name) < 0) {
      settings.push(name, toJsonText(value));
      continue;
    }
  }
  return settings;
}

function isSortImportsName(name: string): boolean {
  return name.endsWith("ortImports");
}

function isTailwind(name: string): boolean {
  return name === "sortTailwindcss" || name === "experimentalTailwindcss";
}

export const HEAVY = 0;

function patternOf(text: string, isOxfmt: boolean): Pattern {
  return new Pattern(isOxfmt ? new OxcGlob(text) : globOfPrettier(text, MICROMATCH), text);
}

function buildOverride(it: JV, isOxfmt: boolean): OverrideRule {
  const o = new OverrideRule();
  // oxfmt: `excludeFiles` matches against the path like `files`
  o.isBunfig = isOxfmt;
  const files = stringsOf(it.get("files"));
  for (let i = 0; i < files.length; i++) o.files.push(patternOf(files[i], isOxfmt));
  const ex = stringsOf(it.get("excludeFiles"));
  for (let i = 0; i < ex.length; i++) o.excluded.push(patternOf(ex[i], isOxfmt));
  const opts = it.get("options");
  if (opts !== null) {
    o.settings = settingsOf(opts, isOxfmt);
    o.plugins = Plugins.of(opts);
  }
  return o;
}

function buildConfig(path: string, json: JV, isOxfmt: boolean): Config {
  const c = new Config(path);
  c.isOxfmt = isOxfmt;
  c.settings = settingsOf(json, isOxfmt);
  const overrides = json.get("overrides");
  if (overrides !== null && overrides.kind === J_ARR) {
    for (let i = 0; i < overrides.items.length; i++) c.overrides.push(buildOverride(overrides.items[i], isOxfmt));
  }
  const p = Plugins.of(json);
  if (p !== null) c.plugins = p;
  const ig = json.get("ignorePatterns");
  if (ig !== null && ig.kind === J_ARR) c.ignores = gitignore.withLines(null, paths.dirname(path), stringsOf(ig));
  return c;
}

function ofPrettier(directory: string, at: number): string | null {
  if (at >= NAMES.length) return null;
  const name = NAMES[at];
  if (!name.startsWith("package.")) return name;
  const text = fsx.readText(paths.join(directory, name));
  if (text === null) return null;
  const pkg = parseJson(text);
  if (pkg === null) return null;
  const p = pkg.get("prettier");
  if (p === null || p.kind === J_NULL || (p.kind === J_BOOL && !p.b)) return null;
  return "prettier in " + name;
}

function isNameOfOxfmt(name: string): boolean {
  return name.indexOf("oxfmt") >= 0;
}

function hasUpper(s: string): boolean {
  return s !== s.toLowerCase();
}

export class Configs {
  options: cli.Options;
  cwd: string;
  byDirectory: Map<string, Found>;
  // `[[fmt.overrides]]`: globs are relative to the working directory.
  overrides: OverrideRule[];
  named: Config | null;
  namedError: string | null;
  hasNamed: boolean;
  argumentDirs: string[];
  lacksFileCache: number;
  // 0: Prettier, 1: oxfmt
  flavor: number;
  warnings: string[];
  unsupportedOptions: string[];
  note: string;
  nextScopeId: number;
  scopes: Scope[];
  // With oxfmt, the one `.editorconfig` that counts: the nearest to the working directory.
  editorconfigOfOxfmt: EditorConfigOx | null;
  // Some configuration file has `ignorePatterns`.
  anyIgnores: boolean;

  constructor(options: cli.Options, cwd: string) {
    this.options = options;
    this.cwd = cwd;
    this.byDirectory = new Map<string, Found>();
    this.overrides = [];
    this.named = null;
    this.namedError = null;
    this.hasNamed = false;
    this.argumentDirs = [];
    this.lacksFileCache = -1;
    this.flavor = 0;
    this.warnings = [];
    this.unsupportedOptions = [];
    this.note = "";
    this.nextScopeId = 0;
    this.scopes = [];
    this.editorconfigOfOxfmt = null;
    this.anyIgnores = false;
    for (let i = 0; i < options.overrides.length; i++) {
      const src = options.overrides[i];
      const o = new OverrideRule();
      o.isBunfig = true;
      for (let k = 0; k < src.files.length; k++) o.files.push(new Pattern(bunfigGlob(src.files[k]), src.files[k]));
      for (let k = 0; k < src.excluded.length; k++) o.excluded.push(new Pattern(bunfigGlob(src.excluded[k]), src.excluded[k]));
      for (let k = 0; k < src.formatNames.length; k++) o.settings.push(src.formatNames[k], src.formatValues[k]);
      this.overrides.push(o);
    }
    let isOxfmt = false;
    const f = this.forDirectory(cwd);
    if (f.scope !== null) {
      if (f.scope.config !== null) isOxfmt = f.scope.config.isOxfmt;
      else if (options.isLikeOxfmt !== 0) isOxfmt = options.isLikeOxfmt === 1;
      else isOxfmt = this.dependsOnOxfmt(cwd);
    } else {
      // The name of the one that cannot be used tells.
      const dirs = paths.ancestors(cwd);
      for (let d = 0; d < dirs.length; d++) {
        let at = -1;
        for (let n = 0; n < NAMES.length; n++) {
          if (fsx.isFile(paths.join(dirs[d], NAMES[n]))) {
            at = n;
            break;
          }
        }
        if (at >= 0) {
          isOxfmt = at < NAMES_OF_OXFMT;
          break;
        }
      }
    }
    if (options.config !== null) {
      const path = paths.resolve(cwd, options.config);
      const name = paths.basename(path);
      isOxfmt = isNameOfOxfmt(name) || (isOxfmt && name.indexOf("prettier") < 0 && name !== "package.json");
      this.hasNamed = true;
      try {
        const c = this.load(path, isOxfmt);
        this.named = c !== null ? c : new Config(path);
      } catch (e) {
        if (e instanceof Fatal) this.namedError = e.message;
        else throw e;
      }
    }
    if (isOxfmt) {
      this.flavor = 1;
      this.byDirectory.clear();
      if (options.editorconfig) {
        const dirs = paths.ancestors(cwd);
        for (let i = 0; i < dirs.length; i++) {
          const e = readAsOxfmt(dirs[i]);
          if (e !== null) {
            this.editorconfigOfOxfmt = e;
            break;
          }
        }
      }
    }
  }

  dependsOnOxfmt(directory: string): boolean {
    const dirs = paths.ancestors(directory);
    for (let i = 0; i < dirs.length; i++) {
      const text = fsx.readText(paths.join(dirs[i], "package.json"));
      if (text === null) continue;
      const json = parseJson(text);
      if (json === null) return false;
      const has = (n: string): boolean => {
        const keys = ["dependencies", "devDependencies"];
        for (let k = 0; k < keys.length; k++) {
          const d = json.get(keys[k]);
          if (d !== null && d.get(n) !== null) return true;
        }
        return false;
      };
      const hasOxfmt = has("oxfmt") || has("vite-plus");
      // Depending on both suggests a migration to oxfmt, so oxfmt wins.
      if (hasOxfmt && has("prettier")) {
        if (this.note === "") this.note = "No config file found, and package.json depends on both oxfmt and prettier\n  Formatting like oxfmt. Add a config file to change that.";
      }
      return hasOxfmt;
    }
    return false;
  }

  // What is wrong with the configuration that the run starts with.
  check(): string {
    if (this.namedError !== null) return this.namedError;
    if (this.flavor === 1) {
      // `build_and_validate`: the configuration, and the first `[*]` of the `.editorconfig` for what it leaves open.
      const f = this.forDirectory(this.cwd);
      if (f.scope === null) return f.error === null ? "" : f.error;
      const config = this.configOf(f.scope);
      const names: string[] = [];
      const values: string[] = [];
      if (config !== null) {
        for (let i = 0; i < config.settings.names.length; i++) {
          names.push(config.settings.names[i]);
          values.push(config.settings.values[i]);
        }
      }
      const all = new Settings();
      const ox = f.scope.oxEditorconfig;
      if (ox !== null) {
        const fromEditorconfig = optionsOfRootForOxfmt(ox, useTabsIn(names, values));
        for (let i = 0; i < fromEditorconfig.names.length; i++) all.push(fromEditorconfig.names[i], fromEditorconfig.values[i]);
      }
      for (let i = 0; i < names.length; i++) all.push(names[i], values[i]);
      try {
        checkWidths(all.names, all.values);
      } catch (e) {
        if (e instanceof Fatal) return e.message;
        throw e;
      }
    }
    return "";
  }

  warn(text: string): void {
    if (this.warnings.indexOf(text) < 0) this.warnings.push(text);
  }

  // Prettier's `loadConfig`. null: the file has no configuration, like most `package.json`.
  load(path: string, isOxfmt: boolean): Config | null {
    const name = paths.basename(path);
    const read = (): string => {
      const text = fsx.readText(path);
      if (text === null) throw new Fatal("Cannot read the configuration file " + path + ": " + fsx.describeError(fsx.lastErrorCode, fsx.lastErrorMessage));
      return text;
    };
    const failWith = (why: string): Fatal => new Fatal("Cannot load the configuration file " + path + ":\n" + why);
    let json: JV | null = null;
    if (name === "package.json") {
      const text = read();
      if (text.indexOf('"prettier"') < 0) return null;
      const pkg = parseJson(text);
      const c = pkg === null ? null : pkg.get("prettier");
      if (c === null || c.kind === J_NULL || (c.kind === J_BOOL && !c.b)) return null;
      json = c;
    } else if (name === "package.yaml") {
      const text = read();
      const pkg = parseYaml(text);
      const c = pkg === null ? null : pkg.get("prettier");
      if (c === null || c.kind === J_NULL || (c.kind === J_BOOL && !c.b)) return null;
      json = c;
    } else if (name.endsWith(".json") || name.endsWith(".jsonc")) {
      json = parseJson(read());
      if (json === null) throw new Fatal('JSON Error in "' + path + '"');
    } else if (name.indexOf(".", 1) < 0) {
      // `.prettierrc`: YAML, which JSON is a part of.
      const text = read();
      const j = parseJson(text);
      if (j !== null && j.kind === J_OBJ) json = j;
      else {
        json = parseYaml(text);
        if (json === null) throw failWith(yamlMessage());
      }
    } else if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      json = parseYaml(read());
      if (json === null) throw failWith(yamlMessage());
    } else if (name.endsWith(".json5")) {
      json = parseJson(read());
      if (json === null) throw failWith(jsonError);
    } else if (name.endsWith(".toml")) {
      json = parseToml(read());
      if (json === null) throw failWith(tomlError + " (" + tomlErrorLine + ":" + tomlErrorColumn + ")");
    } else {
      // A JavaScript or TypeScript configuration is not run: an object literal in it is read as it is written.
      const text = read();
      json = objectLiteralOf(text);
      if (json === null) throw failWith("This build of bun fmt can only read a JavaScript or TypeScript configuration that is one object literal");
    }
    if (json.kind === J_STR) throw failWith("This build of bun fmt cannot load a configuration that is named by a package or a file yet");
    if (json.kind === J_BOOL || json.kind === J_NUM) {
      const kind = json.kind === J_BOOL ? "boolean" : "number";
      throw failWith("Config is only allowed to be an object, but received " + kind + ' in "' + path + '"');
    }
    if (json.kind === J_NULL) return null;
    const plugins = json.get("plugins");
    if (plugins !== null && plugins.kind !== J_ARR) throw failWith('"plugins" must be an array');
    const overrides = json.get("overrides");
    if (overrides !== null) {
      let ok = overrides.kind === J_ARR;
      if (ok) {
        for (let i = 0; i < overrides.items.length; i++) {
          const files = overrides.items[i].get("files");
          if (files === null) {
            ok = false;
            break;
          }
          if (files.kind === J_STR) continue;
          if (files.kind !== J_ARR) {
            ok = false;
            break;
          }
          for (let k = 0; k < files.items.length; k++) if (files.items[k].kind !== J_STR) ok = false;
        }
      }
      if (!ok) throw failWith('"overrides" must be an array of objects, each with "files" set to a pattern or an array of patterns');
    }
    if (isOxfmt) {
      const overrideList = overrides !== null && overrides.kind === J_ARR ? overrides.items : [];
      for (let i = 0; i < overrideList.length; i++) {
        const both = stringsOf(overrideList[i].get("files")).concat(stringsOf(overrideList[i].get("excludeFiles")));
        for (let k = 0; k < both.length; k++) {
          const refusal = globRefusal(both[k]);
          if (refusal !== "") throw new Fatal("Failed to parse configuration.\n" + refusal);
        }
      }
      const ignoredNode = json.get("ignorePatterns");
      const ignoredList = ignoredNode !== null && ignoredNode.kind === J_ARR ? stringsOf(ignoredNode) : [];
      for (let i = 0; i < ignoredList.length; i++) {
        if (ignoredList[i].split("/").indexOf("..") >= 0) {
          throw new Fatal("Failed to parse configuration.\nInvalid pattern `" + ignoredList[i] + "` in `ignorePatterns`: `..` is not supported, patterns are resolved within the config file's directory");
        }
      }
      const refused = gitignore.refusedLine(ignoredList);
      if (refused !== "") throw new Fatal("Failed to parse configuration.\nFailed to add ignore pattern `" + refused + "` from `ignorePatterns`");
    }
    const config = buildConfig(path, json, isOxfmt);
    if (config.ignores !== null) this.anyIgnores = true;
    // Plugins that this formatter does not include
    const missing: string[] = [];
    const lists: Plugins[] = [config.plugins];
    for (let i = 0; i < config.overrides.length; i++) {
      const p = config.overrides[i].plugins;
      if (p !== null) lists.push(p);
    }
    for (let i = 0; i < lists.length; i++) {
      for (let k = 0; k < lists[i].missing.length; k++) if (missing.indexOf(lists[i].missing[k]) < 0) missing.push(lists[i].missing[k]);
    }
    if (missing.length > 0 && this.options.allowUnsupported) {
      const end = missing.length === 1 ? " has no effect because bun fmt does not include that plugin" : " have no effect because bun fmt does not include those plugins";
      this.warn(missing.join(", ") + " in " + path + end);
    }
    return config;
  }

  // What counts in `directory`, whose parent has `above`. `entries`: the entries of the directory, or null.
  scopeOf(directory: string, entries: fsx.Entry[] | null, above: Scope | null): Found {
    const count = this.flavor === 1 ? NAMES_OF_OXFMT : NAMES.length;
    const candidates: number[] = [];
    let hasEditorconfig = false;
    let isProjectRoot = false;
    if (entries !== null) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const name = e.name;
        const c0 = name.charCodeAt(0);
        // '.', 'p', 'o', 'P', 'O'
        if (!(c0 === 46 || c0 === 112 || c0 === 111 || c0 === 80 || c0 === 79)) continue;
        if (this.isCalled(directory, name, ".git") || (e.isDirectory && this.isCalled(directory, name, ".hg"))) {
          isProjectRoot = true;
        } else if (!e.isDirectory && this.isCalled(directory, name, ".editorconfig")) {
          hasEditorconfig = true;
        } else if (!e.isDirectory) {
          for (let n = 0; n < NAMES.length; n++) {
            if (this.isCalled(directory, name, NAMES[n])) {
              if (n < count) candidates.push(n);
              break;
            }
          }
        }
      }
    }
    let config: Config | null = above !== null ? above.config : null;
    if (!this.hasNamed && this.options.configLookup && this.countsIn(directory)) {
      candidates.sort((a, b) => a - b);
      // dedupe
      const uniq: number[] = [];
      for (let i = 0; i < candidates.length; i++) if (i === 0 || candidates[i] !== candidates[i - 1]) uniq.push(candidates[i]);
      if (uniq.length >= 2 && uniq[1] < NAMES_OF_OXFMT) {
        return new Found(null, "Both '" + NAMES[uniq[0]] + "' and '" + NAMES[uniq[1]] + "' found in " + directory + ".");
      }
      try {
        for (let i = 0; i < uniq.length; i++) {
          const found = this.load(paths.join(directory, NAMES[uniq[i]]), uniq[i] < NAMES_OF_OXFMT);
          if (found !== null) {
            if (uniq[i] < NAMES_OF_OXFMT) {
              // oxfmt's wins over Prettier's in the same directory
              for (let k = i + 1; k < uniq.length; k++) {
                const other = ofPrettier(directory, uniq[k]);
                if (other !== null) {
                  this.noteIgnored(found.path, other);
                  break;
                }
              }
            }
            config = found;
            break;
          }
        }
      } catch (e) {
        if (e instanceof Fatal) return new Found(null, e.message);
        throw e;
      }
    }
    if (this.flavor === 1) {
      const s = new Scope(config, []);
      s.oxEditorconfig = this.editorconfigOfOxfmt;
      this.register(s);
      return new Found(s, null);
    }
    let own: EditorConfigFile | null = null;
    if (hasEditorconfig && this.options.editorconfig) own = readEditorConfig(directory);
    const startsOver = isProjectRoot || (own !== null && own.isRoot);
    let editorconfigs: EditorConfigFile[] = [];
    if (!startsOver && above !== null) editorconfigs = above.editorconfigs.slice();
    if (own !== null) editorconfigs.push(own);
    const scope = new Scope(config, editorconfigs);
    this.register(scope);
    return new Found(scope, null);
  }

  // Records that the oxfmt config at `used` won over the Prettier config `ignored` in the same directory.
  noteIgnored(used: string, ignored: string): void {
    if (this.note === "") this.note = "Using " + paths.relative(this.cwd, used) + ". " + ignored + " is ignored. Use --config to pick it.";
  }

  private isCalled(directory: string, name: string, wanted: string): boolean {
    if (name === wanted) return true;
    if (name.length === wanted.length && name.toLowerCase() === wanted.toLowerCase()) return fsx.exists(paths.join(directory, wanted));
    return false;
  }

  register(scope: Scope): void {
    // Scopes with the same config and the same editorconfigs are the same scope.
    const last = this.scopes.length > 0 ? this.scopes[this.scopes.length - 1] : null;
    scope.id = this.nextScopeId;
    this.nextScopeId = this.nextScopeId + 1;
    this.scopes.push(scope);
    if (last !== null) {
      // nothing to share: ids are distinct
    }
  }

  // Whether the working directory has no configuration file, in it or above it.
  lacksFile(): boolean {
    if (this.lacksFileCache < 0) {
      const own = this.forDirectory(this.cwd);
      this.lacksFileCache = own.scope !== null && own.scope.config === null ? 1 : 0;
    }
    return this.lacksFileCache === 1;
  }

  // True if the run is not imitating another tool: no Prettier or oxfmt config applies to the working directory, and no
  // flag asks for one.
  isNative(): boolean {
    return this.flavor === 0 && this.options.isLikeOxfmt === 0 && !this.hasNamed && (!this.options.configLookup || this.lacksFile());
  }

  // Says that `directory` is an argument, or that a file in it is one.
  name(directory: string): void {
    if (this.argumentDirs.indexOf(directory) < 0) this.argumentDirs.push(directory);
  }

  // Whether a configuration file in `directory` counts.
  countsIn(directory: string): boolean {
    const isFor = (it: string): boolean => paths.isAtOrInside(it, directory) || paths.isAtOrInside(directory, it);
    if (isFor(this.cwd)) return true;
    if (!this.lacksFile()) return true;
    for (let i = 0; i < this.argumentDirs.length; i++) if (isFor(this.argumentDirs[i])) return true;
    return false;
  }

  // What counts for the files in `directory`.
  forDirectory(directory: string): Found {
    if (this.options.disableNestedConfig) directory = this.cwd;
    const missing: string[] = [];
    let above: Found | null = null;
    const dirs = paths.ancestors(directory);
    for (let i = 0; i < dirs.length; i++) {
      const known = this.byDirectory.get(dirs[i]);
      if (known !== undefined) {
        above = known;
        break;
      }
      missing.push(dirs[i]);
    }
    for (let i = missing.length - 1; i >= 0; i--) {
      const dir = missing[i];
      const entries = fsx.list(dir);
      let found: Found;
      if (above === null) found = this.scopeOf(dir, entries, null);
      else if (above.scope !== null) found = this.scopeOf(dir, entries, above.scope);
      else {
        // A configuration file that cannot be used does not matter below a nearer one.
        const f = this.scopeOf(dir, entries, null);
        if (f.scope !== null && f.scope.config !== null) found = f;
        else found = above;
      }
      this.byDirectory.set(dir, found);
      above = found;
    }
    if (above === null) return new Found(null, "The path of a directory is empty.");
    return above;
  }

  // The same for a directory whose parent has `above`.
  forListedDirectory(directory: string, entries: fsx.Entry[], above: Scope): Found {
    if (this.options.disableNestedConfig) return new Found(above, null);
    const found = this.scopeOf(directory, entries, above);
    this.byDirectory.set(directory, found);
    return found;
  }

  // The configuration file for what has `scope`.
  configOf(scope: Scope): Config | null {
    if (!this.options.configLookup) return null;
    if (this.hasNamed) return this.named;
    return scope.config;
  }

  // `ignorePatterns` of the configuration file (oxfmt's only).
  ignoresOf(scope: Scope): Chain {
    const c = this.configOf(scope);
    return c === null ? null : c.ignores;
  }

  isOxfmtFor(scope: Scope): boolean {
    if (this.flavor === 1) return true;
    const c = this.configOf(scope);
    return c !== null && c.isOxfmt;
  }

  pluginsFor(scope: Scope, path: string | null): Plugins | null {
    const config = this.configOf(scope);
    if (config === null) return null;
    if (path !== null) {
      const o = config.lastOverrideWithPlugins(path);
      if (o !== null) return o;
    }
    return config.plugins;
  }

  missingPlugins(scope: Scope, path: string | null): string[] {
    const p = this.pluginsFor(scope, path);
    return p === null ? [] : p.missing;
  }

  // Whether Prettier reads the file at `path`, which has `scope`, with a plugin that adds a language.
  isReadByPlugin(scope: Scope, path: string): boolean {
    return this.pluginThatReads(scope, path) !== "";
  }

  // The plugin that adds the language of the file at `path`, which has `scope`, or "".
  pluginThatReads(scope: Scope, path: string): string {
    const endings: string[] = [];
    const p = this.pluginsFor(scope, path);
    if (p !== null) for (let i = 0; i < p.endings.length; i++) endings.push(p.endings[i]);
    for (let i = 0; i < this.options.plugins.length; i++) {
      const e = endingsOfPlugin(this.options.plugins[i]);
      if (e !== null) for (let k = 0; k < e.length; k++) endings.push(e[k]);
    }
    if (endings.length === 0) return "";
    for (let i = 0; i < PLUGINS_FOR_LANGUAGES_NAMES.length; i++) {
      const es = PLUGINS_FOR_LANGUAGES_ENDINGS[i];
      for (let k = 0; k < es.length; k++) {
        if (path.endsWith(es[k])) {
          for (let q = 0; q < endings.length; q++) if (endings[q] === es[k]) return PLUGINS_FOR_LANGUAGES_NAMES[i];
          break;
        }
      }
    }
    return "";
  }

  // Whether the config or `--plugin` names a plugin that isn't built in.
  namesOtherPlugins(scope: Scope, path: string | null): boolean {
    const p = this.pluginsFor(scope, path);
    if (p !== null && p.namesOthers) return true;
    for (let i = 0; i < this.options.plugins.length; i++) if (!isBuiltInPlugin(this.options.plugins[i])) return true;
    return false;
  }

  // True if Bun's own choices apply in `scope`: the run is native and the directory has no Prettier config.
  isNativeIn(scope: Scope): boolean {
    return this.isNative() && this.configOf(scope) === null;
  }

  pathOfConfig(scope: Scope): string | null {
    const c = this.configOf(scope);
    return c === null ? null : c.path;
  }

  // The option `parser` for the file at `path`, which has `scope`, if it is set. "" if not.
  parserFor(scope: Scope, path: string): string {
    let maySet = false;
    const opts = this.options;
    for (let i = 0; i < opts.formatNames.length; i++) if (opts.formatNames[i] === "parser") maySet = true;
    for (let i = 0; i < this.overrides.length && !maySet; i++) {
      if (this.overrides[i].settings.names.indexOf("parser") >= 0) maySet = true;
    }
    const config = this.configOf(scope);
    if (!maySet && config !== null) {
      if (config.settings.names.indexOf("parser") >= 0) maySet = true;
      for (let i = 0; i < config.overrides.length && !maySet; i++) {
        if (config.overrides[i].settings.names.indexOf("parser") >= 0) maySet = true;
      }
    }
    if (!maySet) return "";
    try {
      return this.optionsFor(scope, path).parser;
    } catch (e) {
      if (e instanceof Fatal) return "";
      throw e;
    }
  }

  // Prettier's `getOptionsForFile`: how to format the file at `path`, which has `scope`.
  optionsFor(scope: Scope, path: string): Resolved {
    return this.optionsOf(scope, path);
  }

  // The same for text without a file name, like `prettier --parser x < file`.
  optionsWithoutName(scope: Scope): Resolved {
    return this.optionsOf(scope, null);
  }

  // What `of` makes of the last override of oxfmt that is for the file at `path`, of those of which it makes something.
  // null: none.
  private svelteInLastOverride(config: Config, path: string): number {
    const relative = paths.relative(paths.dirname(config.path), path);
    for (let i = config.overrides.length - 1; i >= 0; i--) {
      const o = config.overrides[i];
      const v = lastSvelte(o.settings);
      if (v < 0) continue;
      if (o.matches(relative)) return v;
    }
    return -1;
  }

  // Whether the configuration of oxfmt has `svelte` for the file at `path`, which has `scope`: oxfmt formats a component only
  // then. An override can turn it on and off.
  formatsSvelte(scope: Scope, path: string): boolean {
    const config = this.configOf(scope);
    if (config === null || !config.isOxfmt) return false;
    const inOverride = this.svelteInLastOverride(config, path);
    if (inOverride >= 0) return inOverride === 1;
    const own = lastSvelte(config.settings);
    return own === 1;
  }

  // `tsconfig_of`: what the `tsconfig.json` nearest to `directory` says about JSX, as settings for the sorting of imports.
  private tsconfigs: Map<string, SortSettings> = new Map<string, SortSettings>();
  private tsconfigOf(directory: string): SortSettings {
    const known = this.tsconfigs.get(directory);
    if (known !== undefined) return known;
    const settings = new SortSettings();
    const ancestors = paths.ancestors(directory);
    for (let i = 0; i < ancestors.length; i++) {
      const candidate = paths.join(ancestors[i], "tsconfig.json");
      if (fsx.isFile(candidate)) {
        readTsconfig(candidate, settings);
        break;
      }
    }
    this.tsconfigs.set(directory, settings);
    return settings;
  }

  // `Configs::sort_imports`: the settings are checked once. Throws Fatal.
  private sortChecked: Map<string, string> = new Map<string, string>();
  private checkSortImports(sort: SortSettings): void {
    if (sort.names.length === 0) return;
    let key = "";
    for (let i = 0; i < sort.names.length; i++) key += sort.names[i] + "\u0001" + sort.values[i] + "\u0002";
    const known = this.sortChecked.get(key);
    if (known !== undefined) {
      if (known !== "") throw new Fatal(known);
      return;
    }
    sort.compile();
    this.sortChecked.set(key, sort.error);
    if (sort.error !== "") throw new Fatal(sort.error);
  }

  private optionsOf(scope: Scope, path: string | null): Resolved {
    const config = this.configOf(scope);
    const opts = this.options;
    const isOxfmt = this.isOxfmtFor(scope);
    // from the configuration file
    const fcNames: string[] = [];
    const fcValues: string[] = [];
    if (config !== null) {
      for (let i = 0; i < config.settings.names.length; i++) {
        fcNames.push(config.settings.names[i]);
        fcValues.push(config.settings.values[i]);
      }
      if (path !== null) {
        const relative = paths.relative(paths.dirname(config.path), path);
        for (let k = 0; k < config.overrides.length; k++) {
          const o = config.overrides[k];
          if (!o.matches(relative)) continue;
          for (let i = 0; i < o.settings.names.length; i++) {
            fcNames.push(o.settings.names[i]);
            fcValues.push(o.settings.values[i]);
          }
        }
      }
      // oxfmt has no such option.
      if (config.isOxfmt) {
        for (let i = 0; i < fcNames.length; i++) {
          if (fcNames[i] === "parser") {
            fcNames.splice(i, 1);
            fcValues.splice(i, 1);
            i = i - 1;
          }
        }
      }
    }
    // from .editorconfig
    const filesNames: string[] = [];
    const filesValues: string[] = [];
    let hasEditorconfigOptions = false;
    let fromEditorconfig: EcFound = new EcFound();
    if (opts.configLookup) {
      if (this.flavor === 1) {
        const ox = scope.oxEditorconfig;
        if (ox !== null) {
          const useTabs = useTabsIn(fcNames, fcValues);
          const f = path !== null ? optionsForOxfmt(ox, path, useTabs) : optionsOfRootForOxfmt(ox, useTabs);
          for (let i = 0; i < f.names.length; i++) fromEditorconfig.push(f.names[i], f.values[i]);
        }
      } else if (path !== null) {
        fromEditorconfig = editorconfigOptionsFor(scope.editorconfigs, path);
      }
    }
    for (let i = 0; i < fromEditorconfig.names.length; i++) {
      hasEditorconfigOptions = true;
      const n = fromEditorconfig.names[i];
      const v = fromEditorconfig.values[i];
      // oxfmt does not know `max_line_length = off`, Prettier does not know `insert_final_newline`.
      const counts = isOxfmt ? !(n === "printWidth" && v === NO_END) : n !== "insertFinalNewline";
      if (!counts) continue;
      filesNames.push(n);
      filesValues.push(v);
    }
    if (isOxfmt && filesNames.indexOf("printWidth") < 0) {
      filesNames.push("printWidth");
      filesValues.push("100");
    }
    for (let i = 0; i < fcNames.length; i++) {
      filesNames.push(fcNames[i]);
      filesValues.push(fcValues[i]);
    }
    const hasFiles = config !== null || hasEditorconfigOptions;
    // flags
    const flagNames: string[] = opts.formatNames.slice();
    const flagValues: string[] = opts.formatValues.slice();
    if (path !== null && this.overrides.length > 0) {
      const relative = paths.relative(this.cwd, path);
      for (let k = 0; k < this.overrides.length; k++) {
        const o = this.overrides[k];
        if (!o.matches(relative)) continue;
        for (let i = 0; i < o.settings.names.length; i++) {
          flagNames.push(o.settings.names[i]);
          flagValues.push(o.settings.values[i]);
        }
      }
    }
    for (let i = 0; i < flagNames.length; i++) if (flagNames[i] === "sortImports") flagNames[i] = SORT_IMPORTS_OF_BUN;
    let allNames: string[];
    let allValues: string[];
    if (opts.configPrecedence === cli.PRECEDENCE_CLI_OVERRIDE) {
      allNames = filesNames.concat(flagNames);
      allValues = filesValues.concat(flagValues);
    } else if (opts.configPrecedence === cli.PRECEDENCE_FILE_OVERRIDE) {
      allNames = flagNames.concat(filesNames);
      allValues = flagValues.concat(filesValues);
    } else if (hasFiles) {
      allNames = filesNames;
      allValues = filesValues;
    } else {
      allNames = flagNames;
      allValues = flagValues;
    }
    // Prettier looks at the flags first
    if (!isOxfmt) {
      for (let i = 0; i < opts.formatNames.length; i++) {
        const refusal = notAnInteger(opts.formatNames[i], opts.formatValues[i], true);
        if (refusal !== "") throw new Fatal(refusal);
      }
    }
    if (isOxfmt) checkWidths(allNames, allValues);
    const resolved = new Resolved();
    resolved.isOxfmt = isOxfmt;
    if (path !== null) resolved.set("filepath", path);
    resolved.toml = this.isNativeIn(scope);
    if (isOxfmt) {
      resolved.set("flavor", "oxfmt");
      // It sorts the keys of a `package.json` unless it is told not to.
      resolved.set("sortPackageJson", "true");
    }
    let sortImports: string | null = null;
    let sortTailwind: string | null = null;
    // The options that are about sorting imports (src/format/js/sort_imports).
    const sort = new SortSettings();
    // oxfmt-only options are also valid under a Prettier config when a flag or `[fmt]` sets them.
    const isKnown = (name: string): boolean => isOxfmt || flagNames.indexOf(name) >= 0;
    const knowsAllOptions = !isOxfmt && !this.namesOtherPlugins(scope, path);
    const unknownNames: string[] = [];
    const unknownValues: string[] = [];
    for (let i = 0; i < allNames.length; i++) {
      const name = allNames[i];
      const value = allValues[i];
      if (name === SORT_IMPORTS_OF_BUN) {
        sort.set(name, value);
      } else if (isOxfmt && isSortImportsName(name)) {
        // An override of oxfmt changes the keys that it has. `experimentalSortImports` is the old name.
        sortImports = sortImports === null ? value : mergedObjects(sortImports, value);
        sort.set("sortImports", sortImports);
      } else if (sort.set(name, value)) {
        // About sorting imports.
      } else if (name === "insertFinalNewline" && isKnown(name)) {
        resolved.omitsFinalNewline = value === "false";
      } else if ((name === "sortPackageJson" || name === "sortPackageJson.sortScripts") && isKnown(name)) {
        resolved.set(name, value);
      } else if (name === "experimentalSortPackageJson" && isOxfmt) {
        resolved.set("sortPackageJson", value);
      } else if (name === "jsdoc" || name.startsWith("jsdoc.")) {
        if (!isValidOption(name, value)) throw new Fatal("Invalid " + name + " value: " + value + ".");
        resolved.set(name, value);
      } else if (isTailwind(name) && isKnown(name)) {
        // An override changes the keys that it has.
        sortTailwind = sortTailwind === null ? value : mergedObjects(sortTailwind, value);
      } else if (isTailwind(name) && value !== "false") {
        if (this.unsupportedOptions.indexOf(name) < 0) this.unsupportedOptions.push(name);
      } else if (isOptionOfPrettier(name)) {
        if (!isValidOption(name, value)) {
          const refusal = notAnInteger(name, value, false);
          throw new Fatal(!isOxfmt && refusal !== "" ? refusal : "Invalid " + name + " value: " + value + ".");
        }
        resolved.set(name, value);
      } else if (knowsAllOptions && OTHER_KEYS.indexOf(name) < 0) {
        unknownNames.push(name);
        unknownValues.push(value);
      }
    }
    // TODO(port): tailwind sorting (needs the classes of the project); the value is passed on for the formatter
    if (sortTailwind !== null && sortTailwind !== "false") resolved.set("sortTailwindcss", sortTailwind);
    if (resolved.parser === "" && !isOxfmt && path !== null) {
      const parser = kinds.parserByInterpreter(path);
      if (parser !== "") resolved.set("parser", parser);
    }
    for (let i = 0; i < opts.plugins.length; i++) sort.addPlugin(opts.plugins[i]);
    const notNamedNames: string[] = [];
    const notNamedValues: string[] = [];
    sort.ofPluginsNotNamed(notNamedNames, notNamedValues);
    for (let i = 0; i < notNamedNames.length; i++) {
      this.warn("Ignored unknown option { " + notNamedNames[i] + ": " + shownValue(notNamedNames[i], notNamedValues[i]) + " }.");
    }
    for (let i = 0; i < unknownNames.length; i++) {
      this.warn("Ignored unknown option { " + unknownNames[i] + ": " + shownValue(unknownNames[i], unknownValues[i]) + " }.");
    }
    if (sort.organizesImports()) {
      const directory = path !== null ? paths.dirname(path) : this.cwd;
      const tsconfig = this.tsconfigOf(directory);
      for (let i = 0; i < tsconfig.names.length; i++) sort.set(tsconfig.names[i], tsconfig.values[i]);
    }
    this.checkSortImports(sort);
    resolved.sortNames = sort.names;
    resolved.sortValues = sort.values;
    resolved.finish();
    return resolved;
  }
}

// The last `svelte` among settings: 1 if it is not "false", 0 if it is, -1 if there is none.
function lastSvelte(s: Settings): number {
  for (let i = s.names.length - 1; i >= 0; i--) {
    if (s.names[i] === "svelte") return s.values[i] !== "false" ? 1 : 0;
  }
  return -1;
}

// `useTabs` in the settings: 0 if none, 1 if true, 2 if false.
function useTabsIn(names: string[], values: string[]): number {
  for (let i = names.length - 1; i >= 0; i--) {
    if (names[i] === "useTabs") return values[i] === "true" ? 1 : 2;
  }
  return 0;
}

// oxfmt's limits: `validate`, as far as it goes.
function checkWidths(names: string[], values: string[]): void {
  let printWidth: string | null = null;
  let tabWidth: string | null = null;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === "printWidth") printWidth = values[i];
    else if (names[i] === "tabWidth") tabWidth = values[i];
  }
  if (printWidth !== null) {
    const n = cli.parseDecimal(printWidth);
    if (!(n >= 1 && n <= 320)) throw new Fatal("Invalid printWidth: The line width should be between 1 and 320");
  }
  if (tabWidth !== null) {
    const n = cli.parseDecimal(tabWidth);
    if (!(n >= 0 && n <= 24)) throw new Fatal("Invalid tabWidth: The indent width should be between 0 and 24");
  }
}

// The object `before` with the keys of the object `after`, both as JSON. `after` if one is no object.
function mergedObjects(before: string, after: string): string {
  const b = parseJson(before);
  const a = parseJson(after);
  if (b === null || a === null || b.kind !== J_OBJ || a.kind !== J_OBJ) return after;
  const out = JV.obj();
  for (let i = 0; i < b.keys.length; i++) out.set(b.keys[i], b.items[i]);
  for (let i = 0; i < a.keys.length; i++) {
    // an entry of `after` replaces the one of `before` and goes to the end
    const at = out.keys.indexOf(a.keys[i]);
    if (at >= 0) {
      out.keys.splice(at, 1);
      out.items.splice(at, 1);
      out.keyAts.splice(at, 1);
    }
    out.set(a.keys[i], a.items[i]);
  }
  return toJsonText(out);
}

// `read_tsconfig`: adds what the `tsconfig.json` at `path` says about JSX, after what the files that it extends say.
class OpenTsconfig {
  path: string;
  json: JV;
  // How many of the files that it extends have been looked at.
  extended: number = 0;
  constructor(path: string, json: JV) {
    this.path = path;
    this.json = json;
  }
}

function openTsconfig(path: string): OpenTsconfig | null {
  const text = fsx.readText(path);
  if (text === null) return null;
  const json = parseJson(text);
  return json === null ? null : new OpenTsconfig(path, json);
}

function readTsconfig(path: string, settings: SortSettings): void {
  const chain: OpenTsconfig[] = [];
  const first = openTsconfig(path);
  if (first !== null) chain.push(first);
  while (chain.length > 0) {
    const last = chain[chain.length - 1];
    const ext = last.json.get("extends");
    let extended: JV[] = [];
    if (ext !== null && ext.kind === J_STR) extended = [ext];
    else if (ext !== null && ext.kind === J_ARR) extended = ext.items;
    if (last.extended >= extended.length) {
      const options = last.json.get("compilerOptions");
      const keys = ["jsx", "jsxFactory", "jsxFragmentFactory", "reactNamespace"];
      for (let i = 0; i < keys.length; i++) {
        const v = options === null ? null : options.get(keys[i]);
        if (v !== null && v.kind === J_STR) settings.set("tsconfig." + keys[i], v.s);
      }
      chain.pop();
      continue;
    }
    const name = extended[last.extended];
    last.extended = last.extended + 1;
    if (name.kind !== J_STR) continue;
    const directory = paths.dirname(last.path);
    const candidates = (base: string): string[] => [base, base + ".json", paths.join(base, "tsconfig.json")];
    let found: string | null = null;
    if (name.s.startsWith(".") || paths.isAbsolute(name.s)) {
      const list = candidates(paths.resolve(directory, name.s));
      for (let i = 0; i < list.length && found === null; i++) if (fsx.isFile(list[i])) found = list[i];
    } else {
      // A package.
      const ancestors = paths.ancestors(directory);
      for (let a = 0; a < ancestors.length && found === null; a++) {
        const list = candidates(paths.join(paths.join(ancestors[a], "node_modules"), name.s));
        for (let i = 0; i < list.length && found === null; i++) if (fsx.isFile(list[i])) found = list[i];
      }
    }
    // Not one that extends itself.
    if (found !== null) {
      let same = false;
      for (let i = 0; i < chain.length; i++) if (chain[i].path === found) same = true;
      if (!same) {
        const open = openTsconfig(found);
        if (open !== null) chain.push(open);
      }
    }
  }
}

// `write_as_shown`: the value as Prettier shows it in a warning.
function shownValue(name: string, value: string): string {
  const isJson = name.startsWith("tailwind");
  const v = parseJson(value);
  if (v === null || (!isJson && v.kind === J_STR)) return JSON.stringify(value);
  return showJv(v);
}

function showJv(v: JV): string {
  if (v.kind === J_ARR) {
    let out = "[";
    for (let i = 0; i < v.items.length; i++) out += (i > 0 ? ", " : "") + showJv(v.items[i]);
    return out + "]";
  }
  if (v.kind === J_OBJ && v.items.length > 0) {
    let out = "{ ";
    for (let i = 0; i < v.items.length; i++) {
      const key = v.keys[i];
      out += (i > 0 ? ", " : "") + (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)) + ": " + showJv(v.items[i]);
    }
    return out + " }";
  }
  return toJsonText(v);
}

// `Pattern::of_bunfig`: Bun's glob; a glob without a slash matches the file name in any directory.
function bunfigGlob(text: string): Glob {
  if (text.indexOf("/") < 0) return new Glob("**/" + text);
  return new Glob(text);
}

// What Bun says about YAML it cannot read: its parser's message. Only the duplicate key text is known here.
function yamlMessage(): string {
  if (yamlError.startsWith("Map keys must be unique")) return yamlError;
  return "Unexpected token";
}

// The object literal of a configuration in JavaScript or TypeScript:
// `module.exports = {..}`, `export default {..}`, `const config = {..}; export default config;`.
function objectLiteralOf(text: string): JV | null {
  const tryAt = (start: number): JV | null => {
    // the literal ends where the parser stops: parse the longest prefix by growing the end at each `}`
    let from = start;
    while (true) {
      const end = text.indexOf("}", from);
      if (end < 0) return null;
      const v = parseJson(text.substring(start, end + 1));
      if (v !== null && v.kind === J_OBJ) return v;
      from = end + 1;
    }
  };
  const direct = /(?:module\.exports\s*=|export\s+default)\s*(?:\/\*[\s\S]*?\*\/\s*)?\{/.exec(text);
  if (direct !== null) return tryAt(direct.index + direct[0].length - 1);
  const named = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?|module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?/.exec(text);
  if (named !== null) {
    const id = named[1] !== undefined ? named[1] : named[2];
    const def = new RegExp("(?:const|let|var)\\s+" + id + "\\s*(?::[^=]+)?=\\s*\\{").exec(text);
    if (def !== null) return tryAt(def.index + def[0].length - 1);
  }
  return null;
}
