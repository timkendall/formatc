// Port of vendor/bun/src/format/js/utils/array.rs.
import { Formatter } from "../../ir/formatter.ts";
import { COMMA } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT, FTC_ES5 } from "../../options.ts";
import { EXPR_MISSING, exprTag, listAt, patElemPat } from "../../../lint/ast/index.ts";
import { isNextLineEmpty, skipInlineComment, skipTrailingComment } from "../../text.ts";
import { WK_EXPR, WK_PAT_ELEM, nodeSpanOf, writeNode } from "../format.ts";
import { SP } from "../../../lint/ast/index.ts";

/** For Prettier an empty line between two elements is kept if the array breaks. For oxfmt it breaks the array. From the first hole on, and before it, oxfmt keeps none. */
function emptyLineBetweenElementsBreaksArray(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** Whether the element `h` of kind `wk` (`WK_EXPR` or `WK_PAT_ELEM`) is a hole: `[a, , b]`. */
function isHole(wk: number, h: number): boolean {
  return wk === WK_EXPR ? exprTag(h) === EXPR_MISSING : patElemPat(h) < 0;
}

/**
 * Prettier's `printArrayElements`: the elements of an array literal or an array pattern, each on its own line if they do not fit on one.
 * A hole is written as the comma after it. `wk`: the kind of the elements (`WK_EXPR` for an array literal or an array assignment target, `WK_PAT_ELEM`
 * for an array pattern); the list `(start, n)` has their ids, the first `n` of the `len` elements: the Rust callers leave out a rest element that they
 * write themselves afterwards. `len`: the number of elements, including that one. The line break before it is written here.
 */
export function writeArrayNode(len: number, wk: number, start: number, n: number, f: Formatter): void {
  const lastIndex = len > 0 ? len - 1 : 0;
  const breaksAtEmptyLines = emptyLineBetweenElementsBreaksArray(f);
  const text = f.source;
  let hasSeenHole = false;
  for (let index = 0; index < n; index++) {
    const h = listAt(start, index);
    const hole = isHole(wk, h);
    if (hole) hasSeenHole = true;
    if (!hole) {
      f.startGroup();
      writeNode(wk, h, f);
      f.endGroup();
      if (index !== lastIndex) f.token(COMMA);
      else f.writeTrailingCommas(FTC_ES5, COMMA);
    } else {
      f.token(COMMA);
    }
    if (index !== lastIndex) {
      // An empty line after an element is kept if the array breaks.
      const isBeforeHole = index + 1 < n && isHole(wk, listAt(start, index + 1));
      let emptyAfter = false;
      if (!hole) {
        nodeSpanOf(wk, h);
        emptyAfter = isLineAfterElementEmpty(text, SP[1] | 0);
      }
      if (emptyAfter && !breaksAtEmptyLines) f.softEmptyLineOrSpace();
      else if (emptyAfter && !hasSeenHole && !isBeforeHole) f.emptyLine();
      else f.softLineBreakOrSpace();
    }
  }
}

/** Prettier's `isLineAfterElementEmpty`: the line after the comma that follows the element that ends at `end` is empty. */
export function isLineAfterElementEmpty(text: Uint8Array, end: number): boolean {
  let at = end;
  while (at < text.length && (text[at] | 0) !== 44) at = skipInlineComment(text, skipTrailingComment(text, at + 1));
  return isNextLineEmpty(text, at);
}
