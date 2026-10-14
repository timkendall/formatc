// Port of vendor/bun/src/format/html/tag.rs: Prettier's `language-html/print/tag.js`, as far as it makes strings, and `get-node-content.js`.
//
// Where white space counts, a line can only be broken inside of a tag. So a node may have to write the end of the tag before it, or the
// start of the one behind it: it borrows them.
import { ByteBuf } from "../../base/bytebuf.ts";
import {
  F_END_S,
  F_SPAN_E,
  F_SPAN_S,
  F_START_E,
  HAS_CONDITION,
  HAS_END_SPAN,
  HAS_HTM_COMPONENT_CLOSING_TAG,
  HAS_LEADING_SPACES,
  HAS_TRAILING_SPACES,
  HTree,
  IS_LEADING_SPACE_SENSITIVE,
  IS_SELF_CLOSING,
  IS_TRAILING_SPACE_SENSITIVE,
  K_ANGULAR_ICU_EXPRESSION,
  K_ANGULAR_LET_DECLARATION,
  K_DOC_TYPE,
  K_ELEMENT,
  K_ANGULAR_CONTROL_FLOW_BLOCK,
  K_IE_CONDITIONAL_COMMENT,
  K_IE_CONDITIONAL_END_COMMENT,
  K_IE_CONDITIONAL_START_COMMENT,
  K_INTERPOLATION,
  PRESERVES_CONTENT,
  firstChild,
  flagsOf,
  has,
  hasAny,
  hasChildren,
  hasEndSpan,
  kindOf,
  lastChild,
  lastDescendant,
  nGet,
  nameEnd,
  nameStart,
  nextOf,
  nsEnd,
  nsStart,
  parentOf,
  prevOf,
  valEnd,
  valStart,
  HAS_EXPLICIT_NAMESPACE,
} from "./ast.ts";
import { eqLit } from "./data.ts";
import { HOptions } from "./hoptions.ts";
import { hasPrettierIgnore, isPreLike, isTextLike, trimAsciiEnd } from "./utilities.ts";

const HTML5_DOCTYPE_START_MARKER = "<!doctype";

/** `(namespace, name)` of `rawName` appended. */
function pushRawName(t: HTree, id: number, out: ByteBuf): void {
  const b = t.pool.data;
  if ((flagsOf(t, id) & HAS_EXPLICIT_NAMESPACE) !== 0 && nsEnd(t, id) > nsStart(t, id)) {
    out.append(b, nsStart(t, id), nsEnd(t, id));
    out.push(58);
  }
  out.append(b, nameStart(t, id), nameEnd(t, id));
}

export function closingTag(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  if (!has(t, id, IS_SELF_CLOSING)) closingTagStart(t, o, id, out);
  closingTagEnd(t, o, id, out);
}

export function closingTagStart(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  const last = lastChild(t, id);
  if (last >= 0 && needsToBorrowParentClosingTagStartMarker(t, last)) return;
  closingTagPrefix(t, o, id, out);
  closingTagStartMarker(t, o, id, out);
}

/** Whether what follows the node writes the end of its closing tag. */
function lendsClosingTagEndMarker(t: HTree, id: number): boolean {
  const next = nextOf(t, id);
  if (next >= 0) return needsToBorrowPrevClosingTagEndMarker(t, next);
  const parent = parentOf(t, id);
  if (parent >= 0) return needsToBorrowLastChildClosingTagEndMarker(t, parent);
  return false;
}

export function closingTagEnd(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  if (lendsClosingTagEndMarker(t, id)) return;
  closingTagEndMarker(t, o, id, out);
  closingTagSuffix(t, o, id, out);
}

function closingTagPrefix(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  if (needsToBorrowLastChildClosingTagEndMarker(t, id)) {
    const last = lastChild(t, id);
    if (last >= 0) closingTagEndMarker(t, o, last, out);
  }
}

export function closingTagSuffix(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  if (needsToBorrowParentClosingTagStartMarker(t, id)) {
    const parent = parentOf(t, id);
    if (parent >= 0) closingTagStartMarker(t, o, parent, out);
  } else if (needsToBorrowNextOpeningTagStartMarker(t, id)) {
    const next = nextOf(t, id);
    if (next >= 0) openingTagStartMarker(t, o, next, out);
  }
}

export function closingTagStartMarker(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  if (shouldNotPrintClosingTag(t, id)) return;
  const kind = kindOf(t, id);
  if (kind === K_IE_CONDITIONAL_COMMENT) {
    out.appendAscii("<!");
  } else if (kind === K_ELEMENT && has(t, id, HAS_HTM_COMPONENT_CLOSING_TAG)) {
    out.appendAscii("<//");
  } else {
    out.appendAscii("</");
    pushRawName(t, id, out);
  }
}

