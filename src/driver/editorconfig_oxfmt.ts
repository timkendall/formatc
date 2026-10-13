// `.editorconfig` as oxfmt reads it: the crate `editorconfig-parser` 0.0.4 and oxfmt's `apply_editorconfig`. Port of the oxfmt
// half of vendor/bun/src/lint/driver/fmt/editorconfig.rs.
import * as fsx from "./fsx.ts";
import { Glob } from "./glob.ts";
import { classEndOut, fromGlobsetClass, withoutEmptyAlternatives } from "./ignore.ts";
import * as paths from "./paths.ts";

const X_TEXT = 0;
const X_WHOLE = 1;
const X_UNSET = 2;
const X_NOTHING = 3;

class OxValue {
  kind: number;
  text: string;
  whole: number;
  constructor(kind: number, text: string, whole: number) {
    this.kind = kind;
    this.text = text;
    this.whole = whole;
  }
  is(word: string): boolean {
    return this.kind === X_TEXT && this.text === word;
  }
}

class OxSection {
  name: string;
  // null: globset rejects the pattern, so the section is for no file.
  glob: Glob | null;
  keys: string[];
  values: OxValue[];
  constructor(name: string, glob: Glob | null) {
    this.name = name;
    this.glob = glob;
    this.keys = [];
    this.values = [];
  }
  set(key: string, v: OxValue): void {
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

export class EditorConfigOx {
  // What the patterns are relative to.
  directory: string;
  sections: OxSection[];
  constructor(directory: string) {
    this.directory = directory;
    this.sections = [];
  }
}

const ANYTHING = "{*,*/**/*}";

function isUnicodeSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

function trimBoth(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isUnicodeSpace(s.charCodeAt(a))) a = a + 1;
  while (b > a && isUnicodeSpace(s.charCodeAt(b - 1))) b = b - 1;
  return s.substring(a, b);
}

function trimEnd(s: string): string {
  let b = s.length;
  while (b > 0 && isUnicodeSpace(s.charCodeAt(b - 1))) b = b - 1;
  return s.substring(0, b);
}

function trimStart(s: string): string {
  let a = 0;
  while (a < s.length && isUnicodeSpace(s.charCodeAt(a))) a = a + 1;
  return s.substring(a);
}

// globset's `Glob::new(written)`, where `*` and `?` also match `/`. null if globset rejects the pattern.
function globOfGlobset(written: string): Glob | null {
  let glob = "";
  if (written.startsWith("!")) glob += "\\";
  // The whole pattern is `**`, which matches everything.
  if (written === "**/") return new Glob("**");
  let at = 0;
  let depth = 0;
  while (at < written.length) {
    const byte = written.charCodeAt(at);
    if (byte === 42) {
      let end = at;
      while (end < written.length && written.charCodeAt(end) === 42) end = end + 1;
      const before = at > 0 ? written.charCodeAt(at - 1) : -1;
      const startsName = before === -1 || before === 47 || before === 123 || before === 44;
      const after = end < written.length ? written.charCodeAt(end) : -1;
      const endsName = after === -1 || after === 47 || after === 44 || after === 125;
      // Here only `/` or the start of the pattern begins a segment. An alternative can follow a name directly.
      const isAfterLiteral = at > 0 && (before === 123 || before === 44);
      if (startsName && !isAfterLiteral) glob += end - at === 2 && endsName ? "**" : "**/*";
      else glob += ANYTHING;
      at = end;
      continue;
    } else if (byte === 63) {
      glob += "{?,/}";
    } else if (byte === 92) {
      if (at + 2 > written.length) return null;
      glob += written.substring(at, at + 2);
      at = at + 1;
    } else if (byte === 91) {
      const cls = fromGlobsetClass(written, at, false);
      if (classEndOut < 0) return null;
      glob += cls;
      at = classEndOut;
      continue;
    } else if (byte === 123) {
      depth = depth + 1;
      glob += "{";
    } else if (byte === 125) {
      if (depth === 0) return null;
      depth = depth - 1;
      glob += "}";
    } else {
      glob += written.charAt(at);
    }
    at = at + 1;
  }
  if (depth > 0) return null;
  return new Glob(withoutEmptyAlternatives(glob));
}

// The `parse` of the property `key` in `editorconfig-parser`. null: it has no such property.
function valueForOxfmt(key: string, written: string): OxValue | null {
  let words: string[];
  let takesNumber = false;
  switch (key) {
    case "indent_style":
      words = ["tab", "space"];
      break;
    case "end_of_line":
      words = ["lf", "cr", "crlf"];
      break;
    case "insert_final_newline":
      words = ["true", "false"];
      break;
    case "quote_type":
      words = ["single", "double", "auto"];
      break;
    case "max_line_length":
      words = ["off"];
      takesNumber = true;
      break;
    case "indent_size":
    case "tab_width":
      words = [];
      takesNumber = true;
      break;
    default:
      return null;
  }
  const lower = written.toLowerCase();
  for (let i = 0; i < words.length; i++) {
    if (words[i] === lower) return new OxValue(X_TEXT, words[i], 0);
  }
  if (lower === "unset") return new OxValue(X_UNSET, "", 0);
  // `str::parse::<usize>`
  const digits = written.startsWith("+") ? written.substring(1) : written;
  if (takesNumber && digits.length > 0 && /^[0-9]+$/.test(digits) && digits.length <= 16) return new OxValue(X_WHOLE, "", Number(digits));
  return new OxValue(X_NOTHING, "", 0);
}

// `EditorConfig::parse`
function parseAsOxfmt(directory: string, text: string): EditorConfigOx {
  const file = new EditorConfigOx(directory);
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    if (line.endsWith("\r")) line = line.substring(0, line.length - 1);
    line = trimBoth(line);
    if (line.length === 0 || line.charCodeAt(0) === 35 || line.charCodeAt(0) === 59) continue;
    if (line.charCodeAt(0) === 91 && line.charCodeAt(line.length - 1) === 93) {
      const name = line.substring(1, line.length - 1);
      file.sections.push(new OxSection(name, globOfGlobset(name)));
    }
    // What follows a section that is not closed is of the one before.
    if (file.sections.length > 0) {
      const equals = line.indexOf("=");
      if (equals >= 0) {
        const key = trimEnd(line.substring(0, equals));
        const value = trimStart(line.substring(equals + 1));
        const v = valueForOxfmt(key, value);
        if (v !== null) file.sections[file.sections.length - 1].set(key, v);
      }
    }
  }
  return file;
}

