// Port of vendor/bun/src/format/html/verify.rs: a check that formatting has not lost or made up anything: `bun fmt --debug-check`.
//
// What would be written is parsed, and compared with the file:
//
// - The elements, comments, blocks and declarations are the same, in the same order and in each other the same way, and the elements have the
//   same attributes in the same order. Upper and lower case do not count.
// - All that is text has the same letters as often, whatever becomes of white space, punctuation, numbers and upper and lower case: text,
//   comments, scripts, style sheets, the values of attributes, expressions. So nothing with a letter in it is lost or there twice, in
//   whatever language it is. That letters have changed places is not noticed.
import { parseFrontMatter } from "../front_matter.ts";
import { jsWhitespaceLen } from "../text.ts";
import {
  A_STRIDE,
  AF_HAS_VAL,
  AF_NAME_E,
  AF_NAME_S,
  AF_NS_E,
  AF_NS_S,
  AF_VAL_E,
  AF_VAL_S,
  F_ATTR_E,
  F_ATTR_S,
  F_SPAN_E,
  F_SPAN_S,
  F_TC_E,
  F_TC_S,
  HTree,
  K_ANGULAR_CONTROL_FLOW_BLOCK,
  K_ANGULAR_ICU_EXPRESSION,
  K_ANGULAR_LET_DECLARATION,
  K_CDATA,
  K_ELEMENT,
  K_FRONT_MATTER,
  K_TEXT,
  TC_STRIDE,
  TCF_VAL_E,
  TCF_VAL_S,
  firstChild,
  kindOf,
  nGet,
  nameEnd,
  nameStart,
  nextOf,
  nsEnd,
  nsStart,
  parametersOf,
  parentOf,
  valEnd,
  valStart,
} from "./ast.ts";
import { PARSE_OK, parseTree } from "./parse.ts";

/** What is compared of a text. */
class Signature {
  /** Of the nodes that are not text. */
  structure0: number = 0;
  structure1: number = 0;
  /** How often each letter is there, and each byte of a character that is not ASCII. */
  letters: Float64Array = new Float64Array(26 + 128);
}

const SPECIAL = new Uint8Array(256);
for (const c of [0x65, 0x45, 0x5c, 0xc2, 0xc4, 0xe1, 0xe2, 0xe3, 0xef]) SPECIAL[c] = 1;

class Reader {
  structure0: number = 0x811c9dc5 | 0;
  structure1: number = 0x1234567 | 0;
  /** How often each byte is there, of those that count. */
  bytes: Float64Array = new Float64Array(256);

  writeU8(b: number): void {
    this.structure0 = Math.imul(this.structure0 ^ b, 16777619) | 0;
    this.structure1 = (Math.imul(this.structure1, 31) + b + 1) | 0;
  }

  add(byte: number): void {
    this.bytes[byte] = this.bytes[byte] + 1;
  }

  /** `byte` does not count, whether it has been added or is going to be. */
  takeBack(byte: number): void {
    this.bytes[byte] = this.bytes[byte] - 1;
  }

  count(b: Uint8Array, s: number, e: number): void {
    for (let at = s; at < e; at++) {
      const byte = b[at] | 0;
      this.add(byte);
      if ((SPECIAL[byte] | 0) !== 0) this.lookAround(b, s, e, at);
    }
  }

  /** `/^[+-]?0+(?!\d)/.test(text)` */
  isZero(b: Uint8Array, s: number, e: number): boolean {
    let at = s;
    if (at < e && ((b[at] | 0) === 43 || (b[at] | 0) === 45)) at = at + 1;
    let zeros = 0;
    while (at + zeros < e && (b[at + zeros] | 0) === 48) zeros = zeros + 1;
    if (zeros === 0) return false;
    const next = at + zeros;
    return !(next < e && (b[next] | 0) >= 48 && (b[next] | 0) <= 57);
  }

  /** Un-counts the bytes that shouldn't count because of the byte at `at`, which is one of `SPECIAL`. */
  lookAround(b: Uint8Array, s: number, e: number, at: number): void {
    const previous = at > s ? b[at - 1] | 0 : 0;
    const byte = b[at] | 0;
    if (byte === 0x65 || byte === 0x45) {
      // The exponent of a number, which goes if it is zero.
      const afterDigit = at > s && (b[at - 1] | 0) >= 48 && (b[at - 1] | 0) <= 57;
      const afterDigitDot = at >= s + 2 && (b[at - 1] | 0) === 46 && (b[at - 2] | 0) >= 48 && (b[at - 2] | 0) <= 57;
      if ((afterDigit || afterDigitDot) && this.isZero(b, at + 1, e)) this.takeBack(byte);
      return;
    }
    if (byte === 0x5c && at + 1 < e) {
      // `\n` in a template with HTML in it is white space.
      this.takeBack(b[at + 1] | 0);
      return;
    }
    if (previous === 0x5c) return;
    if (byte === 0xc4 && at + 1 < e && (b[at + 1] | 0) === 0xb0) {
      // In lower case, U+0130 is an `i` and U+0307.
      this.takeBack(0xc4);
      this.takeBack(0xb0);
      this.add(0x69);
      this.add(0xcc);
      this.add(0x87);
      return;
    }
    const n = jsWhitespaceLen(b, at, e);
    for (let k = 0; k < n; k++) this.takeBack(b[at + k] | 0);
  }

