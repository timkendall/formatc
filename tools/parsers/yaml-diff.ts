// Differential test of src/parsers/yaml.ts against Bun's own parser (the oracle).
//
//   bun tools/parsers/yaml-diff.ts [--fuzz=N] [--seed=S] [--no-fmt] [--show=K]
//
// For every file of the corpus (vscode .yml/.yaml, Prettier's tests/format/yaml) and for N mutants of each:
//   - accept/reject: `Bun.YAML.parse` against `yamlParseAsWritten` (the alias errors that need values are expected
//     differences: ours does not resolve aliases);
//   - when both reject: the kind of the error;
//   - when both accept: the shape of the tree against the shape of the value Bun returns;
//   - for what we reject: the place and the kind against `bun fmt` (the line and the column it prints).
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import {
  yamlParseAsWritten, yamlErrorPos, yamlDocCount, yamlDocRoot, yamlNodeKind, yamlNodeCount, yamlItem, yamlPropValue,
  yamlTokenCount, yamlTokenKind, TK_ALIAS, TK_SCALAR, TK_ANCHOR, parseErrorName, tokenKindName,
  PE_UNEXPECTED_TOKEN, PE_UNEXPECTED_CHARACTER, PE_TAB_INDENTATION, PE_INVALID_DIRECTIVE, PE_UNRESOLVED_TAG_HANDLE,
  PE_MULTILINE_IMPLICIT_KEY, PE_MULTIPLE_ANCHORS, PE_MULTIPLE_TAGS, PE_UNEXPECTED_DOCUMENT_START, PE_UNEXPECTED_DOCUMENT_END,
  PE_MULTIPLE_YAML_DIRECTIVES, PE_STACK_OVERFLOW, yamlTokenStart, yamlTokenEnd,
} from "../../src/parsers/yaml.ts";
import { Case, ROOT, Rng, prettierFiles, vscodeFiles } from "./corpus.ts";

const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  for (const a of args) if (a.startsWith("--" + name + "=")) return a.slice(name.length + 3);
  return def;
}
const FUZZ = Number(opt("fuzz", "0"));
const SEED = Number(opt("seed", "1"));
const SHOW = Number(opt("show", "5"));
const NOFMT = args.includes("--no-fmt");
const SOUP = Number(opt("soup", "0"));
const KEEP_NUL = args.includes("--keep-nul");

// ---------------------------------------------------------------------------------------------------------------

// What Bun.YAML.parse says (the text of the SyntaxError without "YAML Parse error: ").
const ALIAS_ERRORS = new Set(["Unresolved alias", "Excessive aliasing", "Cyclic aliases are only supported by Bun.YAML.parse", "Merge key cannot reference an enclosing node"]);

function bunMessageOf(kind: number, pos: number, len: number): string {
  switch (kind) {
    case PE_UNEXPECTED_TOKEN: return "Unexpected token";
    case PE_UNEXPECTED_CHARACTER: return pos >= len ? "Unexpected EOF" : "Unexpected character";
    case PE_TAB_INDENTATION: return "Tab characters cannot be used as indentation";
    case PE_INVALID_DIRECTIVE: return "Invalid directive";
    case PE_UNRESOLVED_TAG_HANDLE: return "Unresolved tag handle";
    case PE_MULTILINE_IMPLICIT_KEY: return "Multiline implicit key";
    case PE_MULTIPLE_ANCHORS: return "Multiple anchors";
    case PE_MULTIPLE_TAGS: return "Multiple tags";
    case PE_UNEXPECTED_DOCUMENT_START: return "Unexpected document start";
    case PE_UNEXPECTED_DOCUMENT_END: return "Unexpected document end";
    case PE_MULTIPLE_YAML_DIRECTIVES: return "Multiple YAML directives";
    default: return "?" + parseErrorName(kind);
  }
}

