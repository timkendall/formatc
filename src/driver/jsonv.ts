// A JSON value and the readers of the configuration notations: JSON (lenient: comments, trailing commas, JSON5 forms),
// a subset of YAML, and TOML. Used for `.prettierrc*`, `package.json`, `.oxfmtrc.json` and `bunfig.toml`.

export const J_NULL = 0;
export const J_BOOL = 1;
export const J_NUM = 2;
export const J_STR = 3;
export const J_ARR = 4;
export const J_OBJ = 5;

export class JV {
  kind: number;
  b: boolean;
  n: number;
  s: string;
  items: JV[];
  keys: string[];
  // Where each key starts in the text (for diagnostics): parallel to `keys`.
  keyAts: number[];
  // Where the value starts in the text (for diagnostics).
  at: number;
  constructor(kind: number) {
    this.kind = kind;
    this.b = false;
    this.n = 0;
    this.s = "";
    this.items = [];
    this.keys = [];
    this.keyAts = [];
    this.at = 0;
  }
  static nul(): JV {
    return new JV(J_NULL);
  }
  static bool(b: boolean): JV {
    const v = new JV(J_BOOL);
    v.b = b;
    return v;
  }
  static num(n: number): JV {
    const v = new JV(J_NUM);
    v.n = n;
    return v;
  }
  static str(s: string): JV {
    const v = new JV(J_STR);
    v.s = s;
    return v;
  }
  static arr(): JV {
    return new JV(J_ARR);
  }
  static obj(): JV {
    return new JV(J_OBJ);
  }
  isObject(): boolean {
    return this.kind === J_OBJ;
  }
  isArray(): boolean {
    return this.kind === J_ARR;
  }
  isString(): boolean {
    return this.kind === J_STR;
  }
  // The value of an object key (the last one), or null.
  get(key: string): JV | null {
    if (this.kind !== J_OBJ) return null;
    for (let i = this.keys.length - 1; i >= 0; i--) {
      if (this.keys[i] === key) return this.items[i];
    }
    return null;
  }
  // Sets a key (replacing an earlier one in place).
  set(key: string, v: JV): void {
    this.setAt(key, v, -1);
  }
  setAt(key: string, v: JV, keyAt: number): void {
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i] === key) {
        this.items[i] = v;
        return;
      }
    }
    this.keys.push(key);
    this.keyAts.push(keyAt);
    this.items.push(v);
  }
  push(v: JV): void {
    this.items.push(v);
  }
}

export function numberToText(n: number): string {
  if (n !== n) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  return String(n);
}

function quoteJson(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += "\\\\";
    else if (c === 10) out += "\\n";
    else if (c === 13) out += "\\r";
    else if (c === 9) out += "\\t";
    else if (c < 32) out += "\\u" + (c + 0x10000).toString(16).substring(1);
    else out += s.charAt(i);
  }
  return out + '"';
}

// Compact JSON text of a value.
export function toJsonText(v: JV): string {
  if (v.kind === J_NULL) return "null";
  if (v.kind === J_BOOL) return v.b ? "true" : "false";
  if (v.kind === J_NUM) return numberToText(v.n);
  if (v.kind === J_STR) return quoteJson(v.s);
  if (v.kind === J_ARR) {
    let out = "[";
    for (let i = 0; i < v.items.length; i++) {
      if (i > 0) out += ",";
      out += toJsonText(v.items[i]);
    }
    return out + "]";
  }
  let out = "{";
  for (let i = 0; i < v.items.length; i++) {
    if (i > 0) out += ",";
    out += quoteJson(v.keys[i]) + ":" + toJsonText(v.items[i]);
  }
  return out + "}";
}

// ---- JSON (lenient) ----