// The `.editorconfig` in `directory`, if there is one, for oxfmt.
export function readAsOxfmt(directory: string): EditorConfigOx | null {
  const text = fsx.readText(paths.join(directory, ".editorconfig"));
  if (text === null) return null;
  return parseAsOxfmt(directory, text);
}

export class OxFound {
  names: string[] = [];
  values: string[] = [];
  push(name: string, value: string): void {
    this.names.push(name);
    this.values.push(value);
  }
}

// `apply_editorconfig`. `useTabs`: `useTabs` of the configuration of oxfmt, which counts more than `indent_style` (0 unset, 1
// true, 2 false).
function applyAsOxfmt(keys: string[], vals: OxValue[], useTabs: number): OxFound {
  const get = (key: string): OxValue | null => {
    for (let i = 0; i < keys.length; i++) if (keys[i] === key) return vals[i];
    return null;
  };
  const whole = (key: string): number => {
    const v = get(key);
    return v !== null && v.kind === X_WHOLE ? v.whole : -1;
  };
  const is = (key: string, word: string): boolean => {
    const v = get(key);
    return v !== null && v.is(word);
  };
  const oneOf = (key: string, yes: string, no: string): number => (is(key, yes) ? 1 : is(key, no) ? 2 : 0);
  const out = new OxFound();
  // `as u16`, `as u8`
  const printWidth = whole("max_line_length");
  if (printWidth >= 0) out.push("printWidth", String(printWidth % 65536));
  const eol = get("end_of_line");
  if (eol !== null && eol.kind === X_TEXT) out.push("endOfLine", eol.text);
  const ofStyle = oneOf("indent_style", "tab", "space");
  if (ofStyle !== 0) out.push("useTabs", ofStyle === 1 ? "true" : "false");
  const effective = useTabs !== 0 ? useTabs : ofStyle;
  const size = effective === 2 ? whole("indent_size") : -1;
  const width = size >= 0 ? size : whole("tab_width");
  if (width >= 0) out.push("tabWidth", String(width % 256));
  const finalNewline = oneOf("insert_final_newline", "true", "false");
  if (finalNewline !== 0) out.push("insertFinalNewline", finalNewline === 1 ? "true" : "false");
  const singleQuote = oneOf("quote_type", "single", "double");
  if (singleQuote !== 0) out.push("singleQuote", singleQuote === 1 ? "true" : "false");
  return out;
}

// The options of oxfmt that `file` has for the file at `path`: `EditorConfig::resolve`.
export function optionsForOxfmt(file: EditorConfigOx, path: string, useTabs: number): OxFound {
  const inside = paths.inside(file.directory, path);
  const relative = inside === null ? path : inside;
  const keys: string[] = [];
  const vals: OxValue[] = [];
  for (let s = 0; s < file.sections.length; s++) {
    const section = file.sections[s];
    if (section.glob === null || !section.glob.matches(relative)) continue;
    for (let k = 0; k < section.keys.length; k++) {
      const key = section.keys[k];
      const value = section.values[k];
      if (value.kind !== X_NOTHING) {
        for (let q = 0; q < keys.length; q++) {
          if (keys[q] === key) {
            keys.splice(q, 1);
            vals.splice(q, 1);
            break;
          }
        }
      }
      if (value.kind !== X_NOTHING && value.kind !== X_UNSET) {
        keys.push(key);
        vals.push(value);
      }
    }
  }
  return applyAsOxfmt(keys, vals, useTabs);
}

// Those of the first `[*]`, which oxfmt looks at before it looks at any file.
export function optionsOfRootForOxfmt(file: EditorConfigOx, useTabs: number): OxFound {
  let root: OxSection | null = null;
  for (let s = 0; s < file.sections.length; s++) {
    if (file.sections[s].name === "*") {
      root = file.sections[s];
      break;
    }
  }
  const keys: string[] = [];
  const vals: OxValue[] = [];
  if (root !== null) {
    for (let k = 0; k < root.keys.length; k++) {
      // the first property with a key is the one that is found
      keys.push(root.keys[k]);
      vals.push(root.values[k]);
    }
  }
  return applyAsOxfmt(keys, vals, useTabs);
}
