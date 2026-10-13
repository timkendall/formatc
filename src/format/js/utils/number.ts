// Port of vendor/bun/src/format/js/utils/number.rs: Prettier's `printNumber`.
//
// `trimmedNumber` is `format_trimmed_number` without a `Cow`: -1 if the number is written as it is, else the length of what is written, which is
// `numBuf()[0 .. n)` (valid until the next call). `src/format/json/util.ts` re-exports it.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { Formatter } from "../../ir/formatter.ts";

// The result of `trimmedNumber`: bytes [0, numLen()) of `numBuf()`.
let NB = new Uint8Array(64);
let nbLen = 0;

export function numBuf(): Uint8Array {
  return NB;
}
export function numLen(): number {
  return nbLen;
}

function numEnsure(n: number): void {
  if (n > NB.length) {
    let cap = NB.length;
    while (cap < n) cap = cap * 2;
    const nb = new Uint8Array(cap);
    nb.set(NB);
    NB = nb;
  }
}

function numDrain(from: number, to: number): void {
  const n = nbLen;
  const cnt = to - from;
  for (let i = to; i < n; i++) NB[i - cnt] = NB[i] | 0;
  nbLen = n - cnt;
}

function numNextDot(from: number): number {
  const n = nbLen;
  for (let i = from; i < n; i++) if ((NB[i] | 0) === 46) return i;
  return -1;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/**
 * Prettier's `printNumber` (`format_trimmed_number`) of text[start, end): -1 if the number is written as it is, else
 * the length of what is written, which is in `numBuf()` (valid until the next call).
 *
 * - Lowercase everything: `0XAB` is `0xab`, `1E5` is `1e5`.
 * - No `+` and no leading zeros in the exponent: `1e+05` is `1e5`. No exponent that is zero.
 * - A digit before the dot: `.5` is `0.5`.
 * - No trailing zeros after the dot, except for one if there is nothing else: `1.50` is `1.5`, `1.00` is `1.0`.
 * - No trailing dot: `1.` is `1`.
 *
 * Prettier does this with regular expressions that know nothing about `_`, so a separator in the wrong place keeps a rule
 * from being applied: `1_0.50` is `1_0.5`, `1.5_0` stays.
 */
export function trimmedNumber(text: Uint8Array, start: number, end: number): number {
  const len = end - start;
  if (len === 1) return -1;
  // The usual numbers: digits and at most one dot, none of the rewrites applies.
  {
    let dot = -1;
    let ok = true;
    for (let i = start; i < end; i++) {
      const c = text[i] | 0;
      if (c >= 48 && c <= 57) continue;
      if (c === 46 && dot < 0) {
        dot = i;
        continue;
      }
      ok = false;
      break;
    }
    if (ok) {
      if (dot < 0) return -1;
      if (dot > start && dot < end - 1 && ((text[end - 1] | 0) !== 48 || end - dot === 2)) return -1;
    }
  }
  numEnsure(len + 2);
  for (let i = 0; i < len; i++) {
    const c = text[start + i] | 0;
    NB[i] = (c >= 65 && c <= 90 ? c + 32 : c) | 0;
  }
  nbLen = len;

  let mantissa = 0;
  while (mantissa < nbLen) {
    const c = NB[mantissa] | 0;
    if (!isDigit(c) && c !== 46) break;
    mantissa = mantissa + 1;
  }
  if (mantissa > 0 && mantissa < nbLen && (NB[mantissa] | 0) === 101) {
    // `^([\d.]+e)(?:\+|(-))?0*(?=\d)` becomes `$1$2`
    const sign = mantissa + 1;
    let digits = sign;
    if (sign < nbLen && ((NB[sign] | 0) === 43 || (NB[sign] | 0) === 45)) digits = digits + 1;
    let zeros = 0;
    while (digits + zeros < nbLen && (NB[digits + zeros] | 0) === 48) zeros = zeros + 1;
    const nextIsDigit = digits + zeros < nbLen && isDigit(NB[digits + zeros] | 0);
    const removedZeros = nextIsDigit ? zeros : zeros > 0 ? zeros - 1 : 0;
    if (digits + removedZeros < nbLen && isDigit(NB[digits + removedZeros] | 0)) {
      numDrain(digits, digits + removedZeros);
      if (sign < nbLen && (NB[sign] | 0) === 43) numDrain(sign, sign + 1);
    }
    // `^([\d.]+)e[+-]?0+$` becomes `$1`
    let digits2 = sign;
    if (sign < nbLen && ((NB[sign] | 0) === 43 || (NB[sign] | 0) === 45)) digits2 = digits2 + 1;
    if (digits2 < nbLen) {
      let allZero = true;
      for (let i = digits2; i < nbLen; i++) {
        if ((NB[i] | 0) !== 48) {
          allZero = false;
          break;
        }
      }
      if (allZero) nbLen = mantissa;
    }
  }

  // `^\.` becomes `0.`
  if (nbLen > 0 && (NB[0] | 0) === 46) {
    for (let i = nbLen; i > 0; i--) NB[i] = NB[i - 1] | 0;
    NB[0] = 48;
    nbLen = nbLen + 1;
  }

  // Angular takes a number with more than one dot. Each of the two is done at the first dot where it can be.
  // `(\.\d+?)0+(?=e|$)` becomes `$1`
  let from = 0;
  while (true) {
    const dot = numNextDot(from);
    if (dot < 0) break;
    const fraction = dot + 1;
    let fe = fraction;
    while (fe < nbLen && isDigit(NB[fe] | 0)) fe = fe + 1;
    if (fe === nbLen || (NB[fe] | 0) === 101) {
      let zeros = 0;
      while (fe - 1 - zeros >= fraction && (NB[fe - 1 - zeros] | 0) === 48) zeros = zeros + 1;
      const keptEnd = fe - zeros > fraction + 1 ? fe - zeros : fraction + 1;
      if (keptEnd < fe) {
        numDrain(keptEnd, fe);
        break;
      }
    }
    from = fraction;
  }
  // `\.(?=e|$)` is removed
  from = 0;
  while (true) {
    const dot = numNextDot(from);
    if (dot < 0) break;
    if (dot + 1 === nbLen || (NB[dot + 1] | 0) === 101) {
      numDrain(dot, dot + 1);
      break;
    }
    from = dot + 1;
  }

  if (nbLen === len) {
    let same = true;
    for (let i = 0; i < len; i++) {
      if ((NB[i] | 0) !== (text[start + i] | 0)) {
        same = false;
        break;
      }
    }
    if (same) return -1;
  }
  return nbLen;
}


/**
 * `format_trimmed_number(text)`: Prettier's `printNumber` on `text[start, end)`. Appends the result to `out`.
 */
export function formatTrimmedNumber(text: Uint8Array, start: number, end: number, out: ByteBuf): void {
  const n = trimmedNumber(text, start, end);
  if (n < 0) out.append(text, start, end);
  else out.append(NB, 0, n);
}

/** `format_number_token(text)`: the number as it is written in the output (with its `_`, `n`, `0x` ..). Appends to `out`. */
export function formatNumberToken(text: Uint8Array, start: number, end: number, out: ByteBuf): void {
  formatTrimmedNumber(text, start, end, out);
}

/** `write!(f, format_number_token(f.source[start, end)))` */
export function writeNumberToken(start: number, end: number, f: Formatter): void {
  const n = trimmedNumber(f.source, start, end);
  if (n < 0) f.textSourceNoWs(start, end);
  else f.textBytesNoWs(NB, 0, n);
}
