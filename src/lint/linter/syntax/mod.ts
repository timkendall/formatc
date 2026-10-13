// The part of vendor/bun/src/lint/linter/syntax/mod.rs that the formatter uses (the rest, `refused_by_prettier` and the parsers' error tables,
// is the driver's business: whether Prettier would refuse a file).
import { skipTrivia } from "../../../sema/check/spans.ts";

/**
 * `goes_to_flow(text, path)`: Prettier's `isFlowFile`: it has `babel-flow` parse the file in place of `babel`. There is `@flow` or `@noflow`
 * in a comment before the code, or the name of the file ends with `.js.flow`. `text`: the source bytes `text[0, len)`.
 */
export function goesToFlow(text: Uint8Array, len: number, path: string): boolean {
  let afterShebang = 0;
  if (len >= 2 && (text[0] | 0) === 35 && (text[1] | 0) === 33) {
    afterShebang = len;
    for (let i = 0; i < len; i++) {
      const c = text[i] | 0;
      if (c === 10 || c === 13) {
        afterShebang = i;
        break;
      }
    }
  }
  const code = skipTrivia(text, len, afterShebang);
  let at = afterShebang;
  while (at < code) {
    // the next `@` in the comments
    if ((text[at] | 0) !== 64) {
      at = ((at | 0) + 1) | 0;
      continue;
    }
    let p = (at + 1) | 0;
    if (p + 1 < code && (text[p] | 0) === 110 && (text[p + 1] | 0) === 111) p = ((p | 0) + 2) | 0;
    if (p + 4 <= code && (text[p] | 0) === 102 && (text[p + 1] | 0) === 108 && (text[p + 2] | 0) === 111 && (text[p + 3] | 0) === 119) {
      const after = p + 4;
      const c = after < code ? text[after] | 0 : -1;
      const isWord = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
      if (!isWord) return true;
    }
    at = ((at | 0) + 1) | 0;
  }
  return path.endsWith(".js.flow");
}
