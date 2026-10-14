// Port of vendor/bun/src/format/html/map_strings.rs: Prettier's `mapDoc(doc, (doc) => (typeof doc === "string" ? .. : doc))`, for content that
// has been captured.
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { Formatter } from "../ir/formatter.ts";
import {
  E_BEST_FITTING,
  E_INTERNED,
  E_NOP,
  E_OWNED_TEXT,
  E_SKIP,
  E_SOURCE_TEXT,
  E_TOKEN,
  GM_EXPAND,
  T_START_GROUP,
  TIB_BASE,
  TOK_BASE,
  tokenBytes,
  twIsMultiline,
  twIsOneString,
} from "../ir/element.ts";

/** What becomes of the strings of a document. */
export class StringMapper {
  /** Whether `text`, or a string that it is a part of, may become something else. */
  changes(buf: Uint8Array, s: number, e: number): boolean {
    void buf;
    void s;
    void e;
    return false;
  }

  /** Writes what `text` becomes. `isOneString`: see `TextWidth::multiline_string`. */
  write(buf: Uint8Array, s: number, e: number, isOneString: boolean, f: Formatter): void {
    void buf;
    void s;
    void e;
    void isOneString;
    void f;
  }
}

// What the line breaks in strings are.
const LB_NONE = 0;
/** Nothing but characters: see `TextWidth::multiline_string`. */
const LB_CHARACTERS = 1;
/** A `literalline` each. */
const LB_LITERAL_LINES = 2;

const TOKEN_SCRATCH = new Uint8Array(16);

/** The text of the element `i` of the pool: sets `tb`, `ts`, `te`. Returns false if it is none. */
class TextOf {
  tb: Uint8Array = TOKEN_SCRATCH;
  ts: number = 0;
  te: number = 0;
}
const TX = new TextOf();

function textOfElement(f: Formatter, i: number): boolean {
  const st = f.st;
  const kind = st.tag[i] | 0;
  const TX$ = TX;
  if (kind >= TOK_BASE) {
    if (kind >= TIB_BASE) return false;
    const len = kind - TOK_BASE;
    const w0 = st.a[i] | 0;
    const w1 = st.b[i] | 0;
    const w2 = st.c[i] | 0;
    for (let k = 0; k < len; k++) {
      const w = k < 4 ? w0 : k < 8 ? w1 : w2;
      TOKEN_SCRATCH[k] = (w >>> (8 * (k & 3))) & 255;
    }
    TX$.tb = TOKEN_SCRATCH;
    TX$.ts = 0;
    TX$.te = len;
    return true;
  }
  if (kind === E_TOKEN) {
    TX$.tb = tokenBytes();
    TX$.ts = st.a[i] | 0;
    TX$.te = (st.a[i] | 0) + (st.b[i] | 0);
    return true;
  }
  if (kind === E_SOURCE_TEXT) {
    TX$.tb = f.source;
    TX$.ts = st.a[i] | 0;
    TX$.te = (st.a[i] | 0) + (st.b[i] | 0);
    return true;
  }
  if (kind === E_OWNED_TEXT) {
    TX$.tb = st.text.data;
    TX$.ts = st.a[i] | 0;
    TX$.te = (st.a[i] | 0) + (st.b[i] | 0);
    return true;
  }
  return false;
}

/**
 * Writes `content`, which has been captured, with what `map` makes of its strings. Strings that follow each other are one string: the document
 * that Prettier maps has been through `cleanDoc`.
 */
export function writeMapped(f: Formatter, content: number, map: StringMapper): void {
  if (content < 0) return;
  // Everything that `content` stands for is in it: what is captured stays where it is written.
  let changes = false;
  const end = f.capturedEnd(content);
  const TX$ = TX;
  for (let i = f.capturedStart(content); i < end; i++) {
    if (textOfElement(f, i) && map.changes(TX$.tb, TX$.ts, TX$.te)) {
      changes = true;
      break;
    }
  }
  if (!changes) {
    f.writeInterned(content);
    return;
  }
  const m = new Mapper(map);
  m.write(f, content);
}