export function closingTagEndMarker(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  if (shouldNotPrintClosingTag(t, id)) return;
  const kind = kindOf(t, id);
  if (kind === K_IE_CONDITIONAL_COMMENT || kind === K_IE_CONDITIONAL_END_COMMENT) out.appendAscii("[endif]-->");
  else if (kind === K_IE_CONDITIONAL_START_COMMENT) out.appendAscii("]><!-->");
  else if (kind === K_INTERPOLATION) out.appendAscii("}}");
  else if (kind === K_ANGULAR_ICU_EXPRESSION) out.appendAscii("}");
  else if (kind === K_ELEMENT && has(t, id, IS_SELF_CLOSING)) out.appendAscii("/>");
  else out.appendAscii(">");
}

/**
 * Whether what is in `id` is written as it is, and `id` has no end tag that says where that ends. Prettier takes it to be empty:
 * `<pre><b>a</b>` becomes `<pre>>`. Here it is written to its end, and gets no end tag.
 */
export function isWrittenToItsEnd(t: HTree, id: number): boolean {
  return has(t, id, PRESERVES_CONTENT) && !hasAny(t, id, IS_SELF_CLOSING | HAS_END_SPAN) && hasChildren(t, id);
}

function shouldNotPrintClosingTag(t: HTree, id: number): boolean {
  if (hasAny(t, id, IS_SELF_CLOSING | HAS_END_SPAN)) return false;
  if (hasPrettierIgnore(t, id) || isWrittenToItsEnd(t, id)) return true;
  const parent = parentOf(t, id);
  return parent >= 0 && has(t, parent, PRESERVES_CONTENT);
}

/**
 * ```html
 * <p></p
 * >123
 * ```
 */
export function needsToBorrowPrevClosingTagEndMarker(t: HTree, id: number): boolean {
  if ((flagsOf(t, id) & (IS_LEADING_SPACE_SENSITIVE | HAS_LEADING_SPACES)) !== IS_LEADING_SPACE_SENSITIVE) return false;
  if (kindOf(t, id) === K_ANGULAR_CONTROL_FLOW_BLOCK) return false;
  const prev = prevOf(t, id);
  return prev >= 0 && kindOf(t, prev) !== K_DOC_TYPE && !isTextLike(t, prev);
}

/**
 * ```html
 * <p
 *   ><a></a
 *   ></p
 * >
 * ```
 */
export function needsToBorrowLastChildClosingTagEndMarker(t: HTree, id: number): boolean {
  const last = lastChild(t, id);
  if (last < 0) return false;
  return (
    (flagsOf(t, last) & (IS_TRAILING_SPACE_SENSITIVE | HAS_TRAILING_SPACES)) === IS_TRAILING_SPACE_SENSITIVE &&
    !isTextLike(t, lastDescendant(t, last)) &&
    !isPreLike(t, id)
  );
}

/**
 * ```html
 * <p>
 *   123</p
 * >
 * ```
 */
export function needsToBorrowParentClosingTagStartMarker(t: HTree, id: number): boolean {
  return (
    nextOf(t, id) < 0 &&
    (flagsOf(t, id) & (IS_TRAILING_SPACE_SENSITIVE | HAS_TRAILING_SPACES)) === IS_TRAILING_SPACE_SENSITIVE &&
    isTextLike(t, lastDescendant(t, id))
  );
}

/**
 * ```html
 * 123<p
 * >
 * ```
 */
export function needsToBorrowNextOpeningTagStartMarker(t: HTree, id: number): boolean {
  if (!isTextLike(t, id)) return false;
  if ((flagsOf(t, id) & (IS_TRAILING_SPACE_SENSITIVE | HAS_TRAILING_SPACES)) !== IS_TRAILING_SPACE_SENSITIVE) return false;
  const next = nextOf(t, id);
  return next >= 0 && !isTextLike(t, next);
}

/**
 * ```html
 * <p
 *   >123
 * ```
 */
export function needsToBorrowParentOpeningTagEndMarker(t: HTree, id: number): boolean {
  return prevOf(t, id) < 0 && (flagsOf(t, id) & (IS_LEADING_SPACE_SENSITIVE | HAS_LEADING_SPACES)) === IS_LEADING_SPACE_SENSITIVE;
}

export function openingTagEnd(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  const first = firstChild(t, id);
  if (!(first >= 0 && needsToBorrowParentOpeningTagEndMarker(t, first))) openingTagEndMarker(t, o, id, out);
}

export function openingTagStart(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  const prev = prevOf(t, id);
  if (prev >= 0 && needsToBorrowNextOpeningTagStartMarker(t, prev)) return;
  openingTagPrefix(t, o, id, out);
  openingTagStartMarker(t, o, id, out);
}

export function openingTagPrefix(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  if (needsToBorrowParentOpeningTagEndMarker(t, id)) {
    const parent = parentOf(t, id);
    if (parent >= 0) openingTagEndMarker(t, o, parent, out);
  } else if (needsToBorrowPrevClosingTagEndMarker(t, id)) {
    const prev = prevOf(t, id);
    if (prev >= 0) closingTagEndMarker(t, o, prev, out);
  }
}

