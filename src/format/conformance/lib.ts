// Port of vendor/bun/src/format/conformance/lib.rs: what the runners of Prettier's and oxfmt's tests share.
//
// All text here is a "byte string": a JS string whose every UTF-16 unit is one byte of the file (latin1). The
// fixtures are about byte order marks, line endings and malformed text, so nothing is decoded; with this form the
// byte-wise operations of the Rust code (`index_of`, `split`, `strip_prefix`, ...) are the string methods, and a text
// goes back to bytes with `toBytes`. Names that are printed are byte strings too, and `outputLine` writes them as bytes.
//
// The formatter under test is called through `runFormat` (see `formatMode`): the dispatcher of `dispatch.ts` by
// default.
import * as fs from "node:fs";
import { FormatOptions } from "../options.ts";
import { formatForTests, FT_NOT_PORTED, FT_OK, FT_SYNTAX } from "./dispatch.ts";

// ---------------------------------------------------------------------------------------------- bytes and strings

export function toBytes(s: string): Uint8Array {
  return Buffer.from(s, "latin1");
}

export function fromBytes(b: Uint8Array): string {
  return Buffer.from(b).toString("latin1");
}

function isTrimmedByte(c: number, set: string): boolean {
  return set.indexOf(String.fromCharCode(c)) >= 0;
}

// `strings::trim(s, set)`: the bytes in `set` are taken off both ends.
export function trimSet(s: string, set: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isTrimmedByte(s.charCodeAt(start), set)) start = start + 1;
  while (end > start && isTrimmedByte(s.charCodeAt(end - 1), set)) end = end - 1;
  return s.substring(start, end);
}

// Rust's `u8::is_ascii_whitespace`: space, \t, \n, \x0C, \r.
function isAsciiWhitespace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

export function trimAsciiStart(s: string): string {
  let start = 0;
  while (start < s.length && isAsciiWhitespace(s.charCodeAt(start))) start = start + 1;
  return s.substring(start);
}

export function trimAscii(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isAsciiWhitespace(s.charCodeAt(start))) start = start + 1;
  while (end > start && isAsciiWhitespace(s.charCodeAt(end - 1))) end = end - 1;
  return s.substring(start, end);
}

// `str::from_utf8(..).is_ok()` on a byte string.
export function isValidUtf8(s: string): boolean {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      i = i + 1;
      continue;
    }
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c === 0xe0) {
      need = 2;
      lo = 0xa0;
    } else if (c >= 0xe1 && c <= 0xec) need = 2;
    else if (c === 0xed) {
      need = 2;
      hi = 0x9f;
    } else if (c >= 0xee && c <= 0xef) need = 2;
    else if (c === 0xf0) {
      need = 3;
      lo = 0x90;
    } else if (c >= 0xf1 && c <= 0xf3) need = 3;
    else if (c === 0xf4) {
      need = 3;
      hi = 0x8f;
    } else return false;
    if (i + need >= n) return false;
    const c1 = s.charCodeAt(i + 1);
    if (c1 < lo || c1 > hi) return false;
    for (let k = 2; k <= need; k++) {
      const ck = s.charCodeAt(i + k);
      if (ck < 0x80 || ck > 0xbf) return false;
    }
    i = i + need + 1;
  }
  return true;
}

// `strings::element_length_utf8_into_utf16`: how many UTF-16 code units the UTF-8 text is.
export function utf16Length(s: string): number {
  let units = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c & 0xc0) !== 0x80) units = units + 1;
    if (c >= 0xf0) units = units + 1;
  }
  return units;
}

// `strings::replace_owned`: every `from` is `to`.
export function replaceAll(s: string, from: string, to: string): string {
  if (s.indexOf(from) < 0) return s;
  return s.split(from).join(to);
}

// The last `suffix` is taken off, if `s` ends with it.
export function stripSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.substring(0, s.length - suffix.length) : s;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The keys of a map, in the order of their bytes (what a `BTreeMap` iterates in).
export function sortedKeys(keys: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < keys.length; i++) out.push(keys[i]);
  out.sort(compareStrings);
  return out;
}

// `s` as a non-negative decimal number: -1 if it is not one (`str::parse::<usize>` accepts digits, and a `+`).
export function parseCount(s: string): number {
  let i = 0;
  if (s.length > 0 && s.charCodeAt(0) === 43) i = 1;
  if (i >= s.length) return -1;
  let n = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return -1;
    n = n * 10 + (c - 48);
  }
  return n;
}

// ---------------------------------------------------------------------------------------------- output

let pending = "";

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    try {
      off = off + fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EAGAIN") return;
    }
  }
}

export function flushOutput(): void {
  if (pending.length === 0) return;
  const text = pending;
  pending = "";
  writeAll(1, Buffer.from(text, "latin1"));
}

// `println!`, which nothing in Bun uses. `line` is a byte string.
export function outputLine(line: string): void {
  pending = pending + line + "\n";
  if (pending.length >= 4096) flushOutput();
}

