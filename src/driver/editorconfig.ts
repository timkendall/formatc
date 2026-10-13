// `.editorconfig` as Prettier reads it: the package `editorconfig-without-wasm` 3.0.2 and Prettier's
// `editorConfigToPrettier`. Port of vendor/bun/src/lint/driver/fmt/editorconfig.rs (the Prettier half).
import * as fsx from "./fsx.ts";
import { Glob, fromMinimatch } from "./glob.ts";
import * as paths from "./paths.ts";

const V_TEXT = 0;
const V_NUMBER = 1;
const V_BOOL = 2;

class Value {
  kind: number;
  text: string;
  num: number;
  bool: boolean;
  constructor(kind: number) {
    this.kind = kind;
    this.text = "";
    this.num = 0;
    this.bool = false;
  }
  static ofText(t: string): Value {
    const v = new Value(V_TEXT);
    v.text = t;
    return v;
  }
  static ofNumber(n: number): Value {
    const v = new Value(V_NUMBER);
    v.num = n;
    return v;
  }
  static ofBool(b: boolean): Value {
    const v = new Value(V_BOOL);
    v.bool = b;
    return v;
  }
  isTruthy(): boolean {
    if (this.kind === V_TEXT) return this.text.length > 0;
    if (this.kind === V_NUMBER) return this.num !== 0;
    return this.bool;
  }
  // `isPositiveInteger(value)`: returns the number or -1
  positiveInteger(): number {
    if (this.kind === V_NUMBER && this.num > 0 && Math.floor(this.num) === this.num && this.num <= 9007199254740991) return this.num;
    return -1;
  }
  is(word: string): boolean {
    return this.kind === V_TEXT && this.text === word;
  }
}

class Section {
  name: string;
  glob: Glob | null;
  keys: string[];
  values: Value[];
  constructor(name: string, glob: Glob | null) {
    this.name = name;
    this.glob = glob;
    this.keys = [];
    this.values = [];
  }
  set(key: string, v: Value): void {
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i] === key) {
        this.values[i] = v;
        return;
      }
    }
    this.keys.push(key);
    this.values.push(v);
  }
}

export class EditorConfigFile {
  directory: string;
  isRoot: boolean;
  sections: Section[];
  constructor(directory: string) {
    this.directory = directory;
    this.isRoot = false;
    this.sections = [];
  }
}

const ANYTHING = "{*,*/**/*}";

// `buildFullGlob`: the name of a section, as a pattern for an absolute path.
function fullGlob(directory: string, pattern: string): string {
  let glob: string;
  const slash = pattern.indexOf("/");
  if (slash < 0) glob = "**/" + pattern;
  else if (slash === 0) glob = pattern.substring(1);
  else glob = pattern;
  let full = "";
  for (let i = 0; i < directory.length; i++) {
    const ch = directory.charAt(i);
    if ("?*()[]{}".indexOf(ch) >= 0) full += "[" + ch + "]";
    else full += ch;
  }
  full += "/";
  // a `**` that is only part of a path segment still matches across `/`
  let at = 0;
  while (at < glob.length) {
    const byte = glob.charCodeAt(at);
    // the run of `*` at `at`
    let end = at;
    while (end < glob.length && glob.charCodeAt(end) === 42) end = end + 1;
    const before = at > 0 ? glob.charCodeAt(at - 1) : -1;
    const startsName = before === -1 || before === 47 || before === 123 || before === 44;
    const after = end < glob.length ? glob.charCodeAt(end) : -1;
    const endsName = after === -1 || after === 47 || after === 44 || after === 125;
    if (end - at < 2) {
      const len = 1 + (byte === 92 && at + 1 < glob.length ? 1 : 0);
      full += glob.substring(at, at + len);
      at = at + len;
      continue;
    }
    if (startsName && endsName) full += "**";
    else if (startsName && !endsName) full += "**/*";
    else if (!startsName && endsName && after === 47) full += "*/**";
    else full += ANYTHING;
    at = end;
  }
  return full;
}

function isOneString(text: string): boolean {
  if (text.length < 2 || text.charCodeAt(0) !== 34 || text.charCodeAt(text.length - 1) !== 34) return false;
  let escaped = false;
  for (let i = 1; i < text.length - 1; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 && !escaped) return false;
    escaped = c === 92 && !escaped;
  }
  return !escaped;
}

function jsonNumber(text: string): number | null {
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(text)) return null;
  return Number(text);
}

// `normalizeProps`. `key` is in lower case.
function valueForPrettier(key: string, written: string): Value {
  const isKnown = key === "charset" || key === "end_of_line" || key === "indent_size" || key === "indent_style" || key === "insert_final_newline" || key === "trim_trailing_whitespace";
  if (written === "true") return Value.ofBool(true);
  if (written === "false") return Value.ofBool(false);
  if (written === "null") return Value.ofText(written);
  const num = jsonNumber(written);
  if (num !== null) return Value.ofNumber(num);
  if (isOneString(written)) {
    try {
      const parsed = JSON.parse(written) as string;
      return Value.ofText(parsed);
    } catch (e) {
      // fall through
    }
  }
  return Value.ofText(isKnown ? written.toLowerCase() : written);
}

function isJsSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0xfeff || c === 0x2028 || c === 0x2029;
}

function trimJs(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isJsSpace(s.charCodeAt(a))) a = a + 1;
  while (b > a && isJsSpace(s.charCodeAt(b - 1))) b = b - 1;
  return s.substring(a, b);
}