class JsonParser {
  s: string;
  i: number;
  n: number;
  err: string;
  errAt: number;
  constructor(s: string) {
    this.s = s;
    this.i = 0;
    this.n = s.length;
    this.err = "";
    this.errAt = 0;
  }
  fail(msg: string): JV | null {
    if (this.err === "") {
      this.err = msg;
      this.errAt = this.i;
    }
    return null;
  }
  skip(): boolean {
    const s = this.s;
    while (this.i < this.n) {
      const c = s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 11 || c === 12) {
        this.i = this.i + 1;
      } else if (c === 47 && this.i + 1 < this.n && s.charCodeAt(this.i + 1) === 47) {
        while (this.i < this.n && s.charCodeAt(this.i) !== 10) this.i = this.i + 1;
      } else if (c === 47 && this.i + 1 < this.n && s.charCodeAt(this.i + 1) === 42) {
        const e = s.indexOf("*/", this.i + 2);
        if (e < 0) {
          this.i = this.n;
          this.fail("Unterminated comment");
          return false;
        }
        this.i = e + 2;
      } else {
        break;
      }
    }
    return true;
  }
  value(depth: number): JV | null {
    if (depth > 512) return this.fail("Nested too deeply");
    if (!this.skip()) return null;
    if (this.i >= this.n) return this.fail("Unexpected end of file");
    const s = this.s;
    const c = s.charCodeAt(this.i);
    const start = this.i;
    let out: JV | null = null;
    if (c === 123) out = this.object(depth);
    else if (c === 91) out = this.array(depth);
    else if (c === 34 || c === 39) {
      const str = this.string();
      if (str === null) return null;
      out = JV.str(str);
    } else if (c === 45 || c === 43 || c === 46 || (c >= 48 && c <= 57)) out = this.number();
    else {
      const word = this.word();
      if (word === "true") out = JV.bool(true);
      else if (word === "false") out = JV.bool(false);
      else if (word === "null") out = JV.nul();
      else if (word === "Infinity") out = JV.num(Infinity);
      else if (word === "NaN") out = JV.num(NaN);
      else return this.fail("Unexpected token");
    }
    if (out !== null) out.at = start;
    return out;
  }
  word(): string {
    const s = this.s;
    const st = this.i;
    while (this.i < this.n) {
      const c = s.charCodeAt(this.i);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127) this.i = this.i + 1;
      else break;
    }
    return s.substring(st, this.i);
  }
  number(): JV | null {
    const s = this.s;
    const st = this.i;
    let neg = false;
    if (s.charCodeAt(this.i) === 45) {
      neg = true;
      this.i = this.i + 1;
    } else if (s.charCodeAt(this.i) === 43) this.i = this.i + 1;
    if (s.startsWith("Infinity", this.i)) {
      this.i = this.i + 8;
      return JV.num(neg ? -Infinity : Infinity);
    }
    if (s.startsWith("NaN", this.i)) {
      this.i = this.i + 3;
      return JV.num(NaN);
    }
    if (s.charCodeAt(this.i) === 48 && (s.charCodeAt(this.i + 1) === 120 || s.charCodeAt(this.i + 1) === 88)) {
      this.i = this.i + 2;
      const hs = this.i;
      while (this.i < this.n && /[0-9a-fA-F]/.test(s.charAt(this.i))) this.i = this.i + 1;
      if (this.i === hs) return this.fail("Unexpected token");
      const v = parseInt(s.substring(hs, this.i), 16);
      return JV.num(neg ? -v : v);
    }
    while (this.i < this.n) {
      const c = s.charCodeAt(this.i);
      if ((c >= 48 && c <= 57) || c === 46 || c === 101 || c === 69 || ((c === 43 || c === 45) && (s.charCodeAt(this.i - 1) === 101 || s.charCodeAt(this.i - 1) === 69))) this.i = this.i + 1;
      else break;
    }
    const text = s.substring(st, this.i);
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return this.fail("Unexpected token");
    return JV.num(Number(text));
  }
  string(): string | null {
    const s = this.s;
    const q = s.charCodeAt(this.i);
    this.i = this.i + 1;
    let out = "";
    let from = this.i;
    while (true) {
      if (this.i >= this.n) {
        this.fail("Unterminated string");
        return null;
      }
      const c = s.charCodeAt(this.i);
      if (c === q) {
        out += s.substring(from, this.i);
        this.i = this.i + 1;
        return out;
      }
      if (c === 92) {
        out += s.substring(from, this.i);
        const e = s.charCodeAt(this.i + 1);
        this.i = this.i + 2;
        if (e === 110) out += "\n";
        else if (e === 116) out += "\t";
        else if (e === 114) out += "\r";
        else if (e === 98) out += "\b";
        else if (e === 102) out += "\f";
        else if (e === 118) out += "\v";
        else if (e === 48) out += "\0";
        else if (e === 117) {
          const h = s.substring(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) {
            this.fail("Invalid escape");
            return null;
          }
          out += String.fromCharCode(parseInt(h, 16));
          this.i = this.i + 4;
        } else if (e === 120) {
          const h = s.substring(this.i, this.i + 2);
          out += String.fromCharCode(parseInt(h, 16));
          this.i = this.i + 2;
        } else if (e === 13 || e === 10) {
          if (e === 13 && s.charCodeAt(this.i) === 10) this.i = this.i + 1;
        } else out += s.charAt(this.i - 1);
        from = this.i;
        continue;
      }
      if (c === 10) {
        this.fail("Unterminated string");
        return null;
      }
      this.i = this.i + 1;
    }
  }
  array(depth: number): JV | null {
    const out = JV.arr();
    this.i = this.i + 1;
    while (true) {
      if (!this.skip()) return null;
      if (this.i >= this.n) return this.fail("Unexpected end of file");
      if (this.s.charCodeAt(this.i) === 93) {
        this.i = this.i + 1;
        return out;
      }
      const v = this.value(depth + 1);
      if (v === null) return null;
      out.items.push(v);
      if (!this.skip()) return null;
      const c = this.s.charCodeAt(this.i);
      if (c === 44) this.i = this.i + 1;
      else if (c === 93) {
        this.i = this.i + 1;
        return out;
      } else return this.fail("Expected ',' or ']'");
    }
  }
  object(depth: number): JV | null {
    const out = JV.obj();
    this.i = this.i + 1;
    while (true) {
      if (!this.skip()) return null;
      if (this.i >= this.n) return this.fail("Unexpected end of file");
      const c = this.s.charCodeAt(this.i);
      if (c === 125) {
        this.i = this.i + 1;
        return out;
      }
      let key: string;
      if (c === 34 || c === 39) {
        const k = this.string();
        if (k === null) return null;
        key = k;
      } else {
        key = this.word();
        if (key.length === 0) return this.fail("Expected a property name");
      }
      if (!this.skip()) return null;
      if (this.s.charCodeAt(this.i) !== 58) return this.fail("Expected ':'");
      this.i = this.i + 1;
      const v = this.value(depth + 1);
      if (v === null) return null;
      out.set(key, v);
      if (!this.skip()) return null;
      const d = this.s.charCodeAt(this.i);
      if (d === 44) this.i = this.i + 1;
      else if (d === 125) {
        this.i = this.i + 1;
        return out;
      } else return this.fail("Expected ',' or '}'");
    }
  }
}

