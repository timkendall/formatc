// One ignore file (.gitignore, .prettierignore) or an array of lines: port of vendor/bun/src/lint/ignore.rs for the
// reading of the npm package `ignore` 5.3.2 (which Prettier uses): braces are literal, case is folded.
// The last matching line wins. Lines the package reads in a way that a glob cannot express use its own regex.
import { classEnd, Glob } from "./glob.ts";

export const V_UNMENTIONED = 0;
export const V_IGNORED = 1;
export const V_KEPT = 2;

class Rule {
  glob: Glob | null;
  // The line without its `!`, for the package's regex.
  line: string;
  hasLine: boolean;
  isOnlyOfPackage: boolean;
  isNegated: boolean;
  isForDirectories: boolean;
  constructor() {
    this.glob = null;
    this.line = "";
    this.hasLine = false;
    this.isOnlyOfPackage = false;
    this.isNegated = false;
    this.isForDirectories = false;
  }
}

class Line {
  pattern: string;
  writtenAt: number;
  isAnchored: boolean;
  isNegated: boolean;
  isForDirectories: boolean;
  constructor(pattern: string, writtenAt: number, isAnchored: boolean, isNegated: boolean, isForDirectories: boolean) {
    this.pattern = pattern;
    this.writtenAt = writtenAt;
    this.isAnchored = isAnchored;
    this.isNegated = isNegated;
    this.isForDirectories = isForDirectories;
  }
}

function trimAsciiEnd(s: string): string {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) e = e - 1;
    else break;
  }
  return s.substring(0, e);
}

function isJsWhitespace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0xfeff || c === 0x2028 || c === 0x2029 || (c >= 0x2000 && c <= 0x200a) || c === 0x1680 || c === 0x202f || c === 0x205f || c === 0x3000;
}

function trimJs(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isJsWhitespace(s.charCodeAt(a))) a = a + 1;
  while (b > a && isJsWhitespace(s.charCodeAt(b - 1))) b = b - 1;
  return s.substring(a, b);
}

// `read_plain`: the line as git and the package read it. null for a comment or a blank line.
function readPlain(line: string, ignoresCase: boolean): Line | null {
  let written = trimAsciiEnd(line);
  if (written.startsWith("#")) return null;
  const isNegated = written.startsWith("!");
  if (isNegated) written = written.substring(1);
  const isForDirectories = written.length > 1 && written.endsWith("/");
  if (isForDirectories) written = written.substring(0, written.length - 1);
  let isAnchored = written.indexOf("/") >= 0;
  if (written.startsWith("/")) written = written.substring(1);
  while (written.startsWith("**/")) {
    written = written.substring(3);
    isAnchored = false;
  }
  if (written.length === 0) return null;
  let pattern = "";
  if (!isAnchored) pattern = "**/";
  const writtenAt = pattern.length;
  for (let at = 0; at < written.length; at++) {
    const c = written.charCodeAt(at);
    if (c === 123 || c === 125 || c === 40) pattern += "\\" + written.charAt(at);
    else if (c === 33 && at === 0 && isAnchored) pattern += "\\!";
    else pattern += written.charAt(at);
  }
  if (ignoresCase) pattern = pattern.toLowerCase();
  return new Line(pattern, writtenAt, isAnchored, isNegated, isForDirectories);
}


// Appends `c` to a class, escaped if it means something there.
function pushClassMember(cls: string, c: string): string {
  if (c === "\\" || c === "]" || c === "[" || c === "-" || c === "^" || c === "!") return cls + "\\" + c;
  return cls + c;
}

// globset's `parse_class` for the class that starts at `open`. It has no escapes, and a `]` or `-` right after the `[` is a
// member. Returns the class in the dialect of `Glob` and the index after the `]`: [class, end]. end -1: the class isn't
// closed; end -2: it has a reversed range like `z-a`.
export let classEndOut = 0;

