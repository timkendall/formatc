// Port of vendor/bun/src/format/json/writer.rs. Tree to text, for a document without comments.
//
// Without comments, the documents that Prettier's printer for JavaScript makes of JSON are so regular that what its
// document printer does with them can be said in a few lines:
//
// - An object or an array is on one line if it can be (`MUST_BREAK`) and if it fits, together with the comma after it.
//   Otherwise each property or element is on a line of its own.
// - Of an array of numbers that does not fit on one line, as many are on each line as fit.
//
// The widths are known from parsing, so nothing is measured here, and nothing is written twice.
import { ByteBuf } from "../../base/bytebuf.ts";
import { FORMAT_OK, FORMAT_TOO_LONG, MAX_STRING_LENGTH } from "../errors.ts";
import { stringWidth } from "../ir/width.ts";
import { makeString } from "../text.ts";
import { LE_LF, PARSER_STRINGIFY, Config } from "./config.ts";
import {
  BLANK_AFTER,
  CONCISE,
  K_ARRAY,
  K_HOLE,
  K_IDENTIFIER,
  K_NUMBER,
  K_OBJECT,
  K_STRING,
  K_TEMPLATE,
  K_UNARY,
  MUST_BREAK,
  N_COUNT,
  N_END,
  N_FLAGS,
  N_KIND,
  N_NEXT,
  N_START,
  N_WIDTH,
  QUOTED,
  REWRITTEN,
  UNQUOTED,
  Tree,
} from "./parser.ts";
import { jsonStringify, numBuf, pushLineEnding, trimmedNumber, writeWithLineEnding } from "./util.ts";

// Frame flags.
const F_OBJECT = 1;
/** It is on one line. */
const F_FLAT = 2;
const F_CONCISE = 4;
const F_FIRST = 8;
/** An empty line follows the last property or element that was written. */
const F_AFTER_BLANK = 16;
const F_AFTER_HOLE = 32;

/** What is allocated to write a document: the containers being written (`end`, flags). */
let frames = new Int32Array(2 * 64);
const cooked = new ByteBuf(64);

function growFrames(): void {
  const nf = new Int32Array(frames.length * 2);
  nf.set(frames);
  frames = nf;
}

/**
 * Appends `tree`, which has a node and no comments, to `out`. Returns `FORMAT_OK` or `FORMAT_TOO_LONG`.
 */