export function readFile(path: string): string | null {
  try {
    return fs.readFileSync(path).toString("latin1");
  } catch (e) {
    return null;
  }
}

// Its directory is created if there is none. It is only written to be looked at.
export function writeFile(path: string, contents: string): void {
  const slash = path.lastIndexOf("/");
  try {
    if (slash > 0) fs.mkdirSync(path.substring(0, slash), { recursive: true });
    fs.writeFileSync(path, Buffer.from(contents, "latin1"));
  } catch (e) {
    // Only for looking at.
  }
}

// ---------------------------------------------------------------------------------------------- the bundle

// Many small files in one, as `test/cli/format/bundle.ts` writes it, decompressed. One file after the other:
// `=== /<path> <length in bytes>\n`, the bytes, `\n`.
export class Bundle {
  files: Map<string, string> = new Map<string, string>();
  // In the order of the bytes of the paths; made by `finish`.
  sorted: string[] = [];

  insert(path: string, contents: string): void {
    this.files.set(path, contents);
  }

  finish(): void {
    const keys: string[] = [];
    for (const k of this.files.keys()) keys.push(k);
    this.sorted = sortedKeys(keys);
  }

  // null: there is no such file.
  read(path: string): string | null {
    const v = this.files.get(path);
    return v === undefined ? null : v;
  }

  // "" for a file that is not there (`unwrap_or_default`).
  readOrEmpty(path: string): string {
    const v = this.files.get(path);
    return v === undefined ? "" : v;
  }
}

// null if `bytes` is malformed.
export function parseBundle(bytes: string): Bundle | null {
  const bundle = new Bundle();
  const n = bytes.length;
  let at = 0;
  while (at < n) {
    if (!bytes.startsWith("=== /", at)) return null;
    const lineEnd = bytes.indexOf("\n", at + 5);
    if (lineEnd < 0) return null;
    const header = bytes.substring(at + 5, lineEnd);
    const space = header.lastIndexOf(" ");
    if (space < 0) return null;
    const path = header.substring(0, space);
    const length = parseCount(header.substring(space + 1));
    if (length < 0) return null;
    const start = lineEnd + 1;
    if (start + length > n) return null;
    bundle.insert(path, bytes.substring(start, start + length));
    at = start + length;
    if (at >= n || bytes.charCodeAt(at) !== 10) return null;
    at = at + 1;
  }
  bundle.finish();
  return bundle;
}

// ---------------------------------------------------------------------------------------------- the flags

// What is on the command line after the path of the bundle.
export class Flags {
  // `--filter=text`: only the cases whose path contains the text.
  hasFilter: boolean = false;
  filter: string = "";
  // `--languages=js,jsx`: only these directories of Prettier's tests.
  languages: string = "js,jsx,typescript,flow,json,css,less,scss,graphql,yaml,markdown,mdx,handlebars,html,vue,angular,lwc,mjml,misc";
  // `--report=directory`: the expected and the actual output of each failure are written there.
  hasReport: boolean = false;
  report: string = "";
  // `--table`: the numbers of each directory.
  table: boolean = false;
  // `--every=n --first=i`: every n-th case, from the i-th.
  every: number = 1;
  first: number = 0;

  wants(id: string): boolean {
    return !this.hasFilter || id.includes(this.filter);
  }

  // `name`: of the case, with its options.
  writeReport(name: string, expected: string, actual: string, input: string): void {
    if (!this.hasReport) return;
    let safe = "";
    for (let i = 0; i < name.length; i++) {
      const c = name.charAt(i);
      safe = safe + ("/ :#=\"{},".indexOf(c) >= 0 ? "_" : c);
    }
    writeFile(this.report + "/" + safe + ".expected", expected);
    writeFile(this.report + "/" + safe + ".actual", actual);
    writeFile(this.report + "/" + safe + ".input", input);
  }
}

// The value of the first `--<name>=<value>` in `args`; null if there is none.
function flagValue(args: string[], name: string): string | null {
  const prefix = "--" + name + "=";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith(prefix)) return a.substring(prefix.length);
  }
  return null;
}

export function parseFlags(args: string[]): Flags {
  const f = new Flags();
  const filter = flagValue(args, "filter");
  if (filter !== null) {
    f.hasFilter = true;
    f.filter = filter;
  }
  const languages = flagValue(args, "languages");
  if (languages !== null) f.languages = languages;
  const report = flagValue(args, "report");
  if (report !== null) {
    f.hasReport = true;
    f.report = report;
  }
  for (let i = 0; i < args.length; i++) if (args[i] === "--table") f.table = true;
  const every = flagValue(args, "every");
  if (every !== null) {
    const n = parseCount(every);
    if (n >= 0) f.every = n;
  }
  if (f.every < 1) f.every = 1;
  const first = flagValue(args, "first");
  if (first !== null) {
    const n = parseCount(first);
    if (n >= 0) f.first = n;
  }
  return f;
}

// ---------------------------------------------------------------------------------------------- counts

