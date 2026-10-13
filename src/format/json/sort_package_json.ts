// Port of vendor/bun/src/format/json/sort_package_json.rs. oxfmt's `sortPackageJson`: the fields of a `package.json` in the
// conventional order.
//
// oxfmt does it with the crate `sort-package-json` (MIT license, VoidZero Inc. and contributors), which this is a port of,
// before it formats the result. The crate reads the text with `serde_json` and writes it with `serde_json`, so this also
// does what that round trip does to the spelling of strings and numbers.
//
// A feature that is off unless asked for, and on a `package.json` only: it is written for clarity, not for speed. Values
// are small objects; strings are byte arrays.
import { ByteBuf } from "../../base/bytebuf.ts";
import { decodeUtf8, utf8Len } from "../../base/utf8.ts";
import { startsWithBom } from "../text.ts";
import { jsonStringify } from "./util.ts";

const V_LITERAL = 0;
const V_NUMBER = 1;
const V_STRING = 2;
const V_ARRAY = 3;
const V_OBJECT = 4;

class Value {
  kind: number;
  /** A literal or a number, as it is written. */
  text: string = "";
  /** The value of a string. */
  bytes: Uint8Array = new Uint8Array(0);
  items: Value[] = [];
  keys: Uint8Array[] = [];
  vals: Value[] = [];
  constructor(kind: number) {
    this.kind = kind;
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    const x = a[i] | 0;
    const y = b[i] | 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0;
}

function asciiBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) | 0;
  return b;
}

function startsWithByte(a: Uint8Array, byte: number): boolean {
  return a.length > 0 && (a[0] | 0) === byte;
}

// ───────────────────────────── reading, as serde_json does ─────────────────────────────

const U64_MAX = (1n << 64n) - 1n;

class Reader {
  text: Uint8Array;
  at: number = 0;
  n: number;
  constructor(text: Uint8Array) {
    this.text = text;
    this.n = text.length;
  }

  peek(): number {
    return this.at < this.n ? this.text[this.at] | 0 : -1;
  }

  skipWhitespace(): void {
    while (this.at < this.n) {
      const c = this.text[this.at] | 0;
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
      this.at = this.at + 1;
    }
  }

  eat(byte: number): boolean {
    if (this.peek() === byte) {
      this.at = this.at + 1;
      return true;
    }
    return false;
  }

  /** `depth`: the number of containers around. `serde_json` gives up at 128. Returns null if it is not strict JSON. */
  value(depth: number): Value | null {
    this.skipWhitespace();
    const c = this.peek();
    if (c < 0) return null;
    if (c === 123 && depth < 127) {
      this.at = this.at + 1;
      const object = new Value(V_OBJECT);
      this.skipWhitespace();
      if (this.eat(125)) return object;
      while (true) {
        this.skipWhitespace();
        const key = this.string();
        if (key === null) return null;
        this.skipWhitespace();
        if (!this.eat(58)) return null;
        const v = this.value(depth + 1);
        if (v === null) return null;
        object.keys.push(key);
        object.vals.push(v);
        this.skipWhitespace();
        if (!this.eat(44)) {
          if (!this.eat(125)) return null;
          return object;
        }
      }
    }
    if (c === 91 && depth < 127) {
      this.at = this.at + 1;
      const array = new Value(V_ARRAY);
      this.skipWhitespace();
      if (this.eat(93)) return array;
      while (true) {
        const v = this.value(depth + 1);
        if (v === null) return null;
        array.items.push(v);
        this.skipWhitespace();
        if (!this.eat(44)) {
          if (!this.eat(93)) return null;
          return array;
        }
      }
    }
    if (c === 34) {
      const s = this.string();
      if (s === null) return null;
      const v = new Value(V_STRING);
      v.bytes = s;
      return v;
    }
    if (c === 45 || (c >= 48 && c <= 57)) {
      const t = this.number();
      if (t === null) return null;
      const v = new Value(V_NUMBER);
      v.text = t;
      return v;
    }
    for (const lit of ["null", "true", "false"]) {
      if (this.hasAt(lit)) {
        this.at = this.at + lit.length;
        const v = new Value(V_LITERAL);
        v.text = lit;
        return v;
      }
    }
    return null;
  }