export function write(text: Uint8Array, tree: Tree, cfg: Config, out: ByteBuf): number {
  const textLen = text.length;
  out.reserve(textLen + (textLen >> 2) + 64);
  const nodes = tree.nodes;
  const nodeCount = tree.nodeCount;
  const printWidth = cfg.printWidth;
  const isTab = cfg.isTab;
  const indentWidth = cfg.indentWidth;
  const alignment = cfg.alignment;
  const lineEnding = cfg.lineEnding;
  const bracketSpacing = cfg.bracketSpacing;
  const trailingComma = cfg.trailingComma ? 1 : 0;
  const isStringify = cfg.parser === PARSER_STRINGIFY;
  const crlf = lineEnding === 1;
  const lineEndingLen = crlf ? 2 : 1;
  const lineEndingByte = lineEnding === 2 ? 13 : 10;
  const tabUnit = indentWidth > 1 ? indentWidth : 1;

  const sdv = new DataView(text.buffer, text.byteOffset, text.byteLength);
  let fr = frames;
  let o = out.data;
  let odv = new DataView(o.buffer, o.byteOffset, o.byteLength);
  let ol = out.len;
  let oc = o.length;
  /** The number of containers around that are not on one line. */
  let level = 0;
  /** Where the next byte goes on the line. */
  let column = alignment;
  let isTooLong = false;
  let depth = 0;
  let index = 0;

  while (true) {
    // The containers that end here.
    while (depth > 0 && (fr[(depth - 1) << 1] | 0) === index) {
      const fl = fr[((depth - 1) << 1) + 1] | 0;
      depth = depth - 1;
      // close(frame)
      const need = alignment + (level + 2) * indentWidth + 16;
      if (ol + need > oc) {
        out.len = ol;
        out.grow(ol + need);
        o = out.data;
        oc = o.length;
        odv = new DataView(o.buffer, o.byteOffset, o.byteLength);
      }
      // The comma after a hole is what makes it an element.
      if ((fl & F_AFTER_HOLE) !== 0 && !isStringify) {
        o[ol] = 44;
        ol = ((ol | 0) + 1) | 0;
        column = column + 1;
      }
      if ((fl & F_FLAT) !== 0) {
        if ((fl & F_OBJECT) !== 0 && bracketSpacing) {
          o[ol] = 32;
          ol = ((ol | 0) + 1) | 0;
          column = column + 1;
        }
      } else {
        if (trailingComma !== 0 && (fl & F_AFTER_HOLE) === 0) {
          o[ol] = 44;
          ol = ((ol | 0) + 1) | 0;
          column = column + 1;
        }
        level = level > 0 ? level - 1 : 0;
        // new_line()
        if (ol > MAX_STRING_LENGTH) {
          isTooLong = true;
        } else {
          if (crlf) {
            o[ol] = 13;
            o[ol + 1] = 10;
            ol = ((ol | 0) + 2) | 0;
          } else {
            o[ol] = lineEndingByte;
            ol = ((ol | 0) + 1) | 0;
          }
          if (!isTab) {
            column = alignment + level * indentWidth;
            const end = (ol | 0) + (column | 0);
            if (column > 16) {
              o.fill(32, ol, end);
              ol = end | 0;
            } else {
              while (ol < end) {
                o[ol] = 32;
                ol = ((ol | 0) + 1) | 0;
              }
            }
          } else {
            const tabs0 = ((alignment / tabUnit) | 0) + level;
            const spaces = alignment % tabUnit;
            if (tabs0 === 0) {
              const end = (ol | 0) + (spaces | 0);
              while (ol < end) {
                o[ol] = 32;
                ol = ((ol | 0) + 1) | 0;
              }
              column = spaces;
            } else {
              const tabs = tabs0 + (spaces > 0 ? 1 : 0);
              column = tabs * indentWidth;
              const end = (ol | 0) + (tabs | 0);
              while (ol < end) {
                o[ol] = 9;
                ol = ((ol | 0) + 1) | 0;
              }
            }
          }
        }
      }
      o[ol] = (fl & F_OBJECT) !== 0 ? 125 : 93;
      ol = ((ol | 0) + 1) | 0;
      column = column + 1;
    }
    if (index >= nodeCount) break;

    let b = index << 3;
    let kind = nodes[b + N_KIND] | 0;
    // How much room one more node takes at most: its text twice (escapes), a comma, a line break, the indentation.
    const indentBytes = alignment + (level + 2) * indentWidth + 16;
    let need = indentBytes + 16;
    if (kind !== K_OBJECT && kind !== K_ARRAY) need = need + 2 * ((nodes[b + N_END] | 0) - (nodes[b + N_START] | 0));
    if (depth > 0 && (fr[((depth - 1) << 1) + 1] & F_OBJECT) !== 0 && index + 1 < nodeCount) {
      need = need + 2 * ((nodes[b + N_END] | 0) - (nodes[b + N_START] | 0)) + 8;
      const vb = (index + 1) << 3;
      if ((nodes[vb + N_KIND] | 0) !== K_OBJECT && (nodes[vb + N_KIND] | 0) !== K_ARRAY) {
        need = need + 2 * ((nodes[vb + N_END] | 0) - (nodes[vb + N_START] | 0));
      }
    }
    if (ol + need > oc) {
      out.len = ol;
      out.grow(ol + need);
      o = out.data;
      oc = o.length;
      odv = new DataView(o.buffer, o.byteOffset, o.byteLength);
    }

    // What is before the property or the element.
    let isFlat = false;
    let rest = 0;
    let node = index;
    if (depth > 0) {
      const fi = (depth - 1) << 1;
      let fl = fr[fi + 1] | 0;
      const frameEnd = fr[fi] | 0;
      isFlat = (fl & F_FLAT) !== 0;
      const isFirst = (fl & F_FIRST) !== 0;
      const isAfterBlank = (fl & F_AFTER_BLANK) !== 0;
      const isObject = (fl & F_OBJECT) !== 0;
      fl = fl & ~(F_FIRST | F_AFTER_BLANK);
      if (!isFirst) {
        o[ol] = 44;
        ol = ((ol | 0) + 1) | 0;
        column = column + 1;
      }
      if (isFlat) {
        if (!isFirst || (isObject && bracketSpacing)) {
          o[ol] = 32;
          ol = ((ol | 0) + 1) | 0;
          column = column + 1;
        }
      } else {
        let newLine = true;
        if ((fl & F_CONCISE) !== 0 && !isFirst && !isAfterBlank) {
          const comma = (nodes[b + N_NEXT] | 0) === frameEnd ? trailingComma : 1;
          if (column + 1 + comma + (nodes[b + N_WIDTH] | 0) <= printWidth) {
            o[ol] = 32;
            ol = ((ol | 0) + 1) | 0;
            column = column + 1;
            newLine = false;
          }
        } else if (isAfterBlank) {
          if (crlf) {
            o[ol] = 13;
            o[ol + 1] = 10;
            ol = ((ol | 0) + 2) | 0;
          } else {
            o[ol] = lineEndingByte;
            ol = ((ol | 0) + 1) | 0;
          }
        }
        if (newLine) {
          // new_line()
          if (ol > MAX_STRING_LENGTH) {
            isTooLong = true;
          } else {
            if (crlf) {
              o[ol] = 13;
              o[ol + 1] = 10;
              ol = ((ol | 0) + 2) | 0;
            } else {
              o[ol] = lineEndingByte;
              ol = ((ol | 0) + 1) | 0;
            }
            if (!isTab) {
              column = alignment + level * indentWidth;
              const end = (ol | 0) + (column | 0);
              if (column > 16) {
                o.fill(32, ol, end);
                ol = end | 0;
              } else {
                while (ol < end) {
                  o[ol] = 32;
                  ol = ((ol | 0) + 1) | 0;
                }
              }
            } else {
              const tabs0 = ((alignment / tabUnit) | 0) + level;
              const spaces = alignment % tabUnit;
              if (tabs0 === 0) {
                const end = (ol | 0) + (spaces | 0);
                while (ol < end) {
                  o[ol] = 32;
                  ol = ((ol | 0) + 1) | 0;
                }
                column = spaces;
              } else {
                const tabs = tabs0 + (spaces > 0 ? 1 : 0);
                column = tabs * indentWidth;
                const end = (ol | 0) + (tabs | 0);
                while (ol < end) {
                  o[ol] = 9;
                  ol = ((ol | 0) + 1) | 0;
                }
              }
            }
          }
        }
      }
      if (isObject) {
        // name(node)
        const nf = nodes[b + N_FLAGS] | 0;
        const ns = nodes[b + N_START] | 0;
        const ne = nodes[b + N_END] | 0;
        const nw = nodes[b + N_WIDTH] | 0;
        if ((nf & UNQUOTED) !== 0) {
          copyRun(o, odv, ol, text, sdv, ns + 1, ne - 1);
          ol = ((ol | 0) + ((ne - ns - 2) | 0)) | 0;
          column = column + nw;
        } else if ((nf & QUOTED) !== 0) {
          const q = cfg.nameQuote === 0 ? 34 : 39;
          o[ol] = q;
          ol = ((ol | 0) + 1) | 0;
          column = column + nw;
          out.len = ol;
          scalarSlow(text, nodes, b, cfg, out);
          ol = out.len;
          o = out.data;
          oc = o.length;
          odv = new DataView(o.buffer, o.byteOffset, o.byteLength);
          o[ol] = q;
          ol = ((ol | 0) + 1) | 0;
        } else {
          column = column + nw;
          if ((kind === K_STRING || kind === K_NUMBER || kind === K_IDENTIFIER) && (nf & REWRITTEN) === 0 && nw !== MUST_BREAK) {
            copyRun(o, odv, ol, text, sdv, ns, ne);
            ol = ((ol | 0) + ((ne - ns) | 0)) | 0;
          } else {
            out.len = ol;
            const col = scalarSlow(text, nodes, b, cfg, out);
            if (col >= 0) column = col;
            ol = out.len;
            o = out.data;
            oc = o.length;
            odv = new DataView(o.buffer, o.byteOffset, o.byteLength);
          }
        }
        o[ol] = 58;
        o[ol + 1] = 32;
        ol = ((ol | 0) + 2) | 0;
        column = column + 2;
        index = index + 1;
        if (index >= nodeCount) break;
        node = index;
        b = index << 3;
        kind = nodes[b + N_KIND] | 0;
        // The value may need room too.
        let need2 = indentBytes + 16;
        if (kind !== K_OBJECT && kind !== K_ARRAY) need2 = need2 + 2 * ((nodes[b + N_END] | 0) - (nodes[b + N_START] | 0));
        if (ol + need2 > oc) {
          out.len = ol;
          out.grow(ol + need2);
          o = out.data;
          oc = o.length;
          odv = new DataView(o.buffer, o.byteOffset, o.byteLength);
        }
      }
      if (((nodes[b + N_FLAGS] | 0) & BLANK_AFTER) !== 0) fl = fl | F_AFTER_BLANK;
      if (kind === K_HOLE) fl = fl | F_AFTER_HOLE;
      else fl = fl & ~F_AFTER_HOLE;
      fr[fi + 1] = fl | 0;
      rest = (nodes[b + N_NEXT] | 0) === frameEnd ? trailingComma : 1;
    }

    index = index + 1;
    if (kind !== K_OBJECT && kind !== K_ARRAY) {
      if (kind === K_UNARY) {
        const sb = nodes[b + N_START] | 0;
        if (!(isStringify && (text[sb] | 0) === 43)) {
          o[ol] = text[sb] | 0;
          ol = ((ol | 0) + 1) | 0;
          column = column + 1;
        }
        if (index < nodeCount) {
          const ob = index << 3;
          const needOp = 2 * ((nodes[ob + N_END] | 0) - (nodes[ob + N_START] | 0)) + 16;
          if (ol + needOp > oc) {
            out.len = ol;
            out.grow(ol + needOp);
            o = out.data;
            oc = o.length;
            odv = new DataView(o.buffer, o.byteOffset, o.byteLength);
          }
          // scalar(operand)
          const ok = nodes[ob + N_KIND] | 0;
          const of = nodes[ob + N_FLAGS] | 0;
          const ow = nodes[ob + N_WIDTH] | 0;
          column = column + ow;
          if ((ok === K_STRING || ok === K_NUMBER || ok === K_IDENTIFIER) && (of & REWRITTEN) === 0 && ow !== MUST_BREAK) {
            const os = nodes[ob + N_START] | 0;
            const oe = nodes[ob + N_END] | 0;
            copyRun(o, odv, ol, text, sdv, os, oe);
            ol = ((ol | 0) + ((oe - os) | 0)) | 0;
          } else {
            out.len = ol;
            const col = scalarSlow(text, nodes, ob, cfg, out);
            if (col >= 0) column = col;
            ol = out.len;
            o = out.data;
            oc = o.length;
            odv = new DataView(o.buffer, o.byteOffset, o.byteLength);
          }
        }
        index = index + 1;
      } else {
        // scalar(node)
        const nf = nodes[b + N_FLAGS] | 0;
        const nw = nodes[b + N_WIDTH] | 0;
        column = column + nw;
        if ((kind === K_STRING || kind === K_NUMBER || kind === K_IDENTIFIER) && (nf & REWRITTEN) === 0 && nw !== MUST_BREAK) {
          const ns = nodes[b + N_START] | 0;
          const ne = nodes[b + N_END] | 0;
          copyRun(o, odv, ol, text, sdv, ns, ne);
          ol = ((ol | 0) + ((ne - ns) | 0)) | 0;
        } else {
          out.len = ol;
          const col = scalarSlow(text, nodes, b, cfg, out);
          if (col >= 0) column = col;
          ol = out.len;
          o = out.data;
          oc = o.length;
          odv = new DataView(o.buffer, o.byteOffset, o.byteLength);
        }
      }
      continue;
    }
    const isObject = kind === K_OBJECT;
    if ((nodes[b + N_COUNT] | 0) === 0) {
      o[ol] = isObject ? 123 : 91;
      o[ol + 1] = isObject ? 125 : 93;
      ol = ((ol | 0) + 2) | 0;
      column = column + 2;
      continue;
    }
    const w = nodes[b + N_WIDTH] | 0;
    isFlat = isFlat || (w !== MUST_BREAK && column + w + rest <= printWidth);
    o[ol] = isObject ? 123 : 91;
    ol = ((ol | 0) + 1) | 0;
    column = column + 1;
    if (!isFlat) level = level + 1;
    if ((depth << 1) + 2 > fr.length) {
      growFrames();
      fr = frames;
    }
    fr[depth << 1] = nodes[b + N_NEXT] | 0;
    fr[(depth << 1) + 1] = (isObject ? F_OBJECT : 0) | (isFlat ? F_FLAT : 0) | (((nodes[b + N_FLAGS] | 0) & CONCISE) !== 0 ? F_CONCISE : 0) | F_FIRST;
    depth = depth + 1;
  }
  if (ol + 2 > oc) {
    out.len = ol;
    out.grow(ol + 2);
    o = out.data;
  }
  if (crlf) {
    o[ol] = 13;
    o[ol + 1] = 10;
    ol = ((ol | 0) + 2) | 0;
  } else {
    o[ol] = lineEndingByte;
    ol = ((ol | 0) + 1) | 0;
  }
  out.len = ol;
  return isTooLong ? FORMAT_TOO_LONG : FORMAT_OK;
}