/** Writes elements once more, so that what is known about the groups around them is right for the new texts. */
class Mapper {
  map: StringMapper;
  /** What has been captured, and the same with the new texts. */
  mapped: Map<number, number>;
  /** The strings since the last element that is not one, which have not been written yet: indices of the pool. */
  strings: I32Vec;
  /** The same, put together. */
  text: ByteBuf;
  lineBreaks: number;

  constructor(map: StringMapper) {
    this.map = map;
    this.mapped = new Map<number, number>();
    this.strings = new I32Vec(8);
    this.text = new ByteBuf(64);
    this.lineBreaks = LB_NONE;
  }

  capture(content: number, f: Formatter): number {
    const known = this.mapped.get(content);
    if (known !== undefined) return known;
    if (!f.stack.enter()) return content;
    const slot = f.startCapture();
    this.write(f, content);
    const mapped = f.endCapture(slot);
    f.stack.leave();
    this.mapped.set(content, mapped);
    return mapped;
  }

  /** Writes the strings that have not been written yet. */
  flush(f: Formatter): void {
    if (this.strings.len === 0) return;
    if (this.map.changes(this.text.data, 0, this.text.len)) {
      this.map.write(this.text.data, 0, this.text.len, this.lineBreaks === LB_CHARACTERS, f);
    } else {
      for (let k = 0; k < this.strings.len; k++) f.copyElement(this.strings.data[k] | 0);
    }
    this.strings.reset();
    this.text.reset();
    this.lineBreaks = LB_NONE;
  }

  write(f: Formatter, content: number): void {
    const st = f.st;
    let i = f.capturedStart(content);
    const end = f.capturedEnd(content);
    const TX$ = TX;
    while (i < end) {
      const kind = st.tag[i] | 0;
      let lineBreaks = LB_NONE;
      if (kind === E_SOURCE_TEXT || kind === E_OWNED_TEXT) {
        const w = st.c[i] | 0;
        if (twIsOneString(w)) lineBreaks = LB_CHARACTERS;
        else if (twIsMultiline(w)) lineBreaks = LB_LITERAL_LINES;
      }
      if (lineBreaks !== LB_NONE) {
        // One string has one kind.
        if (this.lineBreaks !== LB_NONE && this.lineBreaks !== lineBreaks) this.flush(f);
        this.lineBreaks = lineBreaks;
      }
      if (textOfElement(f, i)) {
        this.text.append(TX$.tb, TX$.ts, TX$.te);
        this.strings.push(i);
        i = i + 1;
        continue;
      }
      if (kind === E_SKIP) {
        i = i + 1 + (st.a[i] | 0);
        continue;
      }
      if (kind === E_NOP) {
        i = i + 1;
        continue;
      }
      this.flush(f);
      if (kind === E_INTERNED) {
        const mapped = this.capture(st.a[i] | 0, f);
        if (mapped >= 0) f.writeInterned(mapped);
      } else if (kind === E_BEST_FITTING) {
        const first = st.a[i] | 0;
        const count = st.b[i] | 0;
        const variants = new I32Vec(count);
        for (let k = 0; k < count; k++) variants.push(f.st.variants.data[first + k] | 0);
        const mappedVariants = new I32Vec(count);
        for (let k = 0; k < count; k++) mappedVariants.push(this.capture(variants.data[k] | 0, f));
        f.bestFittingOf(mappedVariants);
      } else if (kind === T_START_GROUP) {
        // What is in it is measured anew.
        const mode = ((st.b[i] | 0) >> 24) & 255;
        f.startGroupWith(st.a[i] | 0, mode === GM_EXPAND);
      } else {
        f.copyElement(i);
      }
      i = i + 1;
    }
    this.flush(f);
  }
}
