// Reads `[fmt]` from bunfig.toml: port of the `[fmt]` half of vendor/bun/src/lint/driver/bunfig.rs. A key sets the default
// for the flag with the same name; a section is turned into the same `Options` as a command line.
import * as cli from "./cli.ts";
import * as fsx from "./fsx.ts";
import { J_ARR, J_BOOL, J_NUM, J_OBJ, J_STR, JV, numberToText, parseToml, tomlError, tomlErrorLine, tomlErrorColumn, toJsonText } from "./jsonv.ts";
import { isValidOption } from "./options.ts";
import { Problem, printProblem, problemAt } from "./problem.ts";

// What went wrong in the file (null if nothing), for the user.
export let bunfigProblem: string = "";

class Refusal {
  at: number;
  message: string;
  constructor(at: number, message: string) {
    this.at = at;
    this.message = message;
  }
}

const FLAGS: string[] = [
  "disable-nested-config",
  "editorconfig",
  "config-precedence",
  "ignore-path",
  "with-node-modules",
  "error-on-unmatched-pattern",
  "ignore-unknown",
  "log-level",
  "threads",
  "allow-unsupported",
  "flavor",
  "print-width",
  "tab-width",
  "use-tabs",
  "semi",
  "single-quote",
  "jsx-single-quote",
  "quote-props",
  "trailing-comma",
  "bracket-spacing",
  "bracket-same-line",
  "arrow-parens",
  "object-wrap",
  "single-attribute-per-line",
  "html-whitespace-sensitivity",
  "vue-indent-script-and-style",
  "prose-wrap",
  "embedded-language-formatting",
  "end-of-line",
  "require-pragma",
  "check-ignore-pragma",
  "insert-pragma",
  "experimental-ternaries",
  "experimental-operator-position",
  "sort-imports",
  "sort-tailwindcss",
  "sort-package-json",
  "jsdoc",
  "insert-final-newline",
];

const ACTIONS: string[] = ["check", "list-different", "write", "stdin-filepath", "staged", "changed", "find-config-path", "range-start", "range-end", "cursor-offset", "init", "doctor", "format", "migrate", "list-files", "debug-check", "timing", "color", "cwd", "version", "help", "all", "help-all"];

// Flags that take a number (`<n>`), many values, or none.
const NUMBER_FLAGS: string[] = ["threads", "print-width", "tab-width"];
const MANY_FLAGS: string[] = ["ignore-path", "ignore-pattern", "plugin"];
const BOOLEAN_FLAGS: string[] = [
  "disable-nested-config",
  "editorconfig",
  "with-node-modules",
  "error-on-unmatched-pattern",
  "ignore-unknown",
  "allow-unsupported",
  "use-tabs",
  "semi",
  "single-quote",
  "jsx-single-quote",
  "bracket-spacing",
  "bracket-same-line",
  "single-attribute-per-line",
  "vue-indent-script-and-style",
  "require-pragma",
  "check-ignore-pragma",
  "insert-pragma",
  "experimental-ternaries",
  "sort-imports",
  "sort-tailwindcss",
  "sort-package-json",
  "jsdoc",
  "insert-final-newline",
];

function keyOf(flag: string): string {
  const parts = flag.split("-");
  let key = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    key += i > 0 && p.length > 0 ? p.charAt(0).toUpperCase() + p.substring(1) : p;
  }
  return key;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev.push(j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur.push(Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1));
    }
    prev = cur;
  }
  return prev[n];
}

function notAKey(key: string, section: string, meant: string): string {
  let message = 'Unknown key "' + key + '" in [' + section + "]";
  if (meant !== "") message += '\n  Did you mean "' + meant + '"?';
  return message;
}

function unknownKey(key: string, at: number, section: string, keys: string[]): Refusal {
  let best = "";
  let bestD = 1000000;
  for (let i = 0; i < keys.length; i++) {
    const d = editDistance(key, keys[i]);
    if (d < bestD) {
      bestD = d;
      best = keys[i];
    }
  }
  const limit = Math.floor(Math.max(key.length, 3) / 3);
  return new Refusal(at, notAKey(key, section, bestD <= limit ? best : ""));
}

