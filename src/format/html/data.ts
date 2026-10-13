// Port of vendor/bun/src/format/html/data.rs: what is known about the elements of HTML (`ml_parser/html_tags.ts` of `angular-html-parser`, and the tables
// that Prettier takes from `html-ua-styles`, `@prettier/html-tags`, `html-element-attributes` and `@prettier/html-event-attributes`).
//
// The tables are generated from the Rust file by tools/html/gen-data.ts (data_tables.ts). A name is looked up in a `NameTable`: an open
// addressing hash of the bytes, with the names compared byte by byte.
import {
  CSS_DISPLAY_KINDS,
  CSS_DISPLAY_NAMES,
  ELEMENT_ATTRIBUTE_ELEMENTS,
  ELEMENT_ATTRIBUTE_LISTS,
  HTML_EVENT_ATTRIBUTES,
  HTML_TAGS,
  TAG_DEF_KINDS,
  TAG_DEF_NAMES,
} from "./data_tables.ts";

/** The value of the CSS property `display`, as far as anything depends on it. */
export const DISPLAY_NONE: number = 0;
export const DISPLAY_BLOCK: number = 1;
export const DISPLAY_LIST_ITEM: number = 2;
export const DISPLAY_INLINE_BLOCK: number = 3;
/** It starts with `table` and is not `table-cell`. */
export const DISPLAY_TABLE: number = 4;
export const DISPLAY_TABLE_CELL: number = 5;
/** `inline` and everything else. */
export const DISPLAY_INLINE: number = 6;

/** `isBlockLikeCssDisplay` */
export function displayIsBlockLike(d: number): boolean {
  return d === DISPLAY_BLOCK || d === DISPLAY_LIST_ITEM || d === DISPLAY_TABLE || d === DISPLAY_TABLE_CELL;
}

/** The display that a comment asks for: `name` is `buf[s, e)`. */
export function displayFromName(buf: Uint8Array, s: number, e: number): number {
  const n = e - s;
  if (n === 4 && eqLit(buf, s, e, "none")) return DISPLAY_NONE;
  if (n === 5 && eqLit(buf, s, e, "block")) return DISPLAY_BLOCK;
  if (n >= 5 && eqLit(buf, s, s + 5, "table")) return DISPLAY_TABLE;
  return DISPLAY_INLINE;
}