/** Copies src[a, b) to dst[at...], eight bytes at a time (`dv`, `sdv`: views of `dst` and `src`). */
function copyRun(dst: Uint8Array, dv: DataView, at: number, src: Uint8Array, sdv: DataView, a: number, b: number): void {
  let i = a | 0;
  let p = at | 0;
  const e8 = ((b | 0) - 8) | 0;
  while (i <= e8) {
    dv.setInt32(p, sdv.getInt32(i, true) | 0, true);
    dv.setInt32(((p | 0) + 4) | 0, sdv.getInt32(((i | 0) + 4) | 0, true) | 0, true);
    i = ((i | 0) + 8) | 0;
    p = ((p | 0) + 8) | 0;
  }
  while (i < b) {
    dst[p] = src[i] | 0;
    i = ((i | 0) + 1) | 0;
    p = ((p | 0) + 1) | 0;
  }
}

/**
 * Anything but an object, an array and a sign, written the slow way: what is not written as it is in the source, which is
 * text[start, end), or not always. Appends to `out`. Returns the column behind it if that is known (a string of several
 * lines), else -1.
 */
function scalarSlow(text: Uint8Array, nodes: Int32Array, b: number, cfg: Config, out: ByteBuf): number {
  const start = nodes[b + N_START] | 0;
  const end = nodes[b + N_END] | 0;
  const kind = nodes[b + N_KIND] | 0;
  const width = nodes[b + N_WIDTH] | 0;
  const flags = nodes[b + N_FLAGS] | 0;
  const le = cfg.lineEnding;
  let column = -1;
  // What follows a name of several lines is behind the last of them.
  if (width === MUST_BREAK) {
    let lb = -1;
    for (let i = end - 1; i >= start; i--) {
      if ((text[i] | 0) === 10) {
        lb = i;
        break;
      }
    }
    if (lb >= 0) column = stringWidth(text, lb + 1, end);
  }
  if (kind === K_HOLE && cfg.parser === PARSER_STRINGIFY) {
    out.append(NULL_BYTES, 0, 4);
  } else if (kind === K_TEMPLATE && cfg.parser === PARSER_STRINGIFY) {
    writeTemplateAsString(text, start, end, out);
  } else if (kind === K_STRING && (flags & REWRITTEN) !== 0) {
    const quote = (text[start] | 0) === 34 ? 39 : 34;
    const at = out.len;
    makeString(text, start + 1, end > start + 1 ? end - 1 : start + 1, quote, out);
    // The line break behind a `\` is written like every other.
    if (le !== LE_LF) {
      let hasLineBreak = false;
      for (let i = at; i < out.len; i++) {
        if ((out.data[i] | 0) === 10) {
          hasLineBreak = true;
          break;
        }
      }
      if (hasLineBreak) {
        const written = out.data.slice(at, out.len);
        out.len = at;
        writeWithLineEnding(written, 0, written.length, le, out);
      }
    }
  } else if (kind === K_NUMBER && (flags & REWRITTEN) !== 0) {
    const r = trimmedNumber(text, start, end);
    if (r < 0) out.append(text, start, end);
    else out.append(numBuf(), 0, r);
  } else if ((kind === K_STRING || kind === K_TEMPLATE) && width === MUST_BREAK && le !== LE_LF) {
    let runStart = start;
    for (let i = start; i < end; i++) {
      if ((text[i] | 0) === 10) {
        out.append(text, runStart, i);
        pushLineEnding(out, le);
        runStart = i + 1;
      }
    }
    out.append(text, runStart, end);
  } else {
    out.append(text, start, end);
  }
  return column;
}