  hasAt(lit: string): boolean {
    if (this.at + lit.length > this.n) return false;
    for (let i = 0; i < lit.length; i++) if ((this.text[this.at + i] | 0) !== lit.charCodeAt(i)) return false;
    return true;
  }

  hex4(): number {
    if (this.at + 4 > this.n) return -1;
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.text[this.at + i] | 0;
      let d: number;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 97 && c <= 102) d = c - 87;
      else if (c >= 65 && c <= 70) d = c - 55;
      else return -1;
      v = v * 16 + d;
    }
    this.at = this.at + 4;
    return v;
  }

  /** The value of the string at the cursor, or null. */
  string(): Uint8Array | null {
    if (!this.eat(34)) return null;
    const start = this.at;
    let owned: ByteBuf | null = null;
    while (true) {
      const c = this.peek();
      if (c < 0) return null;
      if (c === 34) {
        const end = this.at;
        this.at = this.at + 1;
        if (owned !== null) return owned.data.slice(0, owned.len);
        return this.text.slice(start, end);
      }
      if (c === 92) {
        if (owned === null) {
          owned = new ByteBuf(end0(this.at - start) + 16);
          owned.append(this.text, start, this.at);
        }
        if (this.at + 1 >= this.n) return null;
        const escaped = this.text[this.at + 1] | 0;
        this.at = this.at + 2;
        switch (escaped) {
          case 34: case 92: case 47: owned.push(escaped); break;
          case 98: owned.push(8); break;
          case 102: owned.push(12); break;
          case 110: owned.push(10); break;
          case 114: owned.push(13); break;
          case 116: owned.push(9); break;
          case 117: {
            const first = this.hex4();
            if (first < 0) return null;
            let cp = first;
            if (first >= 0xdc00 && first <= 0xdfff) return null;
            if (first >= 0xd800 && first <= 0xdbff) {
              if (!this.eat(92)) return null;
              if (!this.eat(117)) return null;
              const low = this.hex4();
              if (low < 0xdc00 || low > 0xdfff) return null;
              cp = 0x10000 + ((first - 0xd800) << 10) + (low - 0xdc00);
            }
            pushWtf8(owned, cp);
            break;
          }
          default:
            return null;
        }
      } else if (c < 0x20) {
        return null;
      } else {
        if (owned !== null) owned.push(c);
        this.at = this.at + 1;
      }
    }
  }

  digit(): number {
    const c = this.peek();
    return c >= 48 && c <= 57 ? c - 48 : -1;
  }

  /**
   * The number at the cursor, as `serde_json` writes it: an integer that fits in 64 bits as it is, anything else as a `f64`.
   * Without its feature `float_roundtrip`, that is the digits that fit in a `u64`, multiplied or divided by a power of ten,
   * which is not always the nearest.
   */
  number(): string | null {
    const isPositive = !this.eat(45);
    let significand: bigint;
    let d = this.digit();
    if (d < 0) return null;
    significand = BigInt(d);
    this.at = this.at + 1;
    let exponent = 0;
    let isFloat = false;
    if (significand === 0n) {
      // Only one leading zero.
      if (this.digit() >= 0) return null;
    } else {
      while ((d = this.digit()) >= 0) {
        this.at = this.at + 1;
        const next = isFloat ? -1n : significand * 10n + BigInt(d);
        if (next >= 0n && next <= U64_MAX) {
          significand = next;
        } else {
          // The digits that do not fit only count.
          isFloat = true;
          exponent = exponent < 2147483647 ? exponent + 1 : exponent;
        }
      }
    }
    if (this.eat(46)) {
      isFloat = true;
      if (this.digit() < 0) return null;
      let isFull = false;
      while ((d = this.digit()) >= 0) {
        this.at = this.at + 1;
        const next = isFull ? -1n : significand * 10n + BigInt(d);
        if (next >= 0n && next <= U64_MAX) {
          significand = next;
          exponent = exponent - 1;
        } else {
          isFull = true;
        }
      }
    }
    const e = this.peek();
    if (e === 101 || e === 69) {
      isFloat = true;
      this.at = this.at + 1;
      let isPositiveExponent = true;
      if (this.peek() === 45) {
        this.at = this.at + 1;
        isPositiveExponent = false;
      } else if (this.peek() === 43) {
        this.at = this.at + 1;
      }
      if (this.digit() < 0) return null;
      let written = 0;
      let overflow = false;
      while ((d = this.digit()) >= 0) {
        this.at = this.at + 1;
        if (!overflow) {
          const w = written * 10 + d;
          if (w > 2147483647) overflow = true;
          else written = w;
        }
      }
      if (!overflow) {
        if (isPositiveExponent) exponent = Math.min(2147483647, exponent + written);
        else exponent = Math.max(-2147483648, exponent - written);
      } else if (significand !== 0n && isPositiveExponent) {
        return null;
      } else {
        return isPositive ? "0.0" : "-0.0";
      }
    }

    if (!isFloat) {
      if (isPositive) return significand.toString();
      if (significand !== 0n && significand <= 1n << 63n) return "-" + significand.toString();
      return writeF64(-Number(significand));
    }
    let value = Number(significand);
    while (true) {
      const abs = exponent < 0 ? -exponent : exponent;
      if (abs <= 308) {
        // The nearest `f64`, which multiplying tens does not give.
        const power = Number("1e" + abs);
        if (exponent >= 0) {
          value *= power;
          if (value === Infinity) return null;
        } else {
          value /= power;
        }
        break;
      }
      if (value === 0) break;
      if (exponent >= 0) return null;
      value /= 1e308;
      exponent += 308;
    }
    return writeF64(isPositive ? value : -value);
  }
}