function tagName(v: JV): string {
  switch (v.kind) {
    case J_BOOL:
      return "boolean";
    case J_NUM:
      return "number";
    case J_STR:
      return "string";
    case J_ARR:
      return "array";
    case J_OBJ:
      return "object";
    default:
      return "null";
  }
}

function expected(what: string, v: JV): Refusal {
  return new Refusal(v.at, "expected " + what + " but received " + tagName(v));
}

// The text a flag is given for `value`.
function textOf(flag: string, value: JV, what: string): string | Refusal {
  if (NUMBER_FLAGS.indexOf(flag) >= 0) {
    if (value.kind === J_NUM) return numberToText(value.n);
    return expected("number", value);
  }
  if (value.kind === J_STR) return value.s;
  return expected(what, value);
}

// `give`: takes in `value` as what the flag is given. null if it went well.
function give(options: cli.Options, flag: string, value: JV): Refusal | null {
  const at = (): Refusal | null => {
    if (cli.usageError === "") return null;
    return new Refusal(value.at, cli.usageError);
  };
  cli.clearUsageError();
  if (BOOLEAN_FLAGS.indexOf(flag) >= 0) {
    if (value.kind !== J_BOOL) return expected("boolean", value);
    if (!options.set(flag, null, value.b)) return at();
    return null;
  }
  if (MANY_FLAGS.indexOf(flag) >= 0) {
    if (value.kind === J_ARR) {
      for (let i = 0; i < value.items.length; i++) {
        const t = textOf(flag, value.items[i], "string");
        if (typeof t !== "string") return t;
        if (!options.set(flag, t, true)) return new Refusal(value.items[i].at, cli.usageError);
      }
      return null;
    }
    const t = textOf(flag, value, "array");
    if (typeof t !== "string") return t;
    if (!options.set(flag, t, true)) return at();
    return null;
  }
  const t = textOf(flag, value, "string");
  if (typeof t !== "string") return t;
  if (!options.set(flag, t, true)) return at();
  return null;
}

class Feature {
  flag: string;
  name: string;
  // Stored as one JSON value (sortImports, sortTailwindcss) or as one entry per option
  isJson: boolean;
  options: string[];
  takes: number[]; // 0 boolean, 1 string, 2 strings, 3 array
  constructor(flag: string, name: string, isJson: boolean, options: string[], takes: number[]) {
    this.flag = flag;
    this.name = name;
    this.isJson = isJson;
    this.options = options;
    this.takes = takes;
  }
}

const FEATURES: Feature[] = [
  new Feature("sort-imports", "sortImports", true, ["groups", "customGroups", "internalPattern", "newlinesBetween", "order", "ignoreCase", "sortSideEffects", "partitionByComment", "partitionByNewline"], [3, 3, 2, 0, 1, 0, 0, 0, 0]),
  new Feature("sort-tailwindcss", "sortTailwindcss", true, ["stylesheet", "config", "functions", "attributes", "preserveWhitespace", "preserveDuplicates"], [1, 1, 2, 2, 0, 0]),
  new Feature("sort-package-json", "sortPackageJson", false, ["sortScripts"], [0]),
  new Feature("jsdoc", "jsdoc", false, ["capitalizeDescriptions", "commentLineStrategy", "separateTagGroups", "separateReturnsFromParam", "bracketSpacing", "descriptionWithDot", "addDefaultToDescription", "preferCodeFences", "lineWrappingStyle", "descriptionTag", "keepUnparsableExampleIndent"], [0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0]),
];

function checkTakes(takes: number, v: JV): Refusal | null {
  if (takes === 0) return v.kind === J_BOOL ? null : expected("boolean", v);
  if (takes === 1) return v.kind === J_STR ? null : expected("string", v);
  if (takes === 3) return v.kind === J_ARR ? null : expected("array", v);
  if (v.kind !== J_ARR) return expected("array", v);
  for (let i = 0; i < v.items.length; i++) if (v.items[i].kind !== J_STR) return expected("string", v.items[i]);
  return null;
}