// `parse` of `ini-simple-parser`, and `processFileContents`. null: it throws, and nothing of the file counts.
function parseFile(directory: string, text: string): EditorConfigFile | null {
  const file = new EditorConfigFile(directory);
  let at = -1;
  const lines = text.split(/[\r\n]/);
  for (let li = 0; li < lines.length; li++) {
    const line = trimJs(lines[li]);
    if (line.length === 0 || line.charCodeAt(0) === 35 || line.charCodeAt(0) === 59) continue;
    if (line.charCodeAt(0) === 91) {
      if (line.charCodeAt(line.length - 1) === 93) {
        const name = line.substring(1, line.length - 1);
        let known = -1;
        for (let k = 0; k < file.sections.length; k++) {
          if (file.sections[k].name === name) {
            known = k;
            break;
          }
        }
        if (known >= 0) at = known;
        else {
          let glob: Glob | null = null;
          if (name.length > 0) glob = new Glob(fromMinimatch(fullGlob(directory, name)));
          file.sections.push(new Section(name, glob));
          at = file.sections.length - 1;
        }
        continue;
      }
      return null;
    }
    const equals = line.indexOf("=");
    if (equals < 0) return null;
    const key = trimJs(line.substring(0, equals)).toLowerCase();
    const value = valueForPrettier(key, trimJs(line.substring(equals + 1)));
    if (at >= 0) file.sections[at].set(key, value);
    else if (key === "root") file.isRoot = value.isTruthy();
  }
  return file;
}

// The `.editorconfig` in `directory`, if there is one.
export function readEditorConfig(directory: string): EditorConfigFile | null {
  const text = fsx.readText(paths.join(directory, ".editorconfig"));
  if (text === null) return null;
  const file = parseFile(directory, text);
  if (file === null) return new EditorConfigFile(directory);
  return file;
}

function textOfBool(b: boolean): string {
  return b ? "true" : "false";
}

// Names and values, in order.
export class Found {
  names: string[];
  values: string[];
  constructor() {
    this.names = [];
    this.values = [];
  }
  push(name: string, value: string): void {
    this.names.push(name);
    this.values.push(value);
  }
}

// The options of Prettier that `files` have for the file at `path`. `files`: from the farthest to the nearest.
export function optionsFor(files: EditorConfigFile[], path: string): Found {
  const keys: string[] = [];
  const vals: Value[] = [];
  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    if (paths.inside(file.directory, path) === null) continue;
    for (let s = 0; s < file.sections.length; s++) {
      const section = file.sections[s];
      const glob = section.glob;
      if (glob === null || !glob.matches(path)) continue;
      for (let k = 0; k < section.keys.length; k++) {
        const key = section.keys[k];
        let found = -1;
        for (let q = 0; q < keys.length; q++) {
          if (keys[q] === key) {
            found = q;
            break;
          }
        }
        if (found >= 0) {
          keys.splice(found, 1);
          vals.splice(found, 1);
        }
        keys.push(key);
        vals.push(section.values[k]);
      }
    }
  }
  const get = (key: string): Value | null => {
    for (let q = 0; q < keys.length; q++) if (keys[q] === key) return vals[q];
    return null;
  };
  const isWord = (v: Value | null, word: string): boolean => v !== null && v.is(word);
  // `processMatches`
  const tab = Value.ofText("tab");
  const indentStyle = get("indent_style");
  let indentSize = get("indent_size");
  let tabWidth = get("tab_width");
  if (isWord(indentStyle, "tab") && indentSize === null) indentSize = tab;
  if (tabWidth === null && !isWord(indentSize, "tab")) tabWidth = indentSize;
  if (isWord(indentSize, "tab") && tabWidth !== null) indentSize = tabWidth;

  // `editorConfigToPrettier`
  const out = new Found();
  let useTabs = 0; // 0 unset, 1 true, 2 false
  if (isWord(indentStyle, "space")) useTabs = 2;
  else if (isWord(indentStyle, "tab") || isWord(indentSize, "tab")) useTabs = 1;
  if (useTabs !== 0) out.push("useTabs", textOfBool(useTabs === 1));
  const shown = (n: number): string => (n <= 4294967295 ? String(n) : "4294967295");
  let width = -1;
  if (useTabs === 2 && indentSize !== null) width = indentSize.positiveInteger();
  if (width < 0 && tabWidth !== null) width = tabWidth.positiveInteger();
  if (width >= 0) out.push("tabWidth", shown(width));
  const maxLineLength = get("max_line_length");
  let printWidth = -1;
  if (isWord(maxLineLength, "off")) printWidth = 18446744073709551615;
  else if (maxLineLength !== null) printWidth = maxLineLength.positiveInteger();
  if (printWidth >= 0) out.push("printWidth", shown(printWidth));
  const quoteType = get("quote_type");
  if (isWord(quoteType, "single")) out.push("singleQuote", "true");
  else if (isWord(quoteType, "double")) out.push("singleQuote", "false");
  const final = get("insert_final_newline");
  if (final !== null && final.kind === V_BOOL) out.push("insertFinalNewline", textOfBool(final.bool));
  const eol = get("end_of_line");
  if (eol !== null && eol.kind === V_TEXT && (eol.text === "lf" || eol.text === "crlf" || eol.text === "cr")) out.push("endOfLine", eol.text);
  return out;
}