function end0(n: number): number {
  return n < 0 ? 0 : n;
}

function pushWtf8(buf: ByteBuf, cp: number): void {
  if (cp < 0x80) buf.push(cp);
  else if (cp < 0x800) {
    buf.push(0xc0 | (cp >> 6));
    buf.push(0x80 | (cp & 0x3f));
  } else if (cp < 0x10000) {
    buf.push(0xe0 | (cp >> 12));
    buf.push(0x80 | ((cp >> 6) & 0x3f));
    buf.push(0x80 | (cp & 0x3f));
  } else {
    buf.push(0xf0 | (cp >> 18));
    buf.push(0x80 | ((cp >> 12) & 0x3f));
    buf.push(0x80 | ((cp >> 6) & 0x3f));
    buf.push(0x80 | (cp & 0x3f));
  }
}

// ───────────────────────────── writing, as serde_json does ─────────────────────────────

/** The shortest digits that give `value` back, with an exponent from `1e16` on and below `1e-5`. */
function writeF64(value: number): string {
  if (value === 0) return 1 / value < 0 ? "-0.0" : "0.0";
  // The digits of JavaScript. Where two numbers of the same length are as close, `serde_json` takes the even one, as
  // JavaScript does. `{:e}` takes the greater one.
  const text = String(Math.abs(value));
  let mantissa = text;
  let expText = "0";
  const ePos = text.indexOf("e");
  if (ePos >= 0) {
    mantissa = text.slice(0, ePos);
    expText = text.slice(ePos + 1);
  }
  let integer = mantissa;
  let fraction = "";
  const dot = mantissa.indexOf(".");
  if (dot >= 0) {
    integer = mantissa.slice(0, dot);
    fraction = mantissa.slice(dot + 1);
  }
  const exponent = parseInt(expText, 10);
  const all = integer + fraction;
  let leadingZeros = 0;
  while (leadingZeros < all.length && all.charCodeAt(leadingZeros) === 48) leadingZeros++;
  let digits = all.slice(leadingZeros);
  let trailing = 0;
  while (trailing < digits.length && digits.charCodeAt(digits.length - 1 - trailing) === 48) trailing++;
  digits = digits.slice(0, digits.length - trailing);
  // Where the decimal point is, counted from the first digit.
  const point = integer.length + exponent - leadingZeros;
  const len = digits.length;
  let out = value < 0 ? "-" : "";
  if (len <= point && point <= 16) {
    out += digits + "0".repeat(point - len) + ".0";
  } else if (0 < point && point <= 16) {
    out += digits.slice(0, point) + "." + digits.slice(point);
  } else if (-5 < point && point <= 0) {
    out += "0." + "0".repeat(-point) + digits;
  } else if (len > 0) {
    out += digits.charAt(0);
    if (len > 1) out += "." + digits.slice(1);
    out += "e";
    if (point > 0) out += "+";
    out += String(point - 1);
  }
  return out;
}