const NULL_BYTES = new Uint8Array([110, 117, 108, 108]);

function hexVal(b: number): number {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  if (b >= 65 && b <= 70) return b - 55;
  return -1;
}

/** The value of the hex digits text[a, b), or -1 if one is not a digit or it does not fit in 32 bits. */
function hexRun(text: Uint8Array, a: number, b: number): number {
  let v = 0;
  for (let i = a; i < b; i++) {
    const d = hexVal(text[i] | 0);
    if (d < 0) return -1;
    v = v * 16 + d;
    if (v > 0xffffffff) return -1;
  }
  return v;
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
  } else if (cp <= 0x10ffff) {
    buf.push(0xf0 | (cp >> 18));
    buf.push(0x80 | ((cp >> 12) & 0x3f));
    buf.push(0x80 | ((cp >> 6) & 0x3f));
    buf.push(0x80 | (cp & 0x3f));
  } else {
    // Not a code point.
    buf.push(0xef);
    buf.push(0xbf);
    buf.push(0xbd);
  }
}

/** `JSON.stringify` of the value of the template text[start, end), which has no substitutions. */
function writeTemplateAsString(text: Uint8Array, start: number, end: number, out: ByteBuf): void {
  const rawEnd = end > start + 1 ? end - 1 : start + 1;
  const cooked$ = cooked;
  cooked$.reset();
  let i = start + 1;
  while (i < rawEnd) {
    const byte = text[i] | 0;
    i = i + 1;
    if (byte !== 92) {
      cooked$.push(byte);
      continue;
    }
    if (i >= rawEnd) break;
    const escaped = text[i] | 0;
    i = i + 1;
    switch (escaped) {
      case 110: cooked$.push(10); break;
      case 116: cooked$.push(9); break;
      case 114: cooked$.push(13); break;
      case 98: cooked$.push(8); break;
      case 102: cooked$.push(12); break;
      case 118: cooked$.push(11); break;
      case 48: cooked$.push(0); break;
      // A line continuation
      case 10: break;
      case 120: {
        if (i + 2 <= rawEnd) {
          const v = hexRun(text, i, i + 2);
          if (v >= 0) {
            pushWtf8(cooked$, v);
            i = i + 2;
          }
        }
        break;
      }
      case 117: {
        if (i < rawEnd && (text[i] | 0) === 123) {
          let len = 0;
          while (i + len < rawEnd && (text[i + len] | 0) !== 125) len = len + 1;
          // rest.get(1..len)
          if (len >= 1) {
            const v = hexRun(text, i + 1, i + len);
            if (v >= 0) pushWtf8(cooked$, v);
          }
          i = i + len + 1 <= rawEnd ? i + len + 1 : rawEnd;
        } else if (i + 4 <= rawEnd) {
          const v = hexRun(text, i, i + 4);
          if (v >= 0) {
            pushWtf8(cooked$, v);
            i = i + 4;
          }
        }
        break;
      }
      default:
        cooked$.push(escaped);
    }
  }
  jsonStringify(cooked$.data, 0, cooked$.len, out);
}
