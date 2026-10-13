// Port of vendor/bun/src/md/autolinks.rs: permissive autolinks (GFM literal URLs, emails and www.).
import { ED_CLOSE_COUNT, ED_COUNT, ED_OPEN_COUNT, ED_POS, ED_W } from "./state.ts";
import type { Parser } from "./state.ts";
import { isAlphaNum } from "./helpers.ts";

export function isListBullet(c: number): boolean {
  return c === 45 || c === 43 || c === 42;
}

export function isListItemMark(c: number): boolean {
  return c === 45 || c === 43 || c === 42 || c === 46 || c === 41;
}

function setOf(bytes: string): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) t[bytes.charCodeAt(i)] = 1;
  return t;
}

const EMPH_DELIMS = setOf("*_~");
const LEFT_BOUNDARY = setOf(" \t\n\r\x0B\x0C({[");
const RIGHT_BOUNDARY = setOf(" \t\n\r\x0B\x0C)}]<.!?,;&");
const SET_HOST = setOf(".-_");
const SET_PATH = setOf("/.-_~*+%");
const SET_QUERY = setOf("&.-+_=()~*%");
const SET_FRAG = setOf(".-+_~*%");
const SET_EMAIL_USER = setOf(".-_+");

/** Check left boundary for permissive autolinks. When `allowEmph` is true, emphasis delimiters (*_~) are also valid boundaries. */
function checkLeftBoundary(cb: Uint8Array, co: number, pos: number, allowEmph: boolean): boolean {
  if (pos === 0) return true;
  const c = cb[co + pos - 1] | 0;
  return (LEFT_BOUNDARY[c] | 0) !== 0 || (allowEmph && (EMPH_DELIMS[c] | 0) !== 0);
}

/** Check right boundary for permissive autolinks. */
function checkRightBoundary(cb: Uint8Array, co: number, cl: number, pos: number, allowEmph: boolean): boolean {
  if (pos >= cl) return true;
  const c = cb[co + pos] | 0;
  return (RIGHT_BOUNDARY[c] | 0) !== 0 || (allowEmph && (EMPH_DELIMS[c] | 0) !== 0);
}

/**
 * Check that emphasis chars at autolink boundaries are actually resolved delimiters (`ed[rs, re)`). Called when the
 * relaxed (allow_emph) pass found an autolink but the strict pass didn't.
 */
export function isEmphBoundaryResolved(
  p: Parser,
  cb: Uint8Array,
  co: number,
  cl: number,
  beg: number,
  end: number,
  rs: number,
  re: number,
): boolean {
  const ed = p.ed;
  // Check left boundary: if it's an emphasis char, it must be a resolved delimiter
  if (beg > 0) {
    const prev = cb[co + beg - 1] | 0;
    if (prev === 42 || prev === 95 || prev === 126) {
      if (!checkLeftBoundary(cb, co, beg, false)) {
        // Left boundary failed strict check, emphasis char caused the relaxed match. Verify it's actually resolved.
        let foundResolved = false;
        for (let k = rs; k < re; k++) {
          const di = k * ED_W;
          const dpos = ed[di + ED_POS] | 0;
          if (
            dpos < beg &&
            beg - 1 < dpos + (ed[di + ED_COUNT] | 0) &&
            (ed[di + ED_OPEN_COUNT] | 0) + (ed[di + ED_CLOSE_COUNT] | 0) > 0
          ) {
            foundResolved = true;
            break;
          }
        }
        if (!foundResolved) return false;
      }
    }
  }
  // Check right boundary: if it's an emphasis char, it must be a resolved delimiter
  if (end < cl) {
    const next = cb[co + end] | 0;
    if (next === 42 || next === 95 || next === 126) {
      if (!checkRightBoundary(cb, co, cl, end, false)) {
        let foundResolved = false;
        for (let k = rs; k < re; k++) {
          const di = k * ED_W;
          const dpos = ed[di + ED_POS] | 0;
          if (
            dpos <= end &&
            end < dpos + (ed[di + ED_COUNT] | 0) &&
            (ed[di + ED_OPEN_COUNT] | 0) + (ed[di + ED_CLOSE_COUNT] | 0) > 0
          ) {
            foundResolved = true;
            break;
          }
        }
        if (!foundResolved) return false;
      }
    }
  }
  return true;
}

// End of the last component scanned by `scanUrlComponent`.
let scEnd = 0;