// bun fmt's message for a `Message` (format/yaml/mod.rs `refusal`)
function fmtGroupOf(kind: number): string {
  switch (kind) {
    case PE_STACK_OVERFLOW: return "NestedTooDeeply";
    case PE_UNEXPECTED_CHARACTER: return "UnexpectedCharacter";
    case PE_TAB_INDENTATION: return "TabAsIndentation";
    case PE_INVALID_DIRECTIVE: case PE_MULTIPLE_YAML_DIRECTIVES: return "InvalidDirective";
    case PE_UNRESOLVED_TAG_HANDLE: return "InvalidTag";
    case PE_MULTILINE_IMPLICIT_KEY: return "KeyOverSeveralLines";
    case PE_MULTIPLE_ANCHORS: case PE_MULTIPLE_TAGS: return "RepeatedProperty";
    case PE_UNEXPECTED_DOCUMENT_START: case PE_UNEXPECTED_DOCUMENT_END: return "UnclosedString";
    default: return "UnexpectedToken";
  }
}

// ---------------------------------------------------------------------------------------------------------------

function shapeMine(id: number): string {
  switch (yamlNodeKind(id)) {
    case 3: {
      const parts: string[] = [];
      for (let i = 0; i < yamlNodeCount(id); i++) parts.push(shapeMine(yamlPropValue(id, i)));
      parts.sort();
      return "{" + parts.join(",") + "}";
    }
    case 4: {
      const parts: string[] = [];
      for (let i = 0; i < yamlNodeCount(id); i++) parts.push(shapeMine(yamlItem(id, i)));
      return "[" + parts.join(",") + "]";
    }
    default:
      return ".";
  }
}

function shapeBun(v: unknown, path: object[] = []): string {
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    if (path.includes(v as object)) return "@";
    path.push(v as object);
    let r: string;
    if (Array.isArray(v)) r = "[" + v.map(x => shapeBun(x, path)).join(",") + "]";
    else {
      const parts = Object.values(v as object).map(x => shapeBun(x, path));
      parts.sort();
      r = "{" + parts.join(",") + "}";
    }
    path.pop();
    return r;
  }
  return ".";
}