export let jsonError = "";
export let jsonErrorAt = 0;

// Parses JSON with comments and trailing commas. null on an error (the message is in `jsonError`).
export function parseJson(text: string): JV | null {
  const p = new JsonParser(text);
  const v = p.value(0);
  if (v === null) {
    jsonError = p.err;
    jsonErrorAt = p.errAt;
    return null;
  }
  p.skip();
  if (p.i < p.n) {
    jsonError = "Unexpected token";
    jsonErrorAt = p.i;
    return null;
  }
  return v;
}

// ---- YAML (a subset: block and flow collections, plain/quoted scalars, comments) ----

class YLine {
  indent: number;
  text: string; // without the indent and without a trailing comment
  raw: string;
  no: number;
  constructor(indent: number, text: string, raw: string, no: number) {
    this.indent = indent;
    this.text = text;
    this.raw = raw;
    this.no = no;
  }
}

export let yamlError = "";

function stripComment(s: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 39 && !inD) inS = !inS;
    else if (c === 34 && !inS) {
      if (!(i > 0 && s.charCodeAt(i - 1) === 92 && inD)) inD = !inD;
    } else if (c === 35 && !inS && !inD && (i === 0 || s.charCodeAt(i - 1) === 32 || s.charCodeAt(i - 1) === 9)) {
      return s.substring(0, i).replace(/[ \t]+$/, "");
    }
  }
  return s.replace(/[ \t]+$/, "");
}