/**
 * Scan a URL component (host, path, query, or fragment) following md4c's URL_MAP. Returns the `ok` of Rust's
 * `ScanResult`; the `end` is in `scEnd`.
 */
function scanUrlComponent(
  cb: Uint8Array,
  co: number,
  cl: number,
  start: number,
  startChar: number,
  delimChar: number,
  allowed: Uint8Array,
  minComponents: number,
  optionalEndChar: number,
): boolean {
  let pos = start | 0;
  let nComponents = 0;
  // Check start character
  if (startChar !== 0) {
    if (pos >= cl || (cb[co + pos] | 0) !== startChar) {
      scEnd = pos;
      return minComponents === 0;
    }
    if (minComponents > 0 && (pos + 1 >= cl || !isAlphaNum(cb[co + pos + 1] | 0))) {
      scEnd = pos;
      return minComponents === 0;
    }
    pos = ((pos | 0) + 1) | 0;
  }

  while (pos < cl) {
    const c = cb[co + pos] | 0;
    if (isAlphaNum(c)) {
      if (nComponents === 0) nComponents = 1;
      pos = ((pos | 0) + 1) | 0;
    } else if (
      (allowed[c] | 0) !== 0 &&
      ((pos > 0 &&
        (isAlphaNum(cb[co + pos - 1] | 0) || (cb[co + pos - 1] | 0) === 41 || (allowed[cb[co + pos - 1] | 0] | 0) !== 0)) ||
        c === 40) &&
      ((pos + 1 < cl &&
        (isAlphaNum(cb[co + pos + 1] | 0) || (cb[co + pos + 1] | 0) === 40 || (allowed[cb[co + pos + 1] | 0] | 0) !== 0)) ||
        c === 41)
    ) {
      if (c === delimChar) nComponents = ((nComponents | 0) + 1) | 0;
      pos = ((pos | 0) + 1) | 0;
    } else {
      break;
    }
  }

  if (pos < cl && optionalEndChar !== 0 && (cb[co + pos] | 0) === optionalEndChar) pos = ((pos | 0) + 1) | 0;

  scEnd = pos;
  return nComponents >= minComponents;
}

function ciEq(cb: Uint8Array, at: number, lit: string): boolean {
  for (let i = 0; i < lit.length; i++) {
    let c = cb[at + i] | 0;
    if (c >= 65 && c <= 90) c = ((c | 0) + ((32) | 0)) | 0;
    if (c !== (lit.charCodeAt(i) | 0)) return false;
  }
  return true;
}

const SCHEMES: string[] = ["http", "https", "ftp"];

/**
 * Detect permissive autolinks at `pos` of the slice `cb[co, co + cl)`. `pos` is the position of the trigger character
 * ('@', ':', or '.'). Returns false for none; else `p.paBeg`, `p.paEnd`.
 */