function setFeature(f: Feature, value: JV, options: cli.Options): Refusal | null {
  if (value.kind === J_BOOL) {
    cli.clearUsageError();
    if (!options.set(f.flag, null, value.b)) return new Refusal(value.at, cli.usageError);
    return null;
  }
  if (value.kind !== J_OBJ) return expected("boolean or object", value);
  const partNames: string[] = [];
  const partValues: string[] = [];
  for (let i = 0; i < value.keys.length; i++) {
    const k = f.options.indexOf(value.keys[i]);
    if (k < 0) return unknownKey(value.keys[i], value.keyAts[i], "fmt." + f.name, f.options);
    const v = value.items[i];
    const r = checkTakes(f.takes[k], v);
    if (r !== null) return r;
    if (f.isJson) continue;
    const text = v.kind === J_STR ? v.s : toJsonText(v);
    const name = f.name + "." + f.options[k];
    if (!isValidOption(name, text)) return new Refusal(v.at, "Invalid " + name + " value: " + text + ".");
    partNames.push(name);
    partValues.push(text);
  }
  let whole: string;
  if (f.isJson) whole = toJsonText(value);
  else whole = "true";
  options.formatNames.push(f.name);
  options.formatValues.push(whole);
  for (let i = 0; i < partNames.length; i++) {
    options.formatNames.push(partNames[i]);
    options.formatValues.push(partValues[i]);
  }
  return null;
}

// Applies `key = value` from `[fmt]` or from the `options` of an override.
function setInFormat(key: string, keyAt: number, value: JV, options: cli.Options): Refusal | null {
  for (let i = 0; i < FEATURES.length; i++) if (FEATURES[i].name === key) return setFeature(FEATURES[i], value, options);
  // the flag that `key` is the default of
  let flag = "";
  if (key === "config") flag = "config";
  else if (key === "ignorePatterns") flag = "ignore-pattern";
  else {
    for (let i = 0; i < FLAGS.length; i++) {
      if (keyOf(FLAGS[i]) === key) {
        flag = FLAGS[i];
        break;
      }
    }
  }
  if (flag === "") {
    for (let i = 0; i < ACTIONS.length; i++) {
      if (keyOf(ACTIONS[i]) === key) {
        return new Refusal(keyAt, '"' + key + '" cannot be set in bunfig.toml\n  Use --' + ACTIONS[i] + " on the command line");
      }
    }
    if (key === "ignore-pattern") return new Refusal(keyAt, notAKey(key, "fmt", "ignorePatterns"));
    const keys: string[] = ["config", "ignorePatterns", "overrides"];
    for (let i = 0; i < FLAGS.length; i++) keys.push(keyOf(FLAGS[i]));
    return unknownKey(key, keyAt, "fmt", keys);
  }
  const r = give(options, flag, value);
  if (r !== null) return r;
  // The flag only reports an invalid value once the first file is formatted. Here it's checked right away.
  const n = options.formatNames.length;
  if (n > 0 && value.kind !== J_BOOL && options.formatNames[n - 1] === key) {
    if (!isValidOption(key, options.formatValues[n - 1])) {
      return new Refusal(value.at, "Invalid " + key + " value: " + options.formatValues[n - 1] + ".");
    }
  }
  return null;
}

function patterns(value: JV): string[] | Refusal {
  const all: string[] = [];
  if (value.kind === J_STR) all.push(value.s);
  else if (value.kind === J_ARR) {
    for (let i = 0; i < value.items.length; i++) {
      if (value.items[i].kind !== J_STR) return expected("string", value.items[i]);
      all.push(value.items[i].s);
    }
  } else return expected("string or array", value);
  return all;
}