class YamlParser {
  lines: YLine[];
  pos: number;
  err: string;
  constructor(text: string) {
    this.lines = [];
    this.pos = 0;
    this.err = "";
    if (text.charCodeAt(0) === 0xfeff) text = text.substring(1);
    const raw = text.split(/\r\n|\n|\r/);
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      let ind = 0;
      while (ind < r.length && r.charCodeAt(ind) === 32) ind = ind + 1;
      const body = r.substring(ind);
      this.lines.push(new YLine(ind, stripComment(body), r, i + 1));
    }
  }
  skipBlank(): void {
    while (this.pos < this.lines.length) {
      const l = this.lines[this.pos];
      if (l.text.length === 0 || l.text === "---") {
        this.pos = this.pos + 1;
      } else if (l.text === "...") {
        this.pos = this.lines.length;
      } else break;
    }
  }
  fail(msg: string): JV | null {
    if (this.err === "") this.err = msg + " at line " + (this.pos < this.lines.length ? this.lines[this.pos].no : this.lines.length);
    return null;
  }
  document(): JV | null {
    this.skipBlank();
    if (this.pos >= this.lines.length) return JV.nul();
    const l = this.lines[this.pos];
    const v = this.node(l.indent);
    if (v === null) return null;
    this.skipBlank();
    if (this.pos < this.lines.length) return this.fail("Unexpected content");
    return v;
  }
  // A node at the indentation `indent` (or more).
  node(indent: number): JV | null {
    this.skipBlank();
    if (this.pos >= this.lines.length) return JV.nul();
    const l = this.lines[this.pos];
    if (l.indent < indent) return JV.nul();
    if (l.text.startsWith("- ") || l.text === "-") return this.sequence(l.indent);
    if (this.isMappingLine(l.text)) return this.mapping(l.indent);
    // a scalar or flow collection, maybe over several lines
    this.pos = this.pos + 1;
    return this.scalarOrFlow(l.text, l.indent);
  }
  isMappingLine(t: string): boolean {
    return this.keyEnd(t) >= 0;
  }
  // Index of the `:` that ends the key of a mapping entry, or -1.
  keyEnd(t: string): number {
    if (t.length === 0) return -1;
    const c0 = t.charCodeAt(0);
    if (c0 === 34 || c0 === 39) {
      let i = 1;
      while (i < t.length) {
        const c = t.charCodeAt(i);
        if (c === 92 && c0 === 34) {
          i = i + 2;
          continue;
        }
        if (c === c0) {
          if (c0 === 39 && t.charCodeAt(i + 1) === 39) {
            i = i + 2;
            continue;
          }
          break;
        }
        i = i + 1;
      }
      let j = i + 1;
      while (j < t.length && t.charCodeAt(j) === 32) j = j + 1;
      if (t.charCodeAt(j) === 58 && (j + 1 >= t.length || t.charCodeAt(j + 1) === 32)) return j;
      return -1;
    }
    if (c0 === 91 || c0 === 123) return -1;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c === 58 && (i + 1 >= t.length || t.charCodeAt(i + 1) === 32)) return i;
    }
    return -1;
  }
  key(t: string, e: number): string {
    const k = t.substring(0, e).replace(/[ \t]+$/, "");
    const c0 = k.charCodeAt(0);
    if (c0 === 34 || c0 === 39) {
      const v = this.quoted(k, 0);
      if (v !== null) return v.text;
    }
    return k;
  }
  quoted(t: string, at: number): { text: string; end: number } | null {
    const q = t.charCodeAt(at);
    let out = "";
    let i = at + 1;
    while (i < t.length) {
      const c = t.charCodeAt(i);
      if (q === 34 && c === 92) {
        const e = t.charCodeAt(i + 1);
        i = i + 2;
        if (e === 110) out += "\n";
        else if (e === 116) out += "\t";
        else if (e === 114) out += "\r";
        else if (e === 48) out += "\0";
        else if (e === 117) {
          out += String.fromCharCode(parseInt(t.substring(i, i + 4), 16));
          i = i + 4;
        } else if (e === 120) {
          out += String.fromCharCode(parseInt(t.substring(i, i + 2), 16));
          i = i + 2;
        } else out += t.charAt(i - 1);
        continue;
      }
      if (c === q) {
        if (q === 39 && t.charCodeAt(i + 1) === 39) {
          out += "'";
          i = i + 2;
          continue;
        }
        return { text: out, end: i + 1 };
      }
      out += t.charAt(i);
      i = i + 1;
    }
    return null;
  }
  mapping(indent: number): JV | null {
    const out = JV.obj();
    while (true) {
      this.skipBlank();
      if (this.pos >= this.lines.length) break;
      const l = this.lines[this.pos];
      if (l.indent < indent) break;
      if (l.indent > indent) return this.fail("Bad indentation of a mapping entry");
      const e = this.keyEnd(l.text);
      if (e < 0) return this.fail("Implicit map keys need to be followed by map values");
      const key = this.key(l.text, e);
      const rest = l.text.substring(e + 1).replace(/^[ \t]+/, "");
      this.pos = this.pos + 1;
      let value: JV | null;
      if (rest.length === 0) {
        // nested block or null; a sequence may sit at the same indentation
        this.skipBlank();
        if (this.pos < this.lines.length) {
          const nl = this.lines[this.pos];
          if (nl.indent > indent) value = this.node(nl.indent);
          else if (nl.indent === indent && (nl.text.startsWith("- ") || nl.text === "-")) value = this.sequence(indent);
          else value = JV.nul();
        } else value = JV.nul();
      } else if (rest === "|" || rest === ">" || rest.startsWith("|-") || rest.startsWith(">-") || rest.startsWith("|+") || rest.startsWith(">+")) {
        value = this.blockScalar(rest, indent);
      } else {
        value = this.scalarOrFlow(rest, indent);
      }
      if (value === null) return null;
      if (out.get(key) !== null) {
        this.err = "Map keys must be unique at line " + l.no + ", column " + (l.indent + 1) + ":";
        return null;
      }
      out.set(key, value);
    }
    return out;
  }
  sequence(indent: number): JV | null {
    const out = JV.arr();
    while (true) {
      this.skipBlank();
      if (this.pos >= this.lines.length) break;
      const l = this.lines[this.pos];
      if (l.indent < indent) break;
      if (l.indent > indent) return this.fail("Bad indentation of a sequence entry");
      if (!(l.text.startsWith("- ") || l.text === "-")) break;
      const rest = l.text.length > 1 ? l.text.substring(2).replace(/^[ \t]+/, "") : "";
      if (rest.length === 0) {
        this.pos = this.pos + 1;
        this.skipBlank();
        if (this.pos < this.lines.length && this.lines[this.pos].indent > indent) {
          const v = this.node(this.lines[this.pos].indent);
          if (v === null) return null;
          out.push(v);
        } else out.push(JV.nul());
        continue;
      }
      // `- key: value` opens a mapping whose indentation is that of `key`
      const innerIndent = indent + (l.text.length - rest.length);
      if (this.isMappingLine(rest) || rest.startsWith("- ")) {
        // rewrite this line as the first line of a nested block
        this.lines[this.pos] = new YLine(innerIndent, rest, l.raw, l.no);
        const v = this.node(innerIndent);
        if (v === null) return null;
        out.push(v);
      } else {
        this.pos = this.pos + 1;
        const v = this.scalarOrFlow(rest, indent);
        if (v === null) return null;
        out.push(v);
      }
    }
    return out;
  }
  blockScalar(header: string, indent: number): JV | null {
    const lines: string[] = [];
    let blockIndent = -1;
    while (this.pos < this.lines.length) {
      const l = this.lines[this.pos];
      if (l.raw.trim().length === 0) {
        lines.push("");
        this.pos = this.pos + 1;
        continue;
      }
      let ind = 0;
      while (ind < l.raw.length && l.raw.charCodeAt(ind) === 32) ind = ind + 1;
      if (ind <= indent) break;
      if (blockIndent < 0) blockIndent = ind;
      if (ind < blockIndent) break;
      lines.push(l.raw.substring(blockIndent));
      this.pos = this.pos + 1;
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    let text: string;
    if (header.charCodeAt(0) === 62) text = lines.join(" ");
    else text = lines.join("\n");
    if (!header.includes("-")) text += "\n";
    return JV.str(text);
  }
  // A scalar or a flow collection that starts with `t` (which may continue on the next lines).
  scalarOrFlow(t: string, indent: number): JV | null {
    const c0 = t.charCodeAt(0);
    if (c0 === 91 || c0 === 123) {
      let text = t;
      while (!flowBalanced(text) && this.pos < this.lines.length) {
        text += " " + this.lines[this.pos].text;
        this.pos = this.pos + 1;
      }
      const fp = new FlowParser(text);
      const v = fp.value();
      if (v === null) {
        this.err = fp.err;
        return null;
      }
      fp.ws();
      if (fp.i < fp.s.length) {
        this.err = "Unexpected content after a flow collection";
        return null;
      }
      return v;
    }
    if (c0 === 34 || c0 === 39) {
      let text = t;
      let q = this.quoted(text, 0);
      while (q === null && this.pos < this.lines.length) {
        text += " " + this.lines[this.pos].text;
        this.pos = this.pos + 1;
        q = this.quoted(text, 0);
      }
      if (q === null) return this.fail("Missing closing quote");
      return JV.str(q.text);
    }
    if (c0 === 38 || c0 === 42 || c0 === 33) {
      // anchors, aliases and tags
      this.err = "Anchors, aliases and tags are not supported";
      return null;
    }
    // a plain scalar may continue on more-indented lines
    let text = t;
    while (this.pos < this.lines.length) {
      const nl = this.lines[this.pos];
      if (nl.text.length === 0 || nl.indent <= indent || this.isMappingLine(nl.text)) break;
      text += " " + nl.text;
      this.pos = this.pos + 1;
    }
    return plainScalar(text);
  }
}