export function findPermissiveAutolink(
  p: Parser,
  cb: Uint8Array,
  co: number,
  cl: number,
  pos: number,
  allowEmph: boolean,
): boolean {
  if (pos >= cl) return false;
  const c = cb[co + pos] | 0;

  if (c === 58) {
    // URL autolink: check for http://, https://, ftp://
    for (let si = 0; si < SCHEMES.length; si++) {
      const name = SCHEMES[si];
      const slen = name.length | 0;
      const suflen = 2;
      if (pos >= slen && pos + 1 + suflen < cl) {
        if (ciEq(cb, co + pos - slen, name) && (cb[co + pos + 1] | 0) === 47 && (cb[co + pos + 2] | 0) === 47) {
          const beg = pos - slen;
          if (!checkLeftBoundary(cb, co, beg, allowEmph)) continue;

          let end = pos + 1 + suflen;
          // Scan URL components: host (mandatory), path, query, fragment
          if (!scanUrlComponent(cb, co, cl, end, 0, 46, SET_HOST, 2, 0)) continue;
          end = scEnd;

          scanUrlComponent(cb, co, cl, end, 47, 47, SET_PATH, 0, 47);
          end = scEnd;

          scanUrlComponent(cb, co, cl, end, 63, 38, SET_QUERY, 1, 0);
          end = scEnd;

          scanUrlComponent(cb, co, cl, end, 35, 0, SET_FRAG, 1, 0);
          end = scEnd;

          end = postProcessAutolinkEnd(cb, co, cl, beg, end);

          if (!checkRightBoundary(cb, co, cl, end, allowEmph)) continue;

          p.paBeg = beg;
          p.paEnd = end;
          return true;
        }
      }
    }
  } else if (c === 64) {
    // Email autolink: scan backward for username, forward for domain
    if (pos === 0 || pos + 3 >= cl) return false;
    if (!isAlphaNum(cb[co + pos - 1] | 0) || !isAlphaNum(cb[co + pos + 1] | 0)) return false;

    // Scan backward for username
    let beg = pos | 0;
    while (beg > 0) {
      if (
        isAlphaNum(cb[co + beg - 1] | 0) ||
        (beg >= 2 &&
          isAlphaNum(cb[co + beg - 2] | 0) &&
          (SET_EMAIL_USER[cb[co + beg - 1] | 0] | 0) !== 0 &&
          isAlphaNum(cb[co + beg] | 0))
      ) {
        beg = ((beg | 0) - 1) | 0;
      } else {
        break;
      }
    }
    if (beg === pos) return false; // empty username

    if (!checkLeftBoundary(cb, co, beg, allowEmph)) return false;

    // Scan forward for domain (host component only for email)
    if (!scanUrlComponent(cb, co, cl, pos + 1, 0, 46, SET_HOST, 2, 0)) return false;
    const end = scEnd | 0;

    if (!checkRightBoundary(cb, co, cl, end, allowEmph)) return false;

    p.paBeg = beg;
    p.paEnd = end;
    return true;
  } else if (c === 46) {
    // WWW autolink: check for "www." prefix
    if (pos < 3) return false;
    if (!ciEq(cb, co + pos - 3, "www")) return false;

    const beg = pos - 3;
    if (!checkLeftBoundary(cb, co, beg, allowEmph)) return false;

    // Scan URL components starting from after the '.'
    let end = pos + 1;
    if (!scanUrlComponent(cb, co, cl, end, 0, 46, SET_HOST, 1, 0)) return false;
    end = scEnd;

    scanUrlComponent(cb, co, cl, end, 47, 47, SET_PATH, 0, 47);
    end = scEnd;

    scanUrlComponent(cb, co, cl, end, 63, 38, SET_QUERY, 1, 0);
    end = scEnd;

    scanUrlComponent(cb, co, cl, end, 35, 0, SET_FRAG, 1, 0);
    end = scEnd;

    end = postProcessAutolinkEnd(cb, co, cl, beg, end);

    if (!checkRightBoundary(cb, co, cl, end, allowEmph)) return false;

    p.paBeg = beg;
    p.paEnd = end;
    return true;
  }

  return false;
}

/** GFM post-processing: trim trailing unbalanced `)` and entity-like suffixes from autolink URLs. */
function postProcessAutolinkEnd(cb: Uint8Array, co: number, cl: number, beg: number, endIn: number): number {
  let end = endIn | 0;

  // Trim trailing entity-like suffixes.
  // GFM spec: "If an autolink ends in a semicolon (;), we check to see if it appears to resemble an entity reference; if
  // the preceding text is & followed by one or more alphanumeric characters."
  // Case 1: URL itself ends with `;` (e.g., `&hl;` was fully scanned)
  if (end > beg && (cb[co + end - 1] | 0) === 59) {
    let j = end - 2;
    while (j > beg && isAlphaNum(cb[co + j] | 0)) j = ((j | 0) - 1) | 0;
    if (j >= beg && (cb[co + j] | 0) === 38) end = j;
  }
  // Case 2: `;` is the next char after URL end (scanner stopped before `;`) e.g., URL = `commonmark&hl`, next char is `;`
  // → trim `&hl`
  if (end < cl && (cb[co + end] | 0) === 59 && end > beg) {
    let j = end - 1;
    while (j > beg && isAlphaNum(cb[co + j] | 0)) j = ((j | 0) - 1) | 0;
    if (j >= beg && (cb[co + j] | 0) === 38) end = j;
  }

  // Trim trailing unbalanced `)`: count all ( and ) in the URL. If closing > opening, remove trailing ) until balanced.
  let open = 0;
  let close = 0;
  for (let k = beg; k < end; k++) {
    const ch = cb[co + k] | 0;
    if (ch === 40) open = ((open | 0) + 1) | 0;
    if (ch === 41) close = ((close | 0) + 1) | 0;
  }
  while (end > beg && (cb[co + end - 1] | 0) === 41 && close > open) {
    end = ((end | 0) - 1) | 0;
    close = ((close | 0) - 1) | 0;
  }

  return end;
}