export function fromGlobsetClass(written: string, open: number, hasLiteralSeparator: boolean): string {
  let cls = "[";
  let at = open + 1;
  const c0 = written.charCodeAt(at);
  if (c0 === 33 || c0 === 94) {
    cls += "!";
    // With `literal_separator`, a class never matches `/`.
    if (hasLiteralSeparator) cls += "/";
    at = at + 1;
  }
  let isFirst = true;
  let isInRange = false;
  let last = "";
  while (true) {
    if (at >= written.length) {
      classEndOut = -1;
      return "";
    }
    // one character (a surrogate pair is one)
    const cp = written.codePointAt(at) as number;
    const c = String.fromCodePoint(cp);
    at = at + c.length;
    if (c === "]" && !isFirst) break;
    if (c === "-" && !isFirst && !isInRange) {
      isInRange = true;
    } else if (isInRange) {
      if (c < last) {
        classEndOut = -2;
        return "";
      }
      cls += "-";
      cls = pushClassMember(cls, c);
      isInRange = false;
    } else {
      cls = pushClassMember(cls, c);
      last = c;
    }
    isFirst = false;
  }
  if (isInRange) cls += "\\-";
  cls += "]";
  classEndOut = at;
  return cls;
}

// globset drops empty alternatives, so `{a,}` is `a`.
export function withoutEmptyAlternatives(pattern: string): string {
  let out = "";
  let at = 0;
  let depth = 0;
  // Length of `out` right after the latest `{` or `,` of a group.
  let alternativeStart = -1;
  while (at < pattern.length) {
    const byte = pattern.charCodeAt(at);
    let len = 1;
    if (byte === 92) len = 2;
    else if (byte === 91) {
      const e = classEnd(pattern, at);
      len = e >= 0 ? e - at : 1;
    }
    if (byte === 123) {
      depth = depth + 1;
      out += "{";
      alternativeStart = out.length;
    } else if (byte === 44 && depth > 0) {
      if (alternativeStart !== out.length) out += ",";
      alternativeStart = out.length;
    } else if (byte === 125 && depth > 0) {
      depth = depth - 1;
      if (alternativeStart === out.length && out.endsWith(",")) out = out.substring(0, out.length - 1);
      out += "}";
    } else {
      out += pattern.substring(at, Math.min(at + len, pattern.length));
    }
    at = at + len;
  }
  return out;
}

function trimUnicodeEnd(s: string): string {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (isJsWhitespace(c) || c === 0x85 || c === 0x180e) e = e - 1;
    else break;
  }
  return s.substring(0, e);
}

// Parses a line like `GitignoreBuilder::add_line` of the `ignore` crate 0.4 and converts its globset pattern. null for a
// comment or a blank line. `refused` is set for a line the crate rejects: an unbalanced group, a trailing `\` or a reversed
// range like `z-a`.
let readRefused = false;