/** The nesting is limited by `Reader.value`. */
function writeValue(v: Value, out: ByteBuf): void {
  switch (v.kind) {
    case V_LITERAL:
    case V_NUMBER:
      out.appendAscii(v.text);
      break;
    case V_STRING:
      jsonStringify(v.bytes, 0, v.bytes.length, out);
      break;
    case V_ARRAY:
      out.push(91);
      for (let i = 0; i < v.items.length; i++) {
        if (i > 0) out.push(44);
        writeValue(v.items[i], out);
      }
      out.push(93);
      break;
    default:
      out.push(123);
      for (let i = 0; i < v.keys.length; i++) {
        if (i > 0) out.push(44);
        jsonStringify(v.keys[i], 0, v.keys[i].length, out);
        out.push(58);
        writeValue(v.vals[i], out);
      }
      out.push(125);
  }
}

// ───────────────────────────── sorting ─────────────────────────────

// What is done to the value of a field.
const T_NONE = 0;
/** The names of the object are sorted. */
const T_ALPHABETICALLY = 1;
/** And those of the objects in it. */
const T_RECURSIVELY = 2;
/** These names first, in this order. The others follow, sorted. */
const T_KEY_ORDER = 3;
/** Of an array, the strings are kept, sorted, each once. */
const T_SORTED_UNIQUE = 4;
/** Of an array, the strings are kept, each once, in their order. */
const T_UNIQUE = 5;
/** Like the document. */
const T_FIELDS = 6;
/** `T_ALPHABETICALLY`, if that is asked for. */
const T_SCRIPTS = 7;
const T_DEV_ENGINES = 8;

const TYPE_URL = ["type", "url"];
const DEV_ENGINE = ["name", "version", "onFail"];

class Field {
  name: string;
  transform: number;
  order: string[];
  constructor(name: string, transform: number, order: string[]) {
    this.name = name;
    this.transform = transform;
    this.order = order;
  }
}

const NO_ORDER: string[] = [];