export class Count {
  passed: number = 0;
  total: number = 0;

  add(passed: boolean): void {
    if (passed) this.passed = this.passed + 1;
    this.total = this.total + 1;
  }

  merge(other: Count): void {
    this.passed = this.passed + other.passed;
    this.total = this.total + other.total;
  }

  toString(): string {
    return this.passed + "/" + this.total;
  }
}

// `{:.2}` of a percentage.
export function percent(c: Count): string {
  const total = c.total < 1 ? 1 : c.total;
  return ((100 * c.passed) / total).toFixed(2);
}

// ---------------------------------------------------------------------------------------------- the formatter under test

// What the formatter says about a file: how it ended, the text, where the cursor ended up (UTF-16 units; -1: nowhere).
export class FormatResult {
  status: number;
  // A byte string.
  output: string;
  cursor: number;
  constructor(status: number, output: string, cursor: number) {
    this.status = status;
    this.output = output;
    this.cursor = cursor;
  }
}

// Which formatter `runFormat` calls.
export const MODE_DISPATCH = 0;
// Every text is its own formatted text (a check of the runner: its denominators are Bun's).
export const MODE_IDENTITY = 1;
// The formatted text is the one that the snapshot says (a check of the runner: its numbers are Bun's, but for what
// the mock cannot do). The runners tell it the case with `setMock`.
export const MODE_MOCK = 2;
export let formatMode: number = MODE_DISPATCH;

export function setFormatMode(mode: number): void {
  formatMode = mode;
}

// The case of MODE_MOCK: the input as the formatter gets it, and what the snapshot says it comes to.
let mockInput = "";
let mockOutput = "";
let mockHasOutput = false;

export function setMock(input: string, output: string, hasOutput: boolean): void {
  mockInput = input;
  mockOutput = output;
  mockHasOutput = hasOutput;
}

// Formats the text as the file at the path (`Format` of lib.rs). `path`: the name of the file, for what the name decides.
export function runFormat(path: string, text: string, options: FormatOptions): FormatResult {
  if (formatMode === MODE_IDENTITY) return new FormatResult(FT_OK, text, -1);
  if (formatMode === MODE_MOCK) return mockFormat(text, options);
  const r = formatForTests(path, toBytes(text), options);
  return new FormatResult(r.status, r.status === FT_OK ? fromBytes(r.output) : "", r.cursor);
}

// What a perfect formatter does, as far as the checks of the runner can tell: the line endings and the byte order
// mark of its input are not part of the text, and its output is stable. It cannot place a cursor.
function mockFormat(text: string, options: FormatOptions): FormatResult {
  let bom = "";
  let body = text;
  if (body.startsWith("\xEF\xBB\xBF")) {
    bom = "\xEF\xBB\xBF";
    body = body.substring(3);
  }
  const lf = replaceAll(replaceAll(body, "\r\n", "\n"), "\r", "\n");
  if (!mockHasOutput) return new FormatResult(FT_SYNTAX, "", -1);
  let input = mockInput;
  if (input.startsWith("\xEF\xBB\xBF")) input = input.substring(3);
  const inputLf = replaceAll(replaceAll(input, "\r\n", "\n"), "\r", "\n");
  const outputLf = replaceAll(replaceAll(mockOutput, "\r\n", "\n"), "\r", "\n");
  let out = "";
  if (lf === inputLf || lf === outputLf) out = mockOutput;
  else return new FormatResult(FT_SYNTAX, "", -1);
  // An output that has line breaks of its own: `endOfLine: crlf|cr`. The snapshot shows them as <CRLF>.
  if (options.lineEnding === 3 && text.indexOf("\r") >= 0) {
    out = replaceAll(out, "\n", text.indexOf("\r\n") >= 0 ? "\r\n" : "\r");
  }
  return new FormatResult(FT_OK, bom + out, -1);
}

// The result of `format_for_tests`, as `Failure` in lib.rs: a syntax error, or a bug.
export function isSyntaxError(r: FormatResult): boolean {
  return r.status === FT_SYNTAX;
}

export function isNotPorted(r: FormatResult): boolean {
  return r.status === FT_NOT_PORTED;
}

// The text of an output that is not one: `<SyntaxError>` or `<the formatter failed>`.
export function failureText(r: FormatResult): string {
  return r.status === FT_SYNTAX ? "<SyntaxError>" : "<the formatter failed>";
}

// Puts `<|>` where the cursor is, the way Prettier's snapshots show it.
export function showCursor(text: string, cursor: number): string {
  if (cursor < 0) return text;
  let units = 0;
  let found = text.length;
  for (let at = 0; at < text.length; at++) {
    const c = text.charCodeAt(at);
    const isStart = (c & 0xc0) !== 0x80;
    if (isStart && units >= cursor) {
      found = at;
      break;
    }
    if (isStart) units = units + 1;
    if (c >= 0xf0) units = units + 1;
  }
  return text.substring(0, found) + "<|>" + text.substring(found);
}