function flowBalanced(t: string): boolean {
  let depth = 0;
  let inS = false;
  let inD = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (inD) {
      if (c === 92) i = i + 1;
      else if (c === 34) inD = false;
    } else if (inS) {
      if (c === 39) inS = false;
    } else if (c === 34) inD = true;
    else if (c === 39) inS = true;
    else if (c === 91 || c === 123) depth = depth + 1;
    else if (c === 93 || c === 125) depth = depth - 1;
  }
  return depth <= 0;
}

export function plainScalar(t: string): JV {
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return JV.nul();
  if (t === "true" || t === "True" || t === "TRUE") return JV.bool(true);
  if (t === "false" || t === "False" || t === "FALSE") return JV.bool(false);
  if (/^[-+]?[0-9]+$/.test(t)) return JV.num(Number(t));
  if (/^0x[0-9a-fA-F]+$/.test(t)) return JV.num(parseInt(t.substring(2), 16));
  if (/^0o[0-7]+$/.test(t)) return JV.num(parseInt(t.substring(2), 8));
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(t)) return JV.num(Number(t));
  if (t === ".inf" || t === ".Inf" || t === ".INF" || t === "+.inf") return JV.num(Infinity);
  if (t === "-.inf" || t === "-.Inf" || t === "-.INF") return JV.num(-Infinity);
  if (t === ".nan" || t === ".NaN" || t === ".NAN") return JV.num(NaN);
  return JV.str(t);
}