/** The known fields, in their order. */
const FIELDS: Field[] = [];
function field(name: string, transform: number, order: string[] = NO_ORDER): void {
  FIELDS.push(new Field(name, transform, order));
}
// Core package metadata
field("$schema", T_NONE);
field("name", T_NONE);
field("displayName", T_NONE);
field("version", T_NONE);
field("stableVersion", T_NONE);
field("gitHead", T_NONE);
field("private", T_NONE);
field("description", T_NONE);
field("categories", T_SORTED_UNIQUE);
field("keywords", T_SORTED_UNIQUE);
field("homepage", T_NONE);
field("bugs", T_KEY_ORDER, ["url", "email"]);
// License and people
field("license", T_NONE);
field("author", T_KEY_ORDER, ["name", "email", "url"]);
field("maintainers", T_NONE);
field("contributors", T_NONE);
// Repository and funding
field("repository", T_KEY_ORDER, TYPE_URL);
field("funding", T_KEY_ORDER, TYPE_URL);
field("donate", T_KEY_ORDER, TYPE_URL);
field("sponsor", T_KEY_ORDER, TYPE_URL);
field("qna", T_NONE);
field("publisher", T_NONE);
// Package content and distribution
field("man", T_NONE);
field("style", T_NONE);
field("example", T_NONE);
field("examplestyle", T_NONE);
field("assets", T_NONE);
field("bin", T_ALPHABETICALLY);
field("source", T_NONE);
field("directories", T_KEY_ORDER, ["lib", "bin", "man", "doc", "example", "test"]);
field("workspaces", T_NONE);
field("binary", T_KEY_ORDER, ["module_name", "module_path", "remote_path", "package_name", "host"]);
field("files", T_UNIQUE);
field("os", T_NONE);
field("cpu", T_NONE);
field("libc", T_SORTED_UNIQUE);
// Package entry points
field("type", T_NONE);
field("sideEffects", T_NONE);
field("main", T_NONE);
field("module", T_NONE);
field("browser", T_NONE);
field("types", T_NONE);
field("typings", T_NONE);
field("typesVersions", T_NONE);
field("typeScriptVersion", T_NONE);
field("typesPublisherContentHash", T_NONE);
field("react-native", T_NONE);
field("svelte", T_NONE);
field("unpkg", T_NONE);
field("jsdelivr", T_NONE);
field("jsnext:main", T_NONE);
field("umd", T_NONE);
field("umd:main", T_NONE);
field("es5", T_NONE);
field("esm5", T_NONE);
field("fesm5", T_NONE);
field("es2015", T_NONE);
field("esm2015", T_NONE);
field("fesm2015", T_NONE);
field("es2020", T_NONE);
field("esm2020", T_NONE);
field("fesm2020", T_NONE);
field("esnext", T_NONE);
field("imports", T_NONE);
field("exports", T_NONE);
field("publishConfig", T_FIELDS);
// Scripts
field("scripts", T_SCRIPTS);
field("betterScripts", T_SCRIPTS);
field("wireit", T_SCRIPTS);
// Dependencies
field("dependencies", T_ALPHABETICALLY);
field("devDependencies", T_ALPHABETICALLY);
field("dependenciesMeta", T_NONE);
field("peerDependencies", T_ALPHABETICALLY);
field("peerDependenciesMeta", T_NONE);
field("optionalDependencies", T_ALPHABETICALLY);
field("bundledDependencies", T_SORTED_UNIQUE);
field("bundleDependencies", T_SORTED_UNIQUE);
field("resolutions", T_ALPHABETICALLY);
field("overrides", T_ALPHABETICALLY);
// Git hooks and commit tools
field("husky", T_RECURSIVELY);
field("simple-git-hooks", T_NONE);
field("vite-staged", T_NONE);
field("lint-staged", T_NONE);
field("nano-staged", T_NONE);
field("pre-commit", T_NONE);
field("commitlint", T_RECURSIVELY);
// Extensions of VS Code
field("l10n", T_NONE);
field("contributes", T_NONE);
field("activationEvents", T_SORTED_UNIQUE);
field("extensionPack", T_SORTED_UNIQUE);
field("extensionDependencies", T_SORTED_UNIQUE);
field("extensionKind", T_SORTED_UNIQUE);
field("icon", T_NONE);
field("badges", T_NONE);
field("galleryBanner", T_NONE);
field("preview", T_NONE);
field("markdown", T_NONE);
// Configuration of build tools. Where the order of what is nested means something, only the top level is sorted.
field("napi", T_ALPHABETICALLY);
field("flat", T_NONE);
field("config", T_ALPHABETICALLY);
field("nodemonConfig", T_RECURSIVELY);
field("browserify", T_RECURSIVELY);
field("babel", T_RECURSIVELY);
field("browserslist", T_NONE);
field("xo", T_RECURSIVELY);
field("prettier", T_RECURSIVELY);
field("eslintConfig", T_RECURSIVELY);
field("eslintIgnore", T_NONE);
field("standard", T_RECURSIVELY);
field("npmpkgjsonlint", T_NONE);
field("npmPackageJsonLintConfig", T_NONE);
field("npmpackagejsonlint", T_NONE);
field("release", T_NONE);
field("auto-changelog", T_ALPHABETICALLY);
field("remarkConfig", T_ALPHABETICALLY);
field("stylelint", T_RECURSIVELY);
field("typescript", T_RECURSIVELY);
field("typedoc", T_RECURSIVELY);
field("tshy", T_ALPHABETICALLY);
field("tsdown", T_RECURSIVELY);
field("size-limit", T_NONE);
// Testing
field("ava", T_RECURSIVELY);
field("jest", T_ALPHABETICALLY);
field("jest-junit", T_NONE);
field("jest-stare", T_NONE);
field("mocha", T_RECURSIVELY);
field("nyc", T_RECURSIVELY);
field("c8", T_RECURSIVELY);
field("tap", T_NONE);
field("tsd", T_RECURSIVELY);
field("typeCoverage", T_RECURSIVELY);
field("oclif", T_RECURSIVELY);
// Runtime and package manager
field("languageName", T_NONE);
field("preferGlobal", T_NONE);
field("devEngines", T_DEV_ENGINES);
field("engines", T_ALPHABETICALLY);
field("engineStrict", T_NONE);
field("volta", T_RECURSIVELY);
field("packageManager", T_NONE);
field("pnpm", T_NONE);