  /** The same for the value of an attribute, in which a quote can be written as an entity. */
  countValue(b: Uint8Array, s: number, e: number): void {
    this.count(b, s, e);
    for (const entity of ["&quot;", "&apos;"]) {
      let rest = s;
      for (;;) {
        let at = -1;
        for (let i = rest; i + entity.length <= e; i++) {
          let same = true;
          for (let k = 0; k < entity.length; k++) {
            if ((b[i + k] | 0) !== entity.charCodeAt(k)) {
              same = false;
              break;
            }
          }
          if (same) {
            at = i;
            break;
          }
        }
        if (at < 0) break;
        for (let k = 0; k < entity.length; k++) this.takeBack(entity.charCodeAt(k));
        rest = at + entity.length;
      }
    }
  }

  name(b: Uint8Array, nsS: number, nsE: number, ns: number, ne: number): void {
    for (let i = nsS; i < nsE; i++) this.writeU8(this.lower(b[i] | 0));
    this.writeU8(58);
    for (let i = ns; i < ne; i++) this.writeU8(this.lower(b[i] | 0));
    this.writeU8(0);
  }

  lower(c: number): number {
    return c >= 65 && c <= 90 ? c + 32 : c;
  }

  /** What is said of `id` before what is in it. */
  enter(t: HTree, id: number, text: Uint8Array): void {
    const kind = kindOf(t, id);
    const b = t.pool.data;
    if (kind !== K_TEXT && kind !== K_CDATA) this.writeU8(1 + kind);
    if (kind === K_ELEMENT) {
      this.name(b, nsStart(t, id), nsEnd(t, id), nameStart(t, id), nameEnd(t, id));
      for (let a = nGet(t, id, F_ATTR_S); a < nGet(t, id, F_ATTR_E); a++) {
        const ab = a * A_STRIDE;
        this.name(b, t.a[ab + AF_NS_S] | 0, t.a[ab + AF_NS_E] | 0, t.a[ab + AF_NAME_S] | 0, t.a[ab + AF_NAME_E] | 0);
        if ((t.a[ab + AF_HAS_VAL] | 0) !== 0) this.countValue(b, t.a[ab + AF_VAL_S] | 0, t.a[ab + AF_VAL_E] | 0);
      }
      for (let c = nGet(t, id, F_TC_S); c < nGet(t, id, F_TC_E); c++) {
        this.count(b, t.c[c * TC_STRIDE + TCF_VAL_S] | 0, t.c[c * TC_STRIDE + TCF_VAL_E] | 0);
      }
    } else if (kind === K_FRONT_MATTER) {
      this.count(text, nGet(t, id, F_SPAN_S), nGet(t, id, F_SPAN_E));
    } else if (kind === K_ANGULAR_CONTROL_FLOW_BLOCK || kind === K_ANGULAR_LET_DECLARATION || kind === K_ANGULAR_ICU_EXPRESSION) {
      this.count(b, nameStart(t, id), nameEnd(t, id));
      this.count(b, valStart(t, id), valEnd(t, id));
      const params = parametersOf(t, id);
      if (params >= 0) {
        for (let c = firstChild(t, params); c >= 0; c = nextOf(t, c)) this.count(b, valStart(t, c), valEnd(t, c));
      }
    } else {
      this.count(b, valStart(t, id), valEnd(t, id));
    }
  }
}

const tree = new HTree();

function signature(text: Uint8Array, parser: number): Signature | null {
  const fm = parseFrontMatter(text);
  let content = text;
  let fmLen = -1;
  if (fm !== null) {
    content = text.slice();
    for (let i = 0; i < fm.end; i++) {
      if ((content[i] | 0) !== 10) content[i] = 32;
    }
    fmLen = fm.end;
  }
  tree.reset(content);
  if (parseTree(tree, fmLen, parser) !== PARSE_OK) return null;
  const reader = new Reader();
  // What is in a node comes behind it.
  const root = tree.root;
  let next = firstChild(tree, root);
  while (next >= 0) {
    const id = next;
    reader.enter(tree, id, text);
    const fc = firstChild(tree, id);
    if (fc >= 0) {
      next = fc;
      continue;
    }
    let at = id;
    next = -1;
    for (;;) {
      const k = kindOf(tree, at);
      if (k !== K_TEXT && k !== K_CDATA) reader.writeU8(0);
      const nx = nextOf(tree, at);
      if (nx >= 0) {
        next = nx;
        break;
      }
      const p = parentOf(tree, at);
      if (p < 0 || p === root) break;
      at = p;
    }
  }
  const sig = new Signature();
  sig.structure0 = reader.structure0;
  sig.structure1 = reader.structure1;
  for (let i = 0; i < 26; i++) sig.letters[i] = reader.bytes[97 + i] + reader.bytes[65 + i];
  for (let i = 0; i < 128; i++) sig.letters[26 + i] = reader.bytes[128 + i];
  return sig;
}

/** Whether `after`, which is what has become of `before`, has all that is in `before` and nothing else. Both are what `preparedText` makes of a text. */
export function hasSameContent(before: Uint8Array, after: Uint8Array, parser: number): boolean {
  const a = signature(before, parser);
  if (a === null) return false;
  const b = signature(after, parser);
  if (b === null) return false;
  if (a.structure0 !== b.structure0 || a.structure1 !== b.structure1) return false;
  for (let i = 0; i < a.letters.length; i++) {
    if (a.letters[i] !== b.letters[i]) return false;
  }
  return true;
}