class FlowParser {
  s: string;
  i: number;
  err: string;
  constructor(s: string) {
    this.s = s;
    this.i = 0;
    this.err = "";
  }
  ws(): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (c === 32 || c === 9) this.i = this.i + 1;
      else break;
    }
  }
  value(): JV | null {
    this.ws();
    const c = this.s.charCodeAt(this.i);
    if (c === 91) {
      this.i = this.i + 1;
      const out = JV.arr();
      while (true) {
        this.ws();
        if (this.i >= this.s.length) {
          this.err = "Unterminated flow sequence";
          return null;
        }
        if (this.s.charCodeAt(this.i) === 93) {
          this.i = this.i + 1;
          return out;
        }
        const v = this.value();
        if (v === null) return null;
        out.push(v);
        this.ws();
        const d = this.s.charCodeAt(this.i);
        if (d === 44) this.i = this.i + 1;
        else if (d !== 93) {
          this.err = "Unexpected token in a flow sequence";
          return null;
        }
      }
    }
    if (c === 123) {
      this.i = this.i + 1;
      const out = JV.obj();
      while (true) {
        this.ws();
        if (this.i >= this.s.length) {
          this.err = "Unterminated flow mapping";
          return null;
        }
        if (this.s.charCodeAt(this.i) === 125) {
          this.i = this.i + 1;
          return out;
        }
        const k = this.scalarText(true);
        if (k === null) return null;
        this.ws();
        let v: JV;
        if (this.s.charCodeAt(this.i) === 58) {
          this.i = this.i + 1;
          const vv = this.value();
          if (vv === null) return null;
          v = vv;
        } else v = JV.nul();
        out.set(k.text, v);
        this.ws();
        const d = this.s.charCodeAt(this.i);
        if (d === 44) this.i = this.i + 1;
        else if (d !== 125) {
          this.err = "Unexpected token in a flow mapping";
          return null;
        }
      }
    }
    const t = this.scalarText(false);
    if (t === null) return null;
    if (t.quoted) return JV.str(t.text);
    return plainScalar(t.text);
  }
  scalarText(isKey: boolean): { text: string; quoted: boolean } | null {
    this.ws();
    const c = this.s.charCodeAt(this.i);
    if (c === 34 || c === 39) {
      let out = "";
      const q = c;
      let i = this.i + 1;
      while (i < this.s.length) {
        const d = this.s.charCodeAt(i);
        if (q === 34 && d === 92) {
          const e = this.s.charCodeAt(i + 1);
          i = i + 2;
          if (e === 110) out += "\n";
          else if (e === 116) out += "\t";
          else out += this.s.charAt(i - 1);
          continue;
        }
        if (d === q) {
          if (q === 39 && this.s.charCodeAt(i + 1) === 39) {
            out += "'";
            i = i + 2;
            continue;
          }
          this.i = i + 1;
          return { text: out, quoted: true };
        }
        out += this.s.charAt(i);
        i = i + 1;
      }
      this.err = "Missing closing quote";
      return null;
    }
    const st = this.i;
    while (this.i < this.s.length) {
      const d = this.s.charCodeAt(this.i);
      if (d === 44 || d === 93 || d === 125) break;
      if (d === 58 && (isKey || true) && (this.i + 1 >= this.s.length || this.s.charCodeAt(this.i + 1) === 32 || this.s.charCodeAt(this.i + 1) === 44)) break;
      if (d === 91 || d === 123) break;
      this.i = this.i + 1;
    }
    return { text: this.s.substring(st, this.i).replace(/[ \t]+$/, ""), quoted: false };
  }
}

// Parses the YAML subset. null on an error (the message is in `yamlError`).
export function parseYaml(text: string): JV | null {
  const p = new YamlParser(text);
  const v = p.document();
  if (v === null) {
    yamlError = p.err;
    return null;
  }
  return v;
}

// ---- TOML ----

export let tomlError = "";
export let tomlErrorLine = 0;
export let tomlErrorColumn = 0;