const FIELD_NAMES: Uint8Array[] = [];
for (let i = 0; i < FIELDS.length; i++) FIELD_NAMES.push(asciiBytes(FIELDS[i].name));

/** A stable sort of `a` by `cmp` (insertion sort: objects are small). */
function stableSort(a: number[], keys: Uint8Array[]): void {
  for (let i = 1; i < a.length; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= 0 && compareBytes(keys[a[j]], keys[v]) > 0) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = v;
  }
}

/** Sorts the entries of `object` by name (stable). */
function sortByKey(object: Value): void {
  const idx: number[] = [];
  for (let i = 0; i < object.keys.length; i++) idx.push(i);
  stableSort(idx, object.keys);
  const keys: Uint8Array[] = [];
  const vals: Value[] = [];
  for (let i = 0; i < idx.length; i++) {
    keys.push(object.keys[idx[i]]);
    vals.push(object.vals[idx[i]]);
  }
  object.keys = keys;
  object.vals = vals;
}

function sortRecursively(object: Value): void {
  for (let i = 0; i < object.vals.length; i++) if (object.vals[i].kind === V_OBJECT) sortRecursively(object.vals[i]);
  sortByKey(object);
}

function sortByKeyOrder(object: Value, order: string[]): void {
  const knownKeys: (Uint8Array | null)[] = [];
  const knownVals: (Value | null)[] = [];
  for (let i = 0; i < order.length; i++) {
    knownKeys.push(null);
    knownVals.push(null);
  }
  const rest = new Value(V_OBJECT);
  for (let i = 0; i < object.keys.length; i++) {
    let slot = -1;
    for (let k = 0; k < order.length; k++) {
      if (bytesEqual(asciiBytes(order[k]), object.keys[i])) {
        slot = k;
        break;
      }
    }
    if (slot >= 0) {
      knownKeys[slot] = object.keys[i];
      knownVals[slot] = object.vals[i];
    } else {
      rest.keys.push(object.keys[i]);
      rest.vals.push(object.vals[i]);
    }
  }
  sortByKey(rest);
  const keys: Uint8Array[] = [];
  const vals: Value[] = [];
  for (let k = 0; k < order.length; k++) {
    const key = knownKeys[k];
    const val = knownVals[k];
    if (key !== null && val !== null) {
      keys.push(key);
      vals.push(val);
    }
  }
  for (let i = 0; i < rest.keys.length; i++) {
    keys.push(rest.keys[i]);
    vals.push(rest.vals[i]);
  }
  object.keys = keys;
  object.vals = vals;
}

function transform(value: Value, kind: number, order: string[], sortScripts: boolean): void {
  if (value.kind === V_OBJECT) {
    switch (kind) {
      case T_SCRIPTS:
        if (sortScripts) sortByKey(value);
        return;
      case T_ALPHABETICALLY:
        sortByKey(value);
        return;
      case T_RECURSIVELY:
        sortRecursively(value);
        return;
      case T_KEY_ORDER:
        sortByKeyOrder(value, order);
        return;
      case T_FIELDS:
        sortFields(value, sortScripts);
        return;
      case T_DEV_ENGINES:
        for (let i = 0; i < value.vals.length; i++) {
          const v = value.vals[i];
          if (v.kind === V_ARRAY) {
            for (let k = 0; k < v.items.length; k++) transform(v.items[k], T_KEY_ORDER, DEV_ENGINE, sortScripts);
          } else {
            transform(v, T_KEY_ORDER, DEV_ENGINE, sortScripts);
          }
        }
        sortByKey(value);
        return;
      default:
        return;
    }
  }
  if (value.kind === V_ARRAY) {
    if (kind === T_SORTED_UNIQUE) {
      // The strings are kept, sorted, each once.
      const strings: Value[] = [];
      for (let i = 0; i < value.items.length; i++) if (value.items[i].kind === V_STRING) strings.push(value.items[i]);
      const keys: Uint8Array[] = [];
      for (let i = 0; i < strings.length; i++) keys.push(strings[i].bytes);
      const idx: number[] = [];
      for (let i = 0; i < strings.length; i++) idx.push(i);
      stableSort(idx, keys);
      const out: Value[] = [];
      for (let i = 0; i < idx.length; i++) {
        const s = strings[idx[i]];
        if (out.length > 0 && bytesEqual(out[out.length - 1].bytes, s.bytes)) continue;
        out.push(s);
      }
      value.items = out;
    } else if (kind === T_UNIQUE) {
      const out: Value[] = [];
      for (let i = 0; i < value.items.length; i++) {
        const v = value.items[i];
        if (v.kind !== V_STRING) continue;
        let seen = false;
        for (let k = 0; k < out.length; k++) {
          if (bytesEqual(out[k].bytes, v.bytes)) {
            seen = true;
            break;
          }
        }
        if (!seen) out.push(v);
      }
      value.items = out;
    }
  }
}