function overrides(value: JV): cli.Override[] | Refusal {
  if (value.kind === J_OBJ) return new Refusal(value.at, '"overrides" is an array of tables\n  Write [[fmt.overrides]], with two brackets');
  if (value.kind !== J_ARR) return expected("array", value);
  const out: cli.Override[] = [];
  for (let i = 0; i < value.items.length; i++) {
    const item = value.items[i];
    if (item.kind !== J_OBJ) return expected("object", item);
    const it = new cli.Override();
    for (let k = 0; k < item.keys.length; k++) {
      const key = item.keys[k];
      const v = item.items[k];
      if (key === "files") {
        const p = patterns(v);
        if (!Array.isArray(p)) return p;
        it.files = p;
      } else if (key === "excludeFiles") {
        const p = patterns(v);
        if (!Array.isArray(p)) return p;
        it.excluded = p;
      } else if (key === "options") {
        if (v.kind !== J_OBJ) return expected("object", v);
        const o = new cli.Options();
        for (let q = 0; q < v.keys.length; q++) {
          const ok = v.keys[q];
          const ov = v.items[q];
          if (ok === "parser") {
            cli.clearUsageError();
            if (ov.kind !== J_STR) return expected("string", ov);
            if (!o.set("parser", ov.s, true)) return new Refusal(ov.at, cli.usageError);
            continue;
          }
          const keys: string[] = [];
          for (let f = 0; f < FLAGS.length; f++) if (cli.optionOf(FLAGS[f]) !== "") keys.push(keyOf(FLAGS[f]));
          if (keys.indexOf(ok) < 0) return unknownKey(ok, v.keyAts[q], "fmt.overrides.options", keys.concat(["parser"]));
          const r = setInFormat(ok, v.keyAts[q], ov, o);
          if (r !== null) return r;
        }
        it.formatNames = o.formatNames;
        it.formatValues = o.formatValues;
      } else {
        return unknownKey(key, item.keyAts[k], "fmt.overrides", ["files", "excludeFiles", "options"]);
      }
    }
    if (it.files.length === 0) return new Refusal(item.at, 'an override needs "files"');
    out.push(it);
  }
  return out;
}

// Reads `[fmt]` of the bunfig.toml in `cwd`. Returns the defaults for the flags, or null (nothing, or an error: then
// `bunfigProblem` is not empty).
export function readBunfig(cwd: string, colors: boolean): cli.Options | null {
  bunfigProblem = "";
  const path = cwd + "/bunfig.toml";
  const text = fsx.readText(path);
  if (text === null) return null;
  const file = parseToml(text);
  const show = (at: number, message: string): void => {
    const buf = Buffer.from(text);
    const byteAt = Buffer.byteLength(text.substring(0, Math.max(0, at)));
    const p = problemAt(buf, buf.length, message, byteAt, false);
    bunfigProblem = printProblem(p, "bunfig.toml", true, colors);
    // a single trailing line break
    bunfigProblem = bunfigProblem.substring(0, bunfigProblem.length - 1);
  };
  if (file === null) {
    // the position the parser stopped at
    let at = 0;
    let line = 1;
    while (at < text.length && line < tomlErrorLine) {
      if (text.charCodeAt(at) === 10) line = line + 1;
      at = at + 1;
    }
    at = at + tomlErrorColumn - 1;
    show(at, tomlError);
    return null;
  }
  const format = file.get("format");
  if (format !== null) {
    show(format.at, "Unknown section [format]\n  Did you mean [fmt]?");
    return null;
  }
  const section = file.get("fmt");
  if (section === null) return null;
  if (section.kind !== J_OBJ) {
    const r = expected("object", section);
    show(r.at, r.message);
    return null;
  }
  const options = new cli.Options();
  for (let i = 0; i < section.keys.length; i++) {
    const key = section.keys[i];
    const value = section.items[i];
    // `--no-config` is the opposite of a flag that takes a value.
    if (key === "config" && value.kind === J_BOOL && !value.b) {
      options.configLookup = false;
      continue;
    }
    if (key === "overrides") {
      const o = overrides(value);
      if (!Array.isArray(o)) {
        show(o.at, o.message);
        return null;
      }
      options.overrides = o;
      continue;
    }
    const r = setInFormat(key, section.keyAts[i], value, options);
    if (r !== null) {
      show(r.at, r.message);
      return null;
    }
  }
  return options;
}