export function openingTagStartMarker(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  const kind = kindOf(t, id);
  const b = t.pool.data;
  if (kind === K_IE_CONDITIONAL_COMMENT || kind === K_IE_CONDITIONAL_START_COMMENT) {
    out.appendAscii("<!--[if ");
    out.append(b, valStart(t, id), valEnd(t, id));
  } else if (kind === K_IE_CONDITIONAL_END_COMMENT) {
    out.appendAscii("<!--<!");
  } else if (kind === K_INTERPOLATION) {
    out.appendAscii("{{");
  } else if (kind === K_DOC_TYPE) {
    // Only in `.html` and `.htm` files is the one of HTML5 written in lower case.
    const isHtmlFile = o.hasFilepath && (o.filepath.endsWith(".html") || o.filepath.endsWith(".htm"));
    if (eqLit(b, valStart(t, id), valEnd(t, id), "html") && isHtmlFile) {
      out.appendAscii(HTML5_DOCTYPE_START_MARKER);
      return;
    }
    const s = nGet(t, id, F_SPAN_S);
    const text = o.originalText;
    const e = Math.min(text.length, s + HTML5_DOCTYPE_START_MARKER.length);
    if (s < e) out.append(text, s, e);
  } else if (kind === K_ANGULAR_ICU_EXPRESSION) {
    out.push(123);
  } else if (kind === K_ANGULAR_LET_DECLARATION) {
    // It has no `rawName`.
    out.appendAscii("<undefined");
  } else {
    if (has(t, id, HAS_CONDITION)) {
      out.appendAscii("<!--[if ");
      out.append(b, valStart(t, id), valEnd(t, id));
      out.appendAscii("]><!-->");
    }
    out.push(60);
    pushRawName(t, id, out);
  }
}

export function openingTagEndMarker(t: HTree, o: HOptions, id: number, out: ByteBuf): void {
  const kind = kindOf(t, id);
  if (kind === K_IE_CONDITIONAL_COMMENT) out.appendAscii("]>");
  else if (kind === K_ELEMENT && has(t, id, HAS_CONDITION)) out.appendAscii("><!--<![endif]-->");
  else out.appendAscii(">");
}

const lenScratch = new ByteBuf(64);

/** The length of what `openingTagStartMarker` writes. */
export function lenOfOpeningTagStartMarker(t: HTree, o: HOptions, id: number): number {
  const lenScratch$ = lenScratch;
  lenScratch$.reset();
  openingTagStartMarker(t, o, id, lenScratch$);
  return lenScratch$.len;
}
export function lenOfClosingTagEndMarker(t: HTree, o: HOptions, id: number): number {
  const lenScratch$ = lenScratch;
  lenScratch$.reset();
  closingTagEndMarker(t, o, id, lenScratch$);
  return lenScratch$.len;
}
function lenOfOpeningTagEndMarker(t: HTree, o: HOptions, id: number): number {
  const lenScratch$ = lenScratch;
  lenScratch$.reset();
  openingTagEndMarker(t, o, id, lenScratch$);
  return lenScratch$.len;
}
function lenOfClosingTagStartMarker(t: HTree, o: HOptions, id: number): number {
  const lenScratch$ = lenScratch;
  lenScratch$.reset();
  closingTagStartMarker(t, o, id, lenScratch$);
  return lenScratch$.len;
}

/** `getNodeContent`: the range of `o.originalText` goes into `NODE_CONTENT[0]`, `NODE_CONTENT[1]`. */
export const NODE_CONTENT = new Int32Array(2);
export function nodeContent(t: HTree, o: HOptions, id: number): void {
  let start = nGet(t, id, F_START_E);
  const first = firstChild(t, id);
  if (first >= 0 && needsToBorrowParentOpeningTagEndMarker(t, first)) {
    start = Math.max(0, start - lenOfOpeningTagEndMarker(t, o, id));
  }
  const text = o.originalText;
  if (!hasEndSpan(t, id)) {
    if (!isWrittenToItsEnd(t, id)) {
      NODE_CONTENT[0] = 0;
      NODE_CONTENT[1] = 0;
      return;
    }
    let end = nGet(t, id, F_SPAN_E);
    let at = id;
    for (;;) {
      const last = lastChild(t, at);
      if (last < 0) break;
      end = Math.max(end, nGet(t, last, F_SPAN_E));
      at = last;
    }
    if (start > end || end > text.length) {
      NODE_CONTENT[0] = 0;
      NODE_CONTENT[1] = 0;
      return;
    }
    NODE_CONTENT[0] = start;
    NODE_CONTENT[1] = trimAsciiEnd(text, start, end);
    return;
  }
  let end = nGet(t, id, F_END_S);
  const last = lastChild(t, id);
  if (last >= 0 && needsToBorrowParentClosingTagStartMarker(t, last)) {
    end = end + lenOfClosingTagStartMarker(t, o, id);
  } else if (needsToBorrowLastChildClosingTagEndMarker(t, id) && last >= 0) {
    end = Math.max(0, end - lenOfClosingTagEndMarker(t, o, last));
  }
  if (start > end || end > text.length) {
    NODE_CONTENT[0] = 0;
    NODE_CONTENT[1] = 0;
    return;
  }
  NODE_CONTENT[0] = start;
  NODE_CONTENT[1] = end;
}

void F_SPAN_S;
void isPreLike;