function readForCrate(line: string, ignoresCase: boolean): Line | null {
  readRefused = false;
  if (line.startsWith("#")) return null;
  let written = line.endsWith("\\ ") ? line : trimUnicodeEnd(line);
  if (written.length === 0) return null;
  let isNegated = false;
  let isAnchored = false;
  if (written.startsWith("\\!") || written.startsWith("\\#")) {
    written = written.substring(1);
  } else {
    if (written.startsWith("!")) {
      written = written.substring(1);
      isNegated = true;
    }
    if (written.startsWith("/")) {
      written = written.substring(1);
      isAnchored = true;
    }
  }
  let isForDirectories = false;
  if (written.endsWith("/")) {
    isForDirectories = true;
    written = written.substring(0, written.length - 1);
    // A `\` that escapes the trailing `/` goes with it.
    if (written.endsWith("\\")) written = written.substring(0, written.length - 1);
  }
  if (written.indexOf("/") >= 0) isAnchored = true;
  while (written.startsWith("**/")) {
    written = written.substring(3);
    isAnchored = false;
  }
  // Nothing is left of a line like `!` or `**/`. It matches everything.
  if (written.length === 0 && !isAnchored) written = "**";
  let pattern = "";
  if (!isAnchored && written !== "**") pattern = "**/";
  const writtenAt = pattern.length;
  let at = 0;
  let depth = 0;
  let hasUnclosedClass = false;
  while (at < written.length) {
    const byte = written.charCodeAt(at);
    at = at + 1;
    if (byte === 92) {
      if (at >= written.length) {
        readRefused = true;
        return null;
      }
      const escaped = written.charAt(at);
      at = at + 1;
      // Bun reads `\n` and friends as control characters. Here an escaped letter is just the letter.
      const ec = escaped.charCodeAt(0);
      if (!((ec >= 48 && ec <= 57) || (ec >= 65 && ec <= 90) || (ec >= 97 && ec <= 122))) pattern += "\\";
      pattern += escaped;
    } else if (byte === 91 && !hasUnclosedClass) {
      const cls = fromGlobsetClass(written, at - 1, true);
      if (classEndOut === -2) {
        readRefused = true;
        return null;
      }
      if (classEndOut === -1) {
        hasUnclosedClass = true;
        pattern += "\\[";
      } else {
        pattern += cls;
        at = classEndOut;
      }
    } else if (byte === 91 || byte === 40) {
      pattern += "\\" + String.fromCharCode(byte);
    } else if (byte === 123) {
      depth = depth + 1;
      pattern += "{";
    } else if (byte === 125) {
      if (depth === 0) {
        readRefused = true;
        return null;
      }
      depth = depth - 1;
      pattern += "}";
    } else if (byte === 46 && written.charCodeAt(at) === 46) {
      // `{1..3}` is not a sequence.
      pattern += "\\.";
    } else if (byte === 33 && at === 1) {
      pattern += "\\!";
    } else {
      pattern += String.fromCharCode(byte);
    }
  }
  if (depth > 0) {
    readRefused = true;
    return null;
  }
  pattern = withoutEmptyAlternatives(pattern);
  // `a/**` matches everything inside `a` but not `a` itself.
  if (pattern.endsWith("/**")) pattern += "/*";
  if (ignoresCase) pattern = pattern.toLowerCase();
  return new Line(pattern, writtenAt, isAnchored, isNegated, isForDirectories);
}

function isAsciiAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Whether `readPlain` and the package agree on `line` (without its `!`).
function isReadTheSame(line: string): boolean {
  if (line.endsWith("/**/")) return false;
  const parts = line.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== "**" && parts[i].indexOf("**") >= 0) return false;
  }
  let rest = line;
  while (true) {
    const open = rest.indexOf("[");
    if (open < 0) break;
    const close = rest.indexOf("]", open + 1);
    if (close < 0) return false;
    const inside = rest.substring(open + 1, close);
    const len = inside.length;
    if (len === 0) return false;
    const isBound = (at: number): boolean => at >= 0 && at < len && isAsciiAlnum(inside.charCodeAt(at));
    for (let at = 0; at < len; at++) {
      if (isBound(at)) continue;
      if (inside.charCodeAt(at) === 45 && at > 0 && isBound(at - 1) && isBound(at + 1) && inside.charCodeAt(at - 1) <= inside.charCodeAt(at + 1)) continue;
      return false;
    }
    rest = rest.substring(close + 1);
  }
  // ASCII, no `\`, no trailing white space
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c >= 128 || c === 92) return false;
  }
  if (trimAsciiEnd(line).length !== line.length) return false;
  return true;
}

function even(s: string): number {
  return s.length - (s.length % 2);
}