/** The known fields in their order, then the others by name, those that start with `_` last. */
function sortFields(object: Value, sortScripts: boolean): void {
  const knownIdx: number[] = [];
  const knownField: number[] = [];
  const unknown: number[] = [];
  for (let i = 0; i < object.keys.length; i++) {
    let f = -1;
    for (let k = 0; k < FIELD_NAMES.length; k++) {
      if (bytesEqual(FIELD_NAMES[k], object.keys[i])) {
        f = k;
        break;
      }
    }
    if (f >= 0) {
      transform(object.vals[i], FIELDS[f].transform, FIELDS[f].order, sortScripts);
      knownIdx.push(i);
      knownField.push(f);
    } else {
      unknown.push(i);
    }
  }
  // Stable by the place in the table.
  for (let i = 1; i < knownIdx.length; i++) {
    const vi = knownIdx[i];
    const vf = knownField[i];
    let j = i - 1;
    while (j >= 0 && knownField[j] > vf) {
      knownIdx[j + 1] = knownIdx[j];
      knownField[j + 1] = knownField[j];
      j--;
    }
    knownIdx[j + 1] = vi;
    knownField[j + 1] = vf;
  }
  for (let i = 1; i < unknown.length; i++) {
    const v = unknown[i];
    let j = i - 1;
    while (j >= 0 && compareUnknown(object.keys[unknown[j]], object.keys[v]) > 0) {
      unknown[j + 1] = unknown[j];
      j--;
    }
    unknown[j + 1] = v;
  }
  const keys: Uint8Array[] = [];
  const vals: Value[] = [];
  for (let i = 0; i < knownIdx.length; i++) {
    keys.push(object.keys[knownIdx[i]]);
    vals.push(object.vals[knownIdx[i]]);
  }
  for (let i = 0; i < unknown.length; i++) {
    keys.push(object.keys[unknown[i]]);
    vals.push(object.vals[unknown[i]]);
  }
  object.keys = keys;
  object.vals = vals;
}

function compareUnknown(a: Uint8Array, b: Uint8Array): number {
  const ua = startsWithByte(a, 95);
  const ub = startsWithByte(b, 95);
  if (ua !== ub) return ua ? 1 : -1;
  return compareBytes(a, b);
}

/**
 * Appends text[0, len) with its fields sorted to `out`, on one line. Returns false, and appends nothing, if the text is not
 * JSON in the strict sense: it is formatted as it is then.
 */
export function sortPackageJson(src: Uint8Array, len: number, sortScripts: boolean, out: ByteBuf): boolean {
  const text = len === src.length ? src : src.subarray(0, len);
  const bom = startsWithBom(text, 0) ? 3 : 0;
  const body = bom > 0 ? text.subarray(bom) : text;
  const reader = new Reader(body);
  const value = reader.value(0);
  if (value === null) return false;
  reader.skipWhitespace();
  if (reader.at !== body.length) return false;
  if (value.kind === V_OBJECT) sortFields(value, sortScripts);
  out.reserve(len);
  out.append(text, 0, bom);
  writeValue(value, out);
  return true;
}