// Shapes as trees, to say whether Bun's value is ours with some members of objects taken away (a JS object has one
// member for a key that is there twice, or that is written differently and is the same as a string).
type Shape = { t: number; c: Shape[] };
function treeMine(id: number): Shape {
  const k = yamlNodeKind(id);
  if (k === 3) {
    const c: Shape[] = [];
    for (let i = 0; i < yamlNodeCount(id); i++) c.push(treeMine(yamlPropValue(id, i)));
    return { t: 3, c };
  }
  if (k === 4) {
    const c: Shape[] = [];
    for (let i = 0; i < yamlNodeCount(id); i++) c.push(treeMine(yamlItem(id, i)));
    return { t: 4, c };
  }
  if (k === 2) return { t: 5, c: [] }; // an alias: anything
  return { t: 0, c: [] };
}
// (a value can be cyclic: `&a [*a]`; where it comes back the shape is "anything")
function treeBun(v: unknown, path: object[] = []): Shape {
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    if (path.includes(v as object)) return { t: 5, c: [] };
    path.push(v as object);
    const r: Shape = Array.isArray(v) ? { t: 4, c: v.map(x => treeBun(x, path)) } : { t: 3, c: Object.values(v as object).map(x => treeBun(x, path)) };
    path.pop();
    return r;
  }
  return { t: 0, c: [] };
}
function embeds(b: Shape, m: Shape): boolean {
  if (m.t === 5) return true;
  if (b.t !== m.t) return false;
  if (b.t === 0) return true;
  if (b.t === 4) {
    if (b.c.length !== m.c.length) return false;
    for (let i = 0; i < b.c.length; i++) if (!embeds(b.c[i], m.c[i])) return false;
    return true;
  }
  const used = new Array<boolean>(m.c.length).fill(false);
  for (const x of b.c) {
    let found = false;
    for (let j = 0; j < m.c.length; j++) {
      if (!used[j] && embeds(x, m.c[j])) {
        used[j] = true;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}
function treeOfMine(): Shape {
  const docs: Shape[] = [];
  for (let i = 0; i < yamlDocCount(); i++) docs.push(treeMine(yamlDocRoot(i)));
  return docs.length === 1 ? docs[0] : { t: 4, c: docs };
}

// Independent checks of the tokens, for a text we accept: sorted and apart, each of the form its kind has, nothing
// but white space in between (and the rest of a directive line), and every simple string of Bun's value is the text of
// a token (so the ranges of the scalars are where the scalars are).
function checkTokens(bytes: Buffer, value: unknown, hasAlias: boolean): string | null {
  const text = bytes.toString("latin1");
  const count = yamlTokenCount();
  let prevEnd = text.startsWith("\u00ef\u00bb\u00bf") ? 3 : 0;
  let afterDirective = false;
  const texts = new Set<string>();
  const gapOk = (from: number, to: number, directive: boolean): boolean => {
    let i = from;
    if (directive) {
      while (i < to && text[i] !== "\n" && text[i] !== "\r") i++;
    }
    for (; i < to; i++) {
      const c = text[i];
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return false;
    }
    return true;
  };
  for (let i = 0; i < count; i++) {
    const kind = yamlTokenKind(i);
    const start = yamlTokenStart(i);
    const end = yamlTokenEnd(i);
    if (start < prevEnd) {
      // the comment behind the header of a block scalar is listed after the scalar, inside its range
      if (kind === 0 && i > 0 && yamlTokenKind(i - 1) === TK_SCALAR && (text[yamlTokenStart(i - 1)] === "|" || text[yamlTokenStart(i - 1)] === ">") && start > yamlTokenStart(i - 1) && end <= prevEnd) {
        const nl = text.indexOf("\n", yamlTokenStart(i - 1));
        if (nl >= end - 1 || nl < 0) continue;
      }
      return `token ${i} starts at ${start}, before the end ${prevEnd} of the one before`;
    }
    if (!(end > start)) return `token ${i} is empty`;
    if (!gapOk(prevEnd, start, afterDirective)) return `non-white-space between tokens ${i - 1} and ${i}: ${JSON.stringify(text.slice(prevEnd, start))}`;
    const t = text.slice(start, end);
    const first = t[0];
    const want: Record<number, string> = {
      0: "#", 1: "%", 2: "---", 3: "...", 4: "-", 5: "?", 6: ":", 7: ",", 8: "[", 9: "]", 10: "{", 11: "}", 12: "&", 13: "*", 14: "!",
    };
    if (kind <= 14) {
      const w = want[kind];
      if (kind === 0 || kind === 12 || kind === 13 || kind === 14) {
        if (first !== w) return `token ${i} (${tokenKindName(kind)}) is ${JSON.stringify(t)}`;
        if (kind !== 0 && /[ \t\n\r]/.test(t)) return `token ${i} (${tokenKindName(kind)}) has white space: ${JSON.stringify(t)}`;
        if (kind === 0 && /[\n\r]/.test(t)) return `comment ${i} has a line break`;
      } else if (t !== w) return `token ${i} (${tokenKindName(kind)}) is ${JSON.stringify(t)}`;
    } else {
      // a scalar
      const fold = (x: string) => x.replace(/[ \t]*(?:\r\n|\r|\n)[ \t]*/g, " ");
      if (first === "'" || first === '"') {
        if (t.length < 2 || t[t.length - 1] !== first) return `quoted scalar ${i} does not end with its quote: ${JSON.stringify(t.slice(0, 40))}`;
        let inner = t.slice(1, -1);
        if (first === "'") inner = inner.replace(/''/g, "'");
        else {
          inner = inner.replace(/\\([\/"\\])/g, "$1");
          inner = inner.replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (_m, u, x) => String.fromCharCode(parseInt(u ?? x, 16)));
        }
        if (!inner.includes("\\")) {
          texts.add(inner);
          texts.add(fold(inner));
          texts.add(fold(inner).replace(/\\\n/g, ""));
        }
      } else if (first === "|" || first === ">") {
        // block scalar: the lines after the header
        const lines = t.split(/\r?\n/).slice(1).map(l => l.trim()).filter(l => l.length > 0);
        for (const l of lines) texts.add(l);
        texts.add(lines.join(" "));
        texts.add(lines.join(""));
      } else {
        const trimmed = t.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
        if (trimmed.length === 0) return `plain scalar ${i} is white space`;
        texts.add(trimmed);
        texts.add(fold(trimmed));
        if (/^[ \t\r\n]/.test(t)) return `plain scalar ${i} starts with white space`;
      }
    }
    afterDirective = kind === 1;
    prevEnd = end;
  }
  if (!gapOk(prevEnd, text.length, afterDirective)) return `non-white-space after the last token: ${JSON.stringify(text.slice(prevEnd, prevEnd + 20))}`;
  if (hasAlias || text.includes("<<")) return null;
  const strings: string[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      if (seen.has(v as object)) return;
      seen.add(v as object);
      if (Array.isArray(v)) v.forEach(walk);
      else {
        for (const [k, x] of Object.entries(v as object)) {
          strings.push(k);
          walk(x);
        }
      }
    }
  };
  walk(value);
  const latin = (str: string) => Buffer.from(str, "utf8").toString("latin1");
  for (const str of strings) {
    if (!/^[A-Za-z0-9 _.\/-]+$/.test(str)) continue;
    if (/^[-+]?[0-9._eE+-]*$/.test(str) || ["null", "true", "false", "NaN", "Infinity", "-Infinity", "True", "False", "TRUE", "FALSE", "Null", "NULL"].includes(str)) continue;
    if (str.trim() !== str) continue;
    if (!texts.has(latin(str))) return `the string ${JSON.stringify(str)} of the value is the text of no token`;
  }
  return null;
}

function minePerDoc(): string[] {
  const out: string[] = [];
  for (let i = 0; i < yamlDocCount(); i++) out.push(shapeMine(yamlDocRoot(i)));
  return out;
}

function shapeOfMine(): string {
  const docs = minePerDoc();
  return docs.length === 1 ? docs[0] : "[" + docs.join(",") + "]";
}

// ---------------------------------------------------------------------------------------------------------------

function mutate(rng: Rng, input: Buffer): Buffer {
  const text = Array.from(input);
  const count = 1 + rng.below(3);
  const chars = ": -?[]{},#&*!|>'\"%\n\t.\\@".split("").map(c => c.charCodeAt(0));
  let out = text;
  for (let m = 0; m < count; m++) {
    const kind = rng.below(7);
    const at = out.length === 0 ? 0 : rng.below(out.length);
    switch (kind) {
      case 0: // insert a significant char
        out = out.slice(0, at).concat([rng.pick(chars)], out.slice(at));
        break;
      case 1: // delete a byte
        out = out.slice(0, at).concat(out.slice(at + 1));
        break;
      case 2: { // delete a line
        let s = at;
        while (s > 0 && out[s - 1] !== 10) s--;
        let e = at;
        while (e < out.length && out[e] !== 10) e++;
        out = out.slice(0, s).concat(out.slice(e + 1));
        break;
      }
      case 3: { // duplicate a line
        let s = at;
        while (s > 0 && out[s - 1] !== 10) s--;
        let e = at;
        while (e < out.length && out[e] !== 10) e++;
        out = out.slice(0, e + 1).concat(out.slice(s, e + 1), out.slice(e + 1));
        break;
      }
      case 4: { // indent a line by 1-3 spaces, or take away one
        let s = at;
        while (s > 0 && out[s - 1] !== 10) s--;
        if (rng.below(2) === 0 || out[s] !== 32) out = out.slice(0, s).concat(new Array(1 + rng.below(3)).fill(32), out.slice(s));
        else out = out.slice(0, s).concat(out.slice(s + 1));
        break;
      }
      case 5: // truncate
        out = out.slice(0, at);
        break;
      default: { // swap two adjacent bytes
        if (at + 1 < out.length) {
          const t = out[at];
          out[at] = out[at + 1];
          out[at + 1] = t;
        }
      }
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------------------------------------------

function lineCol(bytes: Buffer, offset: number): [number, number] {
  offset = Math.min(offset, bytes.length);
  let line = 1;
  let start = 0;
  for (let i = 0; i < offset; i++) {
    if (bytes[i] === 10) {
      line++;
      start = i + 1;
    }
  }
  const col = bytes.toString("utf16le", 0, 0).length + Buffer.from(bytes.subarray(start, offset)).toString("utf8").length;
  return [line, col + 1];
}

type Counts = Map<string, number>;
const counts: Counts = new Map();
const examples = new Map<string, string[]>();
function note(cat: string, example: string): void {
  counts.set(cat, (counts.get(cat) ?? 0) + 1);
  let e = examples.get(cat);
  if (!e) examples.set(cat, (e = []));
  if (e.length < SHOW) e.push(example);
}

type Rejected = { name: string; bytes: Buffer; kind: number; pos: number };
const rejected: Rejected[] = [];
// Accepted by us, refused by Bun for an alias that does not resolve: `bun fmt` (which does not resolve) must not
// refuse them for a reason of the parser.
const aliasAccepted: Rejected[] = [];

function runOne(name: string, input: Buffer): void {
  // The formatter replaces NUL with 1 for `yaml`
  let bytes = input;
  if (!KEEP_NUL && bytes.includes(0)) bytes = Buffer.from(bytes.map(b => (b === 0 ? 1 : b)));
  const kind = yamlParseAsWritten(bytes, bytes.length);
  const pos = kind === 0 ? 0 : yamlErrorPos();
  let value: unknown;
  let bunErr: string | null = null;
  try {
    value = Bun.YAML.parse(bytes);
  } catch (e) {
    bunErr = String((e as Error).message ?? e).replace(/^YAML Parse error: /, "");
  }
  if (kind === 0 && bunErr === null) {
    // both accept: the shape
    let hasAlias = false;
    for (let i = 0; i < yamlTokenCount(); i++) if (yamlTokenKind(i) === TK_ALIAS) hasAlias = true;
    const text = bytes.toString("latin1");
    const bad = checkTokens(bytes, value, hasAlias);
    if (bad !== null) note("BUG tokens: " + bad.replace(/[0-9]+/g, "N").slice(0, 60), `${name}: ${bad}`);
    else note("tokens: well formed", name);
    if (text.includes("<<")) {
      note("accept/accept (merge key: shape not compared)", name);
      return;
    }
    if (hasAlias) {
      // an alias is anything
      if (embeds(treeBun(value), treeOfMine())) note("accept/accept with aliases: shape fits", name);
      else note("accept/accept SHAPE DIFFERS (aliases)", `${name}\n   mine: ${shapeOfMine().slice(0, 200)}\n   bun:  ${shapeBun(value).slice(0, 200)}`);
      return;
    }
    const a = shapeOfMine();
    const b = shapeBun(value);
    if (a === b) note("accept/accept shape equal", name);
    // duplicate keys (a JS object has one of them) and keys that are arrays (the same key as a string): Bun's
    // value has fewer members
    else if (embeds(treeBun(value), treeOfMine())) note("accept/accept shape differs (members of objects with the same key: explained)", name);
    else note("accept/accept SHAPE DIFFERS", `${name}\n   mine: ${a.slice(0, 200)}\n   bun:  ${b.slice(0, 200)}`);
    return;
  }
  if (kind === 0) {
    if (ALIAS_ERRORS.has(bunErr!)) {
      note("mine accepts, bun: alias error (expected)", name);
      aliasAccepted.push({ name, bytes, kind: 0, pos: 0 });
    }
    else note("BUG mine accepts, bun rejects: " + bunErr, name);
    return;
  }
  // mine rejects
  rejected.push({ name, bytes, kind, pos });
  if (bunErr === null) {
    note("BUG mine rejects " + parseErrorName(kind) + ", bun accepts", `${name} @${pos}`);
    return;
  }
  if (ALIAS_ERRORS.has(bunErr)) {
    note("both reject (bun: alias error, inconclusive)", name);
    return;
  }
  const expected = bunMessageOf(kind, pos, bytes.length);
  if (expected === bunErr) note("both reject, same message", name);
  else note("BUG both reject, message differs", `${name}: mine ${parseErrorName(kind)} (${expected}) @${pos}, bun ${bunErr}`);
}

// ---------------------------------------------------------------------------------------------------------------

function checkAgainstFmt(): void {
  if (rejected.length === 0) return;
  const dir = "/tmp/ptest/yaml-fmt";
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const todo: Rejected[] = [];
  for (let i = 0; i < rejected.length; i++) {
    const r = rejected[i];
    // Lone CRs are line breaks for Prettier and for nobody else: not compared.
    let lone = false;
    for (let k = 0; k < r.bytes.length; k++) if (r.bytes[k] === 13 && r.bytes[k + 1] !== 10) lone = true;
    // (the formatter replaces NUL: not the same text)
    if (lone || r.bytes.includes(0)) continue;
    writeFileSync(`${dir}/${i}.yaml`, r.bytes);
    todo.push(r);
  }
  // one run per slice, to keep the output of a run reasonable
  const files = readdirSync(dir);
  const out: string[] = [];
  for (let s = 0; s < files.length; s += 500) {
    const slice = files.slice(s, s + 500).map(f => `${dir}/${f}`);
    const res = Bun.spawnSync({ cmd: [process.env.HOME + "/.bun/bin/bun", "fmt", "--check", ...slice], stderr: "pipe", stdout: "pipe" });
    out.push(res.stderr.toString("utf8"));
    out.push(res.stdout.toString("utf8"));
  }
  const text = out.join("\n");
  // error: <message>\n    at <path>:<line>:<col>
  const reported = new Map<number, { message: string; line: number; col: number }>();
  const re = /error: ([^\n]*)\n\s+at [^\n]*?\/(\d+)\.yaml:(\d+):(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) reported.set(Number(m[2]), { message: m[1], line: Number(m[3]), col: Number(m[4]) });
  const groupToMessage = new Map<string, Set<string>>();
  for (let i = 0; i < rejected.length; i++) {
    const r = rejected[i];
    const got = reported.get(i);
    if (!todo.includes(r)) continue;
    if (!got) {
      note("fmt: no error reported for a file we reject", `${r.name} ${parseErrorName(r.kind)} @${r.pos}`);
      continue;
    }
    // BOM: the offset does not count it
    let bytes = r.bytes;
    let pos = r.pos;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      bytes = bytes.subarray(3);
      pos -= 3;
    }
    const [line, col] = lineCol(Buffer.from(bytes), Math.max(0, pos));
    const group = fmtGroupOf(r.kind);
    let set = groupToMessage.get(group);
    if (!set) groupToMessage.set(group, (set = new Set()));
    set.add(got.message);
    if (got.line === line && got.col === col) note("fmt: same place", r.name);
    else note("BUG fmt: other place", `${r.name}: mine ${parseErrorName(r.kind)} ${line}:${col}, fmt ${got.line}:${got.col} (${got.message})`);
  }
  // what `bun fmt` says of what we accept (and Bun's parse refuses because of an alias)
  if (aliasAccepted.length > 0) {
    const dir2 = "/tmp/ptest/yaml-fmt-ok";
    rmSync(dir2, { recursive: true, force: true });
    mkdirSync(dir2, { recursive: true });
    for (let i = 0; i < aliasAccepted.length; i++) writeFileSync(`${dir2}/${i}.yaml`, aliasAccepted[i].bytes);
    const files2 = readdirSync(dir2);
    const out2: string[] = [];
    for (let s = 0; s < files2.length; s += 500) {
      const slice = files2.slice(s, s + 500).map(f => `${dir2}/${f}`);
      const res = Bun.spawnSync({ cmd: [process.env.HOME + "/.bun/bin/bun", "fmt", "--check", ...slice], stderr: "pipe", stdout: "pipe" });
      out2.push(res.stderr.toString("utf8"), res.stdout.toString("utf8"));
    }
    const reported2 = new Map<number, string>();
    const re2 = /error: ([^\n]*)\n\s+at [^\n]*?\/(\d+)\.yaml:(\d+):(\d+)/g;
    let m2: RegExpExecArray | null;
    const text2 = out2.join("\n");
    while ((m2 = re2.exec(text2))) reported2.set(Number(m2[2]), m2[1]);
    const parserMessages = new Set(["Invalid directive", "This tag cannot be resolved", 'A key without "?" must be on one line', "A node can have at most one anchor and one tag", "Tabs cannot be used for indentation", "Unclosed string", "Unexpected character", "Unexpected token", "Unexpected end of file"]);
    for (let i = 0; i < aliasAccepted.length; i++) {
      const msg = reported2.get(i);
      if (msg === undefined) note("fmt: accepts what we accept (alias cases)", aliasAccepted[i].name);
      else if (parserMessages.has(msg)) note("BUG fmt refuses (parser) what we accept: " + msg, aliasAccepted[i].name);
      else note("fmt: error of the tree builder on what we accept (not the parser): " + msg, aliasAccepted[i].name);
    }
  }
  for (const [group, set] of groupToMessage) {
    const messages = [...set];
    note(`fmt message of ${group}: ${messages.length === 1 ? "one" : "SEVERAL"}`, messages.join(" | "));
  }
}

// ---------------------------------------------------------------------------------------------------------------

function ownCases(dir: string, rel: string, out: Case[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) ownCases(`${dir}/${e.name}`, `${rel}/${e.name}`, out);
    else if (/\.ya?ml\.input$/.test(e.name)) out.push({ name: `bun-own/${rel}/${e.name}`, bytes: readFileSync(`${dir}/${e.name}`) });
  }
}
const own: Case[] = [];
ownCases(ROOT + "vendor/bun/test/cli/format/own/cases", "cases", own);

const corpus: Case[] = [
  ...own,
  ...vscodeFiles([".yml", ".yaml"]),
  ...prettierFiles("/yaml/", p => p.includes("__snapshots__") || p.endsWith(".js") || p.endsWith(".md")),
];
console.log(`corpus: ${corpus.length} files`);

const t0 = performance.now();
for (const c of corpus) runOne(c.name, c.bytes);
const nCorpus = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`corpus done: ${nCorpus} cases in ${(performance.now() - t0).toFixed(0)} ms`);

if (FUZZ > 0) {
  const rng = new Rng(SEED);
  let n = 0;
  for (const c of corpus) {
    // big files make the mutants slow to make; the interesting ones are the small ones
    if (c.bytes.length > 20000) continue;
    for (let i = 0; i < FUZZ; i++) {
      runOne(`${c.name}#${SEED}.${i}`, mutate(rng, c.bytes));
      n++;
    }
  }
  console.log(`fuzz: ${n} mutants`);
}

// Token soup: random strings of YAML pieces. Mostly rejected, but at every kind of place; the accepted ones are
// the odd corners (tabs, properties on their own, empty nodes, compact collections, block scalars, ..).
const PIECES = [
  "- ", "-", "? ", "?", ": ", ":", "a", "b", "key", "k: ", "'q'", "\"d\"", "\"\\u0041\"", "\"\\x4\"", "'", "\"", "[", "]", "{", "}", ",", ", ",
  "&a ", "&a", "&b ", "*a", "*a ", "!t ", "!!str ", "!<x:y> ", "!e!z ", "!", "!! ", "|", ">", "|2", "|-", ">+", "|1-", "| # c", "# c", " # c",
  "---", "--- ", "...", "%YAML 1.2", "%TAG !e! tag:x", "%TAG ! y", "%FOO bar", "\t", " ", "  ", "    ", "\n", "\n", "\n", "\n  ", "\n    ",
  "\r\n", "\r", "1", "0x1f", "-1", "1e3", ".5", ".inf", "-.inf", ".nan", "true", "null", "~", "<<", "@", "`", "%", "#", "word word", "a:b", "a #b",
  "- - ", "- ? ", "? - ", ": - ", "[a, b]", "{a: b}", "[a: b]", "{? a}", "[? a]", "{a}", "[,]", "{,}", "\u00e9", "\u0085", "\u2028", "\u0000",
];
if (SOUP > 0) {
  const rng = new Rng(SEED + 1000);
  const enc = new TextEncoder();
  for (let i = 0; i < SOUP; i++) {
    const count = 1 + rng.below(14);
    let t = "";
    for (let k = 0; k < count; k++) {
      t += rng.pick(PIECES);
      if (rng.below(3) === 0) t += "\n" + " ".repeat(rng.below(5));
    }
    runOne(`soup#${SEED}.${i} ${JSON.stringify(t)}`, Buffer.from(enc.encode(t)));
  }
  console.log(`soup: ${SOUP} cases`);
}

if (!NOFMT) checkAgainstFmt();

let bugs = 0;
for (const [cat, count] of [...counts].sort()) {
  console.log(`${String(count).padStart(7)}  ${cat}`);
  if (cat.startsWith("BUG") || cat.includes("DIFFERS") || cat.startsWith("fmt message")) {
    if (cat.startsWith("BUG") || cat.includes("DIFFERS")) bugs += count;
    for (const e of examples.get(cat) ?? []) console.log("           " + e);
  }
}
console.log(bugs === 0 ? "no bugs" : `${bugs} BUGS`);