/** `buf[s, e)` is the ASCII literal `lit`. */
export function eqLit(buf: Uint8Array, s: number, e: number, lit: string): boolean {
  const n = lit.length;
  if (e - s !== n) return false;
  for (let i = 0; i < n; i++) {
    if ((buf[s + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** `buf[s, e)` is `lit` when upper case ASCII letters of `buf` are lower case (`lit` is lower case). */
export function eqLitIgnoreCase(buf: Uint8Array, s: number, e: number, lit: string): boolean {
  const n = lit.length;
  if (e - s !== n) return false;
  for (let i = 0; i < n; i++) {
    let c = buf[s + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** An open addressing hash table from names (bytes) to the index of the name in the list it was built from. */
export class NameTable {
  blob: Uint8Array;
  starts: Int32Array;
  ends: Int32Array;
  slots: Int32Array;
  mask: number;
  count: number;
  constructor(names: string[]) {
    const n = names.length;
    this.count = n;
    let total = 0;
    for (let i = 0; i < n; i++) total += names[i].length;
    this.blob = new Uint8Array(total + 1);
    this.starts = new Int32Array(n + 1);
    this.ends = new Int32Array(n + 1);
    let size = 16;
    while (size < n * 2 + 2) size = size * 2;
    this.slots = new Int32Array(size).fill(-1);
    this.mask = size - 1;
    let at = 0;
    for (let i = 0; i < n; i++) {
      const name = names[i];
      this.starts[i] = at;
      for (let j = 0; j < name.length; j++) {
        this.blob[at] = name.charCodeAt(j) | 0;
        at = at + 1;
      }
      this.ends[i] = at;
    }
    for (let i = 0; i < n; i++) {
      let h = hashBytes(this.blob, this.starts[i] | 0, this.ends[i] | 0) & this.mask;
      while ((this.slots[h] | 0) >= 0) h = (h + 1) & this.mask;
      this.slots[h] = i | 0;
    }
  }

  /** The index of the name `buf[s, e)`, or -1. */
  find(buf: Uint8Array, s: number, e: number): number {
    const slots = this.slots;
    const mask = this.mask;
    const blob = this.blob;
    let h = hashBytes(buf, s, e) & mask;
    const len = e - s;
    for (;;) {
      const idx = slots[h] | 0;
      if (idx < 0) return -1;
      const ns = this.starts[idx] | 0;
      if (((this.ends[idx] | 0) - ns) === len) {
        let same = true;
        for (let i = 0; i < len; i++) {
          if ((blob[ns + i] | 0) !== (buf[s + i] | 0)) {
            same = false;
            break;
          }
        }
        if (same) return idx;
      }
      h = (h + 1) & mask;
    }
  }
}

function hashBytes(buf: Uint8Array, s: number, e: number): number {
  let h = 0x811c9dc5 | 0;
  for (let i = s; i < e; i++) {
    h = Math.imul(h ^ (buf[i] | 0), 16777619) | 0;
  }
  return (h ^ (h >>> 15)) & 0x7fffffff;
}

function words(s: string): string[] {
  return s.length === 0 ? [] : s.split(" ");
}

// ───────────────────────────── tag definitions ─────────────────────────────

export const CT_RAW_TEXT: number = 0;
export const CT_ESCAPABLE_RAW_TEXT: number = 1;
export const CT_PARSABLE_DATA: number = 2;

// The ids of the definitions.
/** The one of an element that nothing is known of: it can be self closed. */
export const DEF_DEFAULT: number = 0;
/** Of an element that Angular's schema has, and that has no definition of its own. */
export const DEF_KNOWN: number = 1;
export const DEF_VOID: number = 2;
export const DEF_P: number = 3;
export const DEF_THEAD: number = 4;
export const DEF_TBODY: number = 5;
export const DEF_TFOOT: number = 6;
export const DEF_TR: number = 7;
export const DEF_TD: number = 8;
export const DEF_SVG: number = 9;
export const DEF_FOREIGN_OBJECT: number = 10;
export const DEF_MATH: number = 11;
export const DEF_LI: number = 12;
export const DEF_DT: number = 13;
export const DEF_DD: number = 14;
export const DEF_RB: number = 15;
export const DEF_RTC: number = 16;
export const DEF_OPTGROUP: number = 17;
export const DEF_OPTION: number = 18;
export const DEF_PRE: number = 19;
export const DEF_RAW: number = 20;
export const DEF_TITLE: number = 21;
export const DEF_TEXTAREA: number = 22;
const DEF_COUNT = 23;

const DEF_CLOSED_BY_CHILDREN: string[][] = [];
const DEF_IMPLICIT_NAMESPACE: string[] = []; // "" none
const DEF_CONTENT_TYPE = new Uint8Array(DEF_COUNT);
const DEF_CLOSED_BY_PARENT = new Uint8Array(DEF_COUNT);
const DEF_IS_VOID = new Uint8Array(DEF_COUNT);
const DEF_IGNORE_FIRST_LF = new Uint8Array(DEF_COUNT);
const DEF_PREVENT_NS_INHERITANCE = new Uint8Array(DEF_COUNT);
const DEF_CAN_SELF_CLOSE = new Uint8Array(DEF_COUNT);

function defineDefinitions(): void {
  for (let i = 0; i < DEF_COUNT; i++) {
    DEF_CLOSED_BY_CHILDREN.push([]);
    DEF_IMPLICIT_NAMESPACE.push("");
    DEF_CONTENT_TYPE[i] = CT_PARSABLE_DATA;
  }
  DEF_CAN_SELF_CLOSE[DEF_DEFAULT] = 1;
  const closedBy = (id: number, children: string[], parent: boolean): void => {
    DEF_CLOSED_BY_CHILDREN[id] = children;
    DEF_CLOSED_BY_PARENT[id] = parent ? 1 : 0;
  };
  DEF_IS_VOID[DEF_VOID] = 1;
  DEF_CLOSED_BY_PARENT[DEF_VOID] = 1;
  closedBy(
    DEF_P,
    [
      "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
      "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
    ],
    true,
  );
  closedBy(DEF_THEAD, ["tbody", "tfoot"], false);
  closedBy(DEF_TBODY, ["tbody", "tfoot"], true);
  closedBy(DEF_TFOOT, ["tbody"], true);
  closedBy(DEF_TR, ["tr"], true);
  closedBy(DEF_TD, ["td", "th"], true);
  DEF_IMPLICIT_NAMESPACE[DEF_SVG] = "svg";
  DEF_IMPLICIT_NAMESPACE[DEF_FOREIGN_OBJECT] = "svg";
  DEF_PREVENT_NS_INHERITANCE[DEF_FOREIGN_OBJECT] = 1;
  DEF_IMPLICIT_NAMESPACE[DEF_MATH] = "math";
  closedBy(DEF_LI, ["li"], true);
  closedBy(DEF_DT, ["dt", "dd"], false);
  closedBy(DEF_DD, ["dt", "dd"], true);
  closedBy(DEF_RB, ["rb", "rt", "rtc", "rp"], true);
  closedBy(DEF_RTC, ["rb", "rtc", "rp"], true);
  closedBy(DEF_OPTGROUP, ["optgroup"], true);
  closedBy(DEF_OPTION, ["option", "optgroup"], true);
  DEF_CONTENT_TYPE[DEF_PRE] = CT_PARSABLE_DATA;
  DEF_IGNORE_FIRST_LF[DEF_PRE] = 1;
  DEF_CONTENT_TYPE[DEF_RAW] = CT_RAW_TEXT;
  DEF_CONTENT_TYPE[DEF_TITLE] = CT_ESCAPABLE_RAW_TEXT;
  DEF_CONTENT_TYPE[DEF_TEXTAREA] = CT_ESCAPABLE_RAW_TEXT;
  DEF_IGNORE_FIRST_LF[DEF_TEXTAREA] = 1;
}
defineDefinitions();

function defKindId(kind: string): number {
  switch (kind) {
    case "KNOWN": return DEF_KNOWN;
    case "VOID": return DEF_VOID;
    case "P": return DEF_P;
    case "THEAD": return DEF_THEAD;
    case "TBODY": return DEF_TBODY;
    case "TFOOT": return DEF_TFOOT;
    case "TR": return DEF_TR;
    case "TD": return DEF_TD;
    case "SVG": return DEF_SVG;
    case "FOREIGN_OBJECT": return DEF_FOREIGN_OBJECT;
    case "MATH": return DEF_MATH;
    case "LI": return DEF_LI;
    case "DT": return DEF_DT;
    case "DD": return DEF_DD;
    case "RB": return DEF_RB;
    case "RTC": return DEF_RTC;
    case "OPTGROUP": return DEF_OPTGROUP;
    case "OPTION": return DEF_OPTION;
    case "PRE": return DEF_PRE;
    case "RAW": return DEF_RAW;
    case "TITLE": return DEF_TITLE;
    case "TEXTAREA": return DEF_TEXTAREA;
    default: return DEF_DEFAULT;
  }
}

const DEF_TABLE = new NameTable(words(TAG_DEF_NAMES));
const DEF_OF_ENTRY = new Uint8Array(DEF_TABLE.count + 1);
{
  const kinds = words(TAG_DEF_KINDS);
  for (let i = 0; i < kinds.length; i++) DEF_OF_ENTRY[i] = defKindId(kinds[i]);
}

/** `getHtmlTagDefinition(name)` for `buf[s, e)`. */
export function tagDefinition(buf: Uint8Array, s: number, e: number): number {
  const i = DEF_TABLE.find(buf, s, e);
  return i < 0 ? DEF_DEFAULT : DEF_OF_ENTRY[i] | 0;
}

export function defContentType(d: number): number {
  return DEF_CONTENT_TYPE[d] | 0;
}
export function defClosedByParent(d: number): boolean {
  return (DEF_CLOSED_BY_PARENT[d] | 0) !== 0;
}
export function defIsVoid(d: number): boolean {
  return (DEF_IS_VOID[d] | 0) !== 0;
}
export function defIgnoreFirstLf(d: number): boolean {
  return (DEF_IGNORE_FIRST_LF[d] | 0) !== 0;
}
export function defPreventNamespaceInheritance(d: number): boolean {
  return (DEF_PREVENT_NS_INHERITANCE[d] | 0) !== 0;
}
export function defCanSelfClose(d: number): boolean {
  return (DEF_CAN_SELF_CLOSE[d] | 0) !== 0;
}
/** `implicitNamespacePrefix` is `svg` / `math` / none. */
export function defImplicitNamespace(d: number): string {
  return DEF_IMPLICIT_NAMESPACE[d];
}
/** Whether the definition has `prefix` as its implicit namespace prefix; `buf[s, e)` is the namespace. */
export function defHasImplicitNamespace(d: number, buf: Uint8Array, s: number, e: number): boolean {
  const ns = DEF_IMPLICIT_NAMESPACE[d];
  return ns.length > 0 && eqLit(buf, s, e, ns);
}
/** `isClosedByChild(name)`, `name` is `buf[s, e)`. */
export function defIsClosedByChild(d: number, buf: Uint8Array, s: number, e: number): boolean {
  if ((DEF_IS_VOID[d] | 0) !== 0) return true;
  const list = DEF_CLOSED_BY_CHILDREN[d];
  for (let i = 0; i < list.length; i++) {
    if (eqLitIgnoreCase(buf, s, e, list[i])) return true;
  }
  return false;
}

// ───────────────────────────── the other tables ─────────────────────────────

const HTML_TAG_TABLE = new NameTable(words(HTML_TAGS));
/** `HTML_TAGS.has(name)` */
export function isHtmlTag(buf: Uint8Array, s: number, e: number): boolean {
  return HTML_TAG_TABLE.find(buf, s, e) >= 0;
}

const EVENT_TABLE = new NameTable(words(HTML_EVENT_ATTRIBUTES));
/** `htmlEventAttributes.has(name)` */
export function isEventAttribute(buf: Uint8Array, s: number, e: number): boolean {
  return e - s > 2 && (buf[s] | 0) === 111 && (buf[s + 1] | 0) === 110 && EVENT_TABLE.find(buf, s, e) >= 0;
}

const ATTRIBUTE_ELEMENT_TABLE = new NameTable(words(ELEMENT_ATTRIBUTE_ELEMENTS));
const ATTRIBUTE_TABLES: NameTable[] = [];
for (let i = 0; i < ELEMENT_ATTRIBUTE_LISTS.length; i++) ATTRIBUTE_TABLES.push(new NameTable(words(ELEMENT_ATTRIBUTE_LISTS[i])));
const STAR_ATTRIBUTES = ATTRIBUTE_TABLES[ATTRIBUTE_ELEMENT_TABLE.find(asciiBytesOf("*"), 0, 1)];

function asciiBytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) | 0;
  return out;
}

/** Whether the element with the name `buf[es, ee)` is known, and has an attribute with the name `buf2[as, ae)`. */
export function isAttributeOfElement(buf: Uint8Array, es: number, ee: number, buf2: Uint8Array, as: number, ae: number): boolean {
  const i = ATTRIBUTE_ELEMENT_TABLE.find(buf, es, ee);
  if (i < 0) return false;
  return ATTRIBUTE_TABLES[i].find(buf2, as, ae) >= 0 || STAR_ATTRIBUTES.find(buf2, as, ae) >= 0;
}

const DISPLAY_TABLE_NAMES = new NameTable(words(CSS_DISPLAY_NAMES));
const DISPLAY_OF_ENTRY = new Uint8Array(DISPLAY_TABLE_NAMES.count + 1);
{
  const kinds = words(CSS_DISPLAY_KINDS);
  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i];
    DISPLAY_OF_ENTRY[i] =
      k === "None" ? DISPLAY_NONE :
      k === "Block" ? DISPLAY_BLOCK :
      k === "ListItem" ? DISPLAY_LIST_ITEM :
      k === "InlineBlock" ? DISPLAY_INLINE_BLOCK :
      k === "Table" ? DISPLAY_TABLE :
      k === "TableCell" ? DISPLAY_TABLE_CELL :
      DISPLAY_INLINE;
  }
}

/** `CSS_DISPLAY_TAGS[name]`, -1: none. */
export function cssDisplayOfTag(buf: Uint8Array, s: number, e: number): number {
  const i = DISPLAY_TABLE_NAMES.find(buf, s, e);
  return i < 0 ? -1 : DISPLAY_OF_ENTRY[i] | 0;
}

/** Whether `CSS_WHITE_SPACE_TAGS[name]` starts with `pre`. */
export function isPreTag(buf: Uint8Array, s: number, e: number): boolean {
  switch (e - s) {
    case 3:
      return eqLit(buf, s, e, "pre") || eqLit(buf, s, e, "xmp");
    case 7:
      return eqLit(buf, s, e, "listing");
    case 8:
      return eqLit(buf, s, e, "textarea");
    case 9:
      return eqLit(buf, s, e, "plaintext");
    default:
      return false;
  }
}