class TomlParser {
  s: string;
  i: number;
  n: number;
  err: string;
  errAt: number;
  constructor(s: string) {
    this.s = s;
    this.i = 0;
    this.n = s.length;
    this.err = "";
    this.errAt = 0;
  }
  fail(msg: string): boolean {
    if (this.err === "") {
      this.err = msg;
      this.errAt = this.i;
    }
    return false;
  }
  skipSpace(): void {
    while (this.i < this.n) {
      const c = this.s.charCodeAt(this.i);
      if (c === 32 || c === 9) this.i = this.i + 1;
      else break;
    }
  }
  skipComment(): void {
    if (this.i < this.n && this.s.charCodeAt(this.i) === 35) {
      while (this.i < this.n && this.s.charCodeAt(this.i) !== 10) this.i = this.i + 1;
    }
  }
  skipWsLines(): void {
    while (this.i < this.n) {
      const c = this.s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.i = this.i + 1;
      else if (c === 35) this.skipComment();
      else break;
    }
  }
  lastKeyAt = 0;
  parseKey(): string[] | null {
    const parts: string[] = [];
    while (true) {
      this.skipSpace();
      this.lastKeyAt = this.i;
      const c = this.s.charCodeAt(this.i);
      if (c === 34 || c === 39) {
        const str = this.str();
        if (str === null) return null;
        parts.push(str);
      } else {
        const st = this.i;
        while (this.i < this.n) {
          const d = this.s.charCodeAt(this.i);
          if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95 || d === 45) this.i = this.i + 1;
          else break;
        }
        if (this.i === st) {
          this.fail("Expected a key");
          return null;
        }
        parts.push(this.s.substring(st, this.i));
      }
      this.skipSpace();
      if (this.s.charCodeAt(this.i) === 46) {
        this.i = this.i + 1;
        continue;
      }
      return parts;
    }
  }
  str(): string | null {
    const s = this.s;
    const q = s.charCodeAt(this.i);
    const triple = s.startsWith(q === 34 ? '"""' : "'''", this.i);
    if (triple) {
      this.i = this.i + 3;
      if (s.charCodeAt(this.i) === 13) this.i = this.i + 1;
      if (s.charCodeAt(this.i) === 10) this.i = this.i + 1;
      let out = "";
      while (this.i < this.n) {
        if (s.startsWith(q === 34 ? '"""' : "'''", this.i)) {
          let extra = 0;
          while (s.charCodeAt(this.i + 3 + extra) === q && extra < 2) extra = extra + 1;
          out += s.substring(this.i, this.i + extra);
          this.i = this.i + 3 + extra;
          return out;
        }
        const c = s.charCodeAt(this.i);
        if (q === 34 && c === 92) {
          const e = s.charCodeAt(this.i + 1);
          if (e === 10 || e === 13 || e === 32 || e === 9) {
            this.i = this.i + 1;
            while (this.i < this.n && /[ \t\r\n]/.test(s.charAt(this.i))) this.i = this.i + 1;
            continue;
          }
          const r = this.escape();
          if (r === null) return null;
          out += r;
          continue;
        }
        out += s.charAt(this.i);
        this.i = this.i + 1;
      }
      this.fail("Unterminated string");
      return null;
    }
    this.i = this.i + 1;
    let out = "";
    while (this.i < this.n) {
      const c = s.charCodeAt(this.i);
      if (c === q) {
        this.i = this.i + 1;
        return out;
      }
      if (c === 10) break;
      if (q === 34 && c === 92) {
        const r = this.escape();
        if (r === null) return null;
        out += r;
        continue;
      }
      out += s.charAt(this.i);
      this.i = this.i + 1;
    }
    this.fail("Unterminated string");
    return null;
  }
  escape(): string | null {
    const s = this.s;
    const e = s.charCodeAt(this.i + 1);
    this.i = this.i + 2;
    if (e === 110) return "\n";
    if (e === 116) return "\t";
    if (e === 114) return "\r";
    if (e === 98) return "\b";
    if (e === 102) return "\f";
    if (e === 34) return '"';
    if (e === 92) return "\\";
    if (e === 117 || e === 85) {
      const len = e === 117 ? 4 : 8;
      const h = s.substring(this.i, this.i + len);
      this.i = this.i + len;
      return String.fromCodePoint(parseInt(h, 16));
    }
    this.fail("Invalid escape sequence");
    return null;
  }
  value(): JV | null {
    this.skipSpace();
    const s = this.s;
    const c = s.charCodeAt(this.i);
    const st = this.i;
    let out: JV | null = null;
    if (c === 34 || c === 39) {
      const str = this.str();
      if (str === null) return null;
      out = JV.str(str);
    } else if (c === 91) {
      this.i = this.i + 1;
      const arr = JV.arr();
      while (true) {
        this.skipWsLines();
        if (this.i >= this.n) {
          this.fail("Unterminated array");
          return null;
        }
        if (s.charCodeAt(this.i) === 93) {
          this.i = this.i + 1;
          break;
        }
        const v = this.value();
        if (v === null) return null;
        arr.push(v);
        this.skipWsLines();
        const d = s.charCodeAt(this.i);
        if (d === 44) this.i = this.i + 1;
        else if (d !== 93) {
          this.fail("Expected ',' or ']'");
          return null;
        }
      }
      out = arr;
    } else if (c === 123) {
      this.i = this.i + 1;
      const obj = JV.obj();
      this.skipSpace();
      if (s.charCodeAt(this.i) === 125) {
        this.i = this.i + 1;
        out = obj;
      } else {
        while (true) {
          this.skipSpace();
          const key = this.parseKey();
          if (key === null) return null;
          this.skipSpace();
          if (s.charCodeAt(this.i) !== 61) {
            this.fail("Expected '='");
            return null;
          }
          this.i = this.i + 1;
          const v = this.value();
          if (v === null) return null;
          if (!this.assign(obj, key, v)) return null;
          this.skipSpace();
          const d = s.charCodeAt(this.i);
          if (d === 44) {
            this.i = this.i + 1;
            continue;
          }
          if (d === 125) {
            this.i = this.i + 1;
            break;
          }
          this.fail("Expected ',' or '}'");
          return null;
        }
        out = obj;
      }
    } else {
      // bare: boolean, number, datetime
      let e = this.i;
      while (e < this.n) {
        const d = s.charCodeAt(e);
        if (d === 10 || d === 13 || d === 44 || d === 93 || d === 125 || d === 35) break;
        e = e + 1;
      }
      const text = s.substring(this.i, e).replace(/[ \t]+$/, "");
      this.i = e;
      if (text === "true") out = JV.bool(true);
      else if (text === "false") out = JV.bool(false);
      else if (text === "inf" || text === "+inf") out = JV.num(Infinity);
      else if (text === "-inf") out = JV.num(-Infinity);
      else if (text === "nan" || text === "+nan" || text === "-nan") out = JV.num(NaN);
      else if (/^[-+]?(0|[1-9][0-9_]*)$/.test(text)) out = JV.num(Number(text.replace(/_/g, "")));
      else if (/^0x[0-9a-fA-F_]+$/.test(text)) out = JV.num(parseInt(text.substring(2).replace(/_/g, ""), 16));
      else if (/^0o[0-7_]+$/.test(text)) out = JV.num(parseInt(text.substring(2).replace(/_/g, ""), 8));
      else if (/^0b[01_]+$/.test(text)) out = JV.num(parseInt(text.substring(2).replace(/_/g, ""), 2));
      else if (/^[-+]?([0-9][0-9_]*)(\.[0-9][0-9_]*)?([eE][-+]?[0-9_]+)?$/.test(text)) out = JV.num(Number(text.replace(/_/g, "")));
      else if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9:.]+([Zz]|[-+][0-9:]+)?)?$/.test(text) || /^[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?$/.test(text)) out = JV.str(text);
      else {
        this.i = st;
        this.fail("Unexpected token");
        return null;
      }
    }
    out.at = st;
    return out;
  }
  // Walks `key` from `obj` (making tables) and sets the last part.
  assign(obj: JV, key: string[], v: JV): boolean {
    let cur = obj;
    for (let k = 0; k < key.length - 1; k++) {
      let next = cur.get(key[k]);
      if (next === null) {
        next = JV.obj();
        cur.set(key[k], next);
      } else if (next.kind === J_ARR && next.items.length > 0) {
        next = next.items[next.items.length - 1];
      }
      if (next.kind !== J_OBJ) return this.fail("Cannot extend a value that is not a table");
      cur = next;
    }
    const last = key[key.length - 1];
    if (cur.get(last) !== null) return this.fail("Duplicate key");
    cur.setAt(last, v, this.lastKeyAt);
    return true;
  }
  document(): JV | null {
    const root = JV.obj();
    let table = root;
    while (true) {
      this.skipWsLines();
      if (this.i >= this.n) break;
      const c = this.s.charCodeAt(this.i);
      if (c === 91) {
        const isArray = this.s.charCodeAt(this.i + 1) === 91;
        this.i = this.i + (isArray ? 2 : 1);
        const key = this.parseKey();
        if (key === null) return null;
        this.skipSpace();
        if (this.s.charCodeAt(this.i) !== 93 || (isArray && this.s.charCodeAt(this.i + 1) !== 93)) {
          this.fail("Expected ']' to close a table header but found (redacted)");
          return null;
        }
        this.i = this.i + (isArray ? 2 : 1);
        // find or make the table
        let cur = root;
        for (let k = 0; k < key.length; k++) {
          let next = cur.get(key[k]);
          const last = k === key.length - 1;
          if (last && isArray) {
            if (next === null) {
              next = JV.arr();
              cur.set(key[k], next);
            }
            if (next.kind !== J_ARR) {
              this.fail("Cannot extend a value that is not an array of tables");
              return null;
            }
            const t = JV.obj();
            t.at = this.lastKeyAt;
            next.push(t);
            cur = t;
            continue;
          }
          if (next === null) {
            next = JV.obj();
            next.at = this.lastKeyAt;
            cur.setAt(key[k], next, this.lastKeyAt);
          } else if (next.kind === J_ARR && next.items.length > 0) {
            next = next.items[next.items.length - 1];
          }
          if (next.kind !== J_OBJ) {
            this.fail("Cannot extend a value that is not a table");
            return null;
          }
          cur = next;
        }
        table = cur;
      } else {
        const key = this.parseKey();
        if (key === null) return null;
        this.skipSpace();
        if (this.s.charCodeAt(this.i) !== 61) {
          this.fail("Expected '='");
          return null;
        }
        this.i = this.i + 1;
        const v = this.value();
        if (v === null) return null;
        if (!this.assign(table, key, v)) return null;
      }
      this.skipSpace();
      this.skipComment();
      if (this.i < this.n) {
        const d = this.s.charCodeAt(this.i);
        if (d !== 10 && d !== 13) {
          this.fail("Expected a new line");
          return null;
        }
      }
    }
    return root;
  }
}

// Parses TOML. null on an error (message and place in `tomlError`, `tomlErrorLine`, `tomlErrorColumn`).
export function parseToml(text: string): JV | null {
  if (text.charCodeAt(0) === 0xfeff) text = text.substring(1);
  const p = new TomlParser(text);
  const v = p.document();
  if (v === null) {
    tomlError = p.err;
    let line = 1;
    let col = 1;
    for (let i = 0; i < p.errAt && i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        line = line + 1;
        col = 1;
      } else col = col + 1;
    }
    tomlErrorLine = line;
    tomlErrorColumn = col;
    return null;
  }
  return v;
}