// The package's `makeRegex(pattern, ignoreCase)`. null where the package throws.
function regexOfPackage(pattern: string, ignoresCase: boolean): RegExp | null {
  let source = pattern;
  const origLen = pattern.length;
  const hasSlashNotAtEnd = pattern.substring(0, origLen > 0 ? origLen - 1 : 0).indexOf("/") >= 0;
  // 0 BOM
  source = source.replace(/^﻿/, "");
  // 1 trailing spaces
  source = source.replace(/((?:\\\\)*?)(\\?\s+)$/, (_m: string, m1: string, m2: string) => m1 + (m2.charCodeAt(0) === 92 ? " " : ""));
  // 2 `\ ` -> ` `
  source = source.replace(/(\\+?)\s/g, (_m: string, m1: string) => m1.substring(0, even(m1)) + " ");
  // 3 metacharacters
  source = source.replace(/[\\$.|*+(){^]/g, (m: string) => "\\" + m);
  // 4 `?`
  source = source.replace(/(?!\\)\?/g, "[^/]");
  // 5 leading slash
  source = source.replace(/^\//, "^");
  // 6 slashes
  source = source.replace(/\//g, "\\/");
  // 7 leading `**/`
  source = source.replace(/^\^*\\\*\\\*\\\//, "^(?:.*\\/)?");
  // 8 starting
  source = source.replace(/^(?=[^^])/, hasSlashNotAtEnd ? "^" : "(?:^|\\/)");
  // 9 two globstars
  {
    const len = source.length;
    source = source.replace(/\\\/\\\*\\\*(?=\\\/|$)/g, (m: string, offset: number) => (offset + m.length < len ? "(?:\\/[^\\/]+)*" : "\\/.+"));
  }
  // 10 normal intermediate wildcards
  source = source.replace(/(^|[^\\]+)(\\\*)+(?=.+)/g, (_m: string, p1: string) => p1 + "[^\\/]*");
  // 11, 12 escapes
  source = source.replace(/\\\\\\(?=[$.|*+(){^])/g, "\\");
  source = source.replace(/\\\\/g, "\\");
  // 13 classes
  source = source.replace(/(\\)?\[([^\]/]*?)(\\*)($|\])/g, (_m: string, lead: string, range: string, endEscape: string, close: string) => {
    if (lead !== undefined && lead !== "") {
      return "\\[" + range + endEscape.substring(0, even(endEscape)) + close;
    }
    if (close === "]" && endEscape.length % 2 === 0) {
      const sanitized = range.replace(/([0-z])-([0-z])/g, (mm: string, a: string, b: string) => (a <= b ? mm : ""));
      return "[" + sanitized + endEscape + "]";
    }
    return "[]";
  });
  // 14 end of pattern
  source = source.replace(/(?:[^*])$/, (m: string) => (m === "/" ? m + "$" : m + "(?=$|\\/$)"));
  // 15 trailing star
  source = source.replace(/(\^|\\\/)?\\\*$/, (_m: string, p1: string) => (p1 !== undefined && p1 !== "" ? p1 + "[^/]+" : "[^/]*") + "(?=$|\\/$)");
  try {
    return new RegExp(source, ignoresCase ? "i" : "");
  } catch (e) {
    return null;
  }
}

// The regex of a rule that only the package reads, made on first use (a thread keeps its own).
const regexes = new Map<Rule, RegExp | null>();

export class IgnoreRules {
  rules: Rule[];
  byName: Map<string, number[]>;
  byPath: Map<string, number[]>;
  longestPath: number;
  byExtension: Map<string, number[]>;
  byFirstName: Map<string, number[]>;
  atTop: number[];
  others: number[];
  hasExceptions: boolean;
  hasRulesOfPackage: boolean;
  ignoresCase: boolean;
  // `{a,b}` means `a` or `b`, as in the `ignore` crate that oxlint and oxfmt use (and the npm package `ignore` does not).
  hasBraces: boolean;
  // The lines the crate rejected.
  refused: string[];

  constructor() {
    this.rules = [];
    this.byName = new Map<string, number[]>();
    this.byPath = new Map<string, number[]>();
    this.longestPath = 0;
    this.byExtension = new Map<string, number[]>();
    this.byFirstName = new Map<string, number[]>();
    this.atTop = [];
    this.others = [];
    this.hasExceptions = false;
    this.hasRulesOfPackage = false;
    this.ignoresCase = true;
    this.hasBraces = false;
    this.refused = [];
  }

  isEmpty(): boolean {
    return this.rules.length === 0;
  }

  static fromText(text: string, forOxc: boolean = false): IgnoreRules {
    const rules = new IgnoreRules();
    rules.setOxc(forOxc);
    if (text.charCodeAt(0) === 0xfeff) text = text.substring(1);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (line.endsWith("\r")) line = line.substring(0, line.length - 1);
      rules.addLine(line);
    }
    return rules;
  }

  static fromLines(lines: string[], forOxc: boolean = false): IgnoreRules {
    const rules = new IgnoreRules();
    rules.setOxc(forOxc);
    for (let i = 0; i < lines.length; i++) rules.addLine(lines[i]);
    return rules;
  }

  private setOxc(forOxc: boolean): void {
    this.hasBraces = forOxc;
    this.ignoresCase = !forOxc;
  }

  private addLine(line: string): void {
    // `checkPattern`, `createRule`
    let body = line.startsWith("!") ? line.substring(1) : line;
    if (body.length >= 2 && body.charCodeAt(0) === 92 && (body.charCodeAt(1) === 33 || body.charCodeAt(1) === 35)) body = body.substring(1);
    let same = this.hasBraces || isReadTheSame(body);
    if (same && !this.hasBraces) {
      // a line made only of `/` is about an empty segment
      const t = trimAsciiEnd(body);
      let allSlash = true;
      for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) !== 47) allSlash = false;
      if (allSlash) same = false;
    }
    if (!same) {
      const saysNothing = trimJs(line).length === 0 || line.startsWith("#") || (line.endsWith("\\") && !line.endsWith("\\\\"));
      if (!saysNothing) {
        this.others.push(this.rules.length);
        this.hasRulesOfPackage = true;
        if (line.startsWith("!")) this.hasExceptions = true;
        const r = new Rule();
        r.line = body;
        r.hasLine = true;
        r.isOnlyOfPackage = true;
        r.isNegated = line.startsWith("!");
        this.rules.push(r);
      }
      return;
    }
    let read: Line | null;
    if (this.hasBraces) {
      read = readForCrate(line, this.ignoresCase);
      if (readRefused) {
        this.refused.push(line);
        return;
      }
    } else read = readPlain(line, this.ignoresCase);
    if (read === null) return;
    const at = this.rules.length;
    const written = read.pattern.substring(read.writtenAt);
    const isAnchored = read.isAnchored;
    const firstSlash = written.indexOf("/");
    let table: Map<string, number[]> | null = null;
    let key = "";
    let foundByKey = false;
    if (!isAnchored && firstSlash < 0 && isLiteral(written)) {
      table = this.byName;
      key = written;
      foundByKey = true;
    } else if (!isAnchored && written.startsWith("*.") && isLiteral(written.substring(2)) && written.length > 2 && written.substring(2).indexOf(".") < 0 && written.substring(2).indexOf("/") < 0) {
      table = this.byExtension;
      key = written.substring(2);
      foundByKey = true;
    } else if (isAnchored && isLiteral(written)) {
      if (written.length > this.longestPath) this.longestPath = written.length;
      table = this.byPath;
      key = written;
      foundByKey = true;
    }
    if (table === null && isAnchored && firstSlash >= 0) {
      const first = written.substring(0, firstSlash);
      if (isLiteral(first)) {
        table = this.byFirstName;
        key = first;
      }
    }
    if (table !== null) {
      let list = table.get(key);
      if (list === undefined) {
        list = [];
        table.set(key, list);
      }
      list.push(at);
    } else if (isAnchored && firstSlash < 0 && written.indexOf("**") < 0) {
      this.atTop.push(at);
    } else {
      this.others.push(at);
    }
    if (read.isNegated) this.hasExceptions = true;
    const r = new Rule();
    if (!foundByKey || read.isNegated) r.glob = new Glob(read.pattern);
    r.line = body;
    r.hasLine = true;
    r.isNegated = read.isNegated;
    r.isForDirectories = read.isForDirectories;
    this.rules.push(r);
  }

  private packageSays(rule: Rule, text: string): boolean {
    if (!rule.hasLine) return false;
    let re = regexes.get(rule);
    if (re === undefined) {
      re = regexOfPackage(rule.line, this.ignoresCase);
      regexes.set(rule, re);
    }
    if (re === null) return false;
    return re.test(text);
  }

  // The last of `found` that matches and comes after `best`, otherwise `best`.
  private look(found: number[] | undefined, isKnown: boolean, best: number, path: string, text: string, isDirectory: boolean): number {
    if (found === undefined) return best;
    for (let i = found.length - 1; i >= 0; i--) {
      const at = found[i];
      if (at <= best) break;
      const rule = this.rules[at];
      if (!isDirectory && rule.isForDirectories) continue;
      if (isKnown) return at;
      let hit: boolean;
      if (rule.isOnlyOfPackage) hit = this.packageSays(rule, text);
      else hit = rule.glob === null ? true : rule.glob.matches(path);
      if (hit) return at;
    }
    return best;
  }

  // The last matching rule, or -1.
  private lastMatch(path: string, isDirectory: boolean): number {
    let text = "";
    const hasEmptyName = !this.hasBraces && (path.length === 0 || path.charCodeAt(0) === 47 || path.charCodeAt(path.length - 1) === 47 || path.indexOf("//") >= 0);
    if (hasEmptyName || this.hasRulesOfPackage) text = isDirectory ? path + "/" : path;
    if (hasEmptyName) {
      for (let i = this.rules.length - 1; i >= 0; i--) {
        if (this.packageSays(this.rules[i], text)) return i;
      }
      return -1;
    }
    if (this.ignoresCase) {
      const lower = path.toLowerCase();
      if (lower !== path) {
        path = lower;
        if (this.hasRulesOfPackage) {
          // the package's regex is case-insensitive itself: keep the original text
        }
      }
    }
    const slash = path.lastIndexOf("/");
    const name = slash < 0 ? path : path.substring(slash + 1);
    const dot = name.lastIndexOf(".");
    let best = -1;
    best = this.look(this.byName.size === 0 ? undefined : this.byName.get(name), true, best, path, text, isDirectory);
    if (path.length <= this.longestPath && this.byPath.size > 0) best = this.look(this.byPath.get(path), true, best, path, text, isDirectory);
    if (dot >= 0 && this.byExtension.size > 0) best = this.look(this.byExtension.get(name.substring(dot + 1)), true, best, path, text, isDirectory);
    if (this.byFirstName.size > 0) {
      const first = slash < 0 ? path : path.substring(0, path.indexOf("/"));
      best = this.look(this.byFirstName.get(first), false, best, path, text, isDirectory);
    }
    if (slash < 0) best = this.look(this.atTop, false, best, path, text, isDirectory);
    best = this.look(this.others, false, best, path, text, isDirectory);
    return best;
  }

  // `path` is relative to the ignore file's directory, without a leading or trailing `/`.
  verdict(path: string, isDirectory: boolean): number {
    const at = this.lastMatch(path, isDirectory);
    if (at < 0) return V_UNMENTIONED;
    return this.rules[at].isNegated ? V_KEPT : V_IGNORED;
  }
}

function isLiteral(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 42 || c === 63 || c === 91 || c === 123 || c === 125 || c === 92 || c === 33) return false;
  }
  return true;
}
