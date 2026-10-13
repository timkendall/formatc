// Port of vendor/bun/src/format/handlebars/tokenizer.rs: from statements to the tree: `EventedTokenizer` of
// `simple-html-tokenizer`, which is given the text between the mustaches piece by piece, and `TokenizerEventHandlers` and
// `HandlebarsNodeVisitors` of `@glimmer/syntax`, in the mode `codemod`: entities stay as they are written.
//
// The states are those of the tokenizer, with all that they let through. What they drop is kept: the node that it is
// dropped from is marked (`Tree.written`), or the template as a whole (`Tree.hasLostText`).
//
// Rust `Result<_, Error>` is an int: >= 0 ok, -1 a syntax error (noted with `noteRefusal`), -2 nested too deeply.
import { I32Vec } from "../../base/i32vec.ts";
import { Stack } from "../../base/stack.ts";
import {
  MSG_ATTRIBUTE_IN_END_TAG,
  MSG_END_TAG_OF_VOID_ELEMENT,
  MSG_END_TAG_WITHOUT_START_TAG,
  MSG_INVALID_BLOCK_PARAMETERS,
  MSG_INVALID_DOCTYPE,
  MSG_INVALID_TAG_NAME,
  MSG_MISPLACED_BLOCK,
  MSG_MISPLACED_COMMENT,
  MSG_MISPLACED_MUSTACHE,
  MSG_SELF_CLOSING_END_TAG,
  MSG_UNCLOSED_ELEMENT,
  MSG_UNEXPECTED_CHARACTER,
  MSG_UNQUOTED_VALUE_WITH_MUSTACHE,
  MSG_UNSUPPORTED_MUSTACHE,
  MSG_WRONG_END_TAG,
  noteRefusal,
} from "../syntax_error.ts";
import {
  K_ATTR,
  K_BLOCK,
  K_BLOCK_STATEMENT,
  K_COMMENT,
  K_CONCAT,
  K_DOCTYPE,
  K_ELEMENT,
  K_ELEMENT_MODIFIER,
  K_MUSTACHE,
  K_MUSTACHE_COMMENT,
  K_PATH,
  K_SUB_EXPRESSION,
  K_TEMPLATE,
  K_TEXT,
  NOTHING,
  Tree,
} from "./ast.ts";
import { SF_HAS_SECOND, SF_INVERTED, SF_VALID, SF_WRITTEN, SK_BLOCK, SK_COMMENT, SK_CONTENT, SK_MUSTACHE, SK_UNSUPPORTED, Statements } from "./parser.ts";

const S_BEFORE_DATA: number = 0;
const S_DATA: number = 1;
const S_TAG_OPEN: number = 2;
const S_MARKUP_DECLARATION_OPEN: number = 3;
const S_DOCTYPE: number = 4;
const S_BEFORE_DOCTYPE_NAME: number = 5;
const S_DOCTYPE_NAME: number = 6;
const S_AFTER_DOCTYPE_NAME: number = 7;
const S_AFTER_DOCTYPE_PUBLIC_KEYWORD: number = 8;
// The tokenizer goes to this state and to the next, and has neither.
const S_BEFORE_DOCTYPE_PUBLIC_IDENTIFIER: number = 9;
const S_AFTER_DOCTYPE_SYSTEM_KEYWORD: number = 10;
const S_DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED: number = 11;
const S_DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED: number = 12;
const S_AFTER_DOCTYPE_PUBLIC_IDENTIFIER: number = 13;
const S_BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS: number = 14;
const S_DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED: number = 15;
const S_DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED: number = 16;
const S_AFTER_DOCTYPE_SYSTEM_IDENTIFIER: number = 17;
const S_COMMENT_START: number = 18;
const S_COMMENT_START_DASH: number = 19;
const S_COMMENT: number = 20;
const S_COMMENT_END_DASH: number = 21;
const S_COMMENT_END: number = 22;
const S_TAG_NAME: number = 23;
const S_END_TAG_NAME: number = 24;
const S_BEFORE_ATTRIBUTE_NAME: number = 25;
const S_ATTRIBUTE_NAME: number = 26;
const S_AFTER_ATTRIBUTE_NAME: number = 27;
const S_BEFORE_ATTRIBUTE_VALUE: number = 28;
const S_ATTRIBUTE_VALUE_DOUBLE_QUOTED: number = 29;
const S_ATTRIBUTE_VALUE_SINGLE_QUOTED: number = 30;
const S_ATTRIBUTE_VALUE_UNQUOTED: number = 31;
const S_AFTER_ATTRIBUTE_VALUE_QUOTED: number = 32;
const S_SELF_CLOSING_START_TAG: number = 33;
const S_END_TAG_OPEN: number = 34;

function isInDoctype(state: number): boolean {
  return state >= S_DOCTYPE && state <= S_AFTER_DOCTYPE_SYSTEM_IDENTIFIER;
}

function isSpace(byte: number): boolean {
  return byte === 9 || byte === 10 || byte === 12 || byte === 32;
}

// What a tag can start with.
function startsTagName(byte: number): boolean {
  return byte === 64 || byte === 58 || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

// `name` is `lit` (printable ASCII).
function bytesIs(buf: Uint8Array, a: number, l: number, lit: string): boolean {
  if (l !== lit.length) return false;
  for (let i = 0; i < l; i++) {
    if ((buf[a + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

// `isVoidTag` for `buf[a, a + l)`.
export function isVoidTag(buf: Uint8Array, a: number, l: number): boolean {
  switch (l) {
    case 2:
      return bytesIs(buf, a, l, "br") || bytesIs(buf, a, l, "hr");
    case 3:
      return bytesIs(buf, a, l, "col") || bytesIs(buf, a, l, "img") || bytesIs(buf, a, l, "wbr");
    case 4:
      return bytesIs(buf, a, l, "area") || bytesIs(buf, a, l, "base") || bytesIs(buf, a, l, "link") || bytesIs(buf, a, l, "meta");
    case 5:
      return bytesIs(buf, a, l, "embed") || bytesIs(buf, a, l, "input") || bytesIs(buf, a, l, "param") || bytesIs(buf, a, l, "track");
    case 6:
      return bytesIs(buf, a, l, "keygen") || bytesIs(buf, a, l, "source");
    case 7:
      return bytesIs(buf, a, l, "command");
    default:
      return false;
  }
}

// The first six UTF-16 code units of `text[a, end)`, in upper case, are `keyword`.
function startsWithKeyword(text: Uint8Array, a: number, end: number, keyword: string): boolean {
  if (a + 6 <= end) {
    let ascii = true;
    for (let i = 0; i < 6; i++) {
      if ((text[a + i] | 0) >= 0x80) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      for (let i = 0; i < 6; i++) {
        let c = text[a + i] | 0;
        if (c >= 97 && c <= 122) c = c - 32;
        if (c !== keyword.charCodeAt(i)) return false;
      }
      return true;
    }
  }
  // The valid UTF-8 at the start of the 24 bytes.
  const stop = a + 24 < end ? a + 24 : end;
  let validEnd = a;
  let i = a;
  while (i < stop) {
    const b = text[i] | 0;
    let n = 1;
    if (b >= 0xf0) n = 4;
    else if (b >= 0xe0) n = 3;
    else if (b >= 0xc0) n = 2;
    else if (b >= 0x80) break;
    if (i + n > stop) break;
    let ok = true;
    for (let k = 1; k < n; k++) {
      if (((text[i + k] | 0) & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    i = i + n;
    validEnd = i;
  }
  const s = new TextDecoder().decode(text.subarray(a, validEnd));
  let units = 0;
  let upper = "";
  let k = 0;
  while (k < s.length) {
    if (units >= 6) break;
    const c = s.charCodeAt(k);
    let ch = s.substring(k, k + 1);
    if (c >= 0xd800 && c <= 0xdbff && k + 1 < s.length) ch = s.substring(k, k + 2);
    units = units + ch.length;
    k = k + ch.length;
    upper = upper + ch.toUpperCase();
  }
  return units <= 6 && upper === keyword;
}

const BACKSLASH = new Uint8Array(1);
BACKSLASH[0] = 92;
const REPLACEMENT_CHARACTER = new Uint8Array(3);
REPLACEMENT_CHARACTER[0] = 0xef;
REPLACEMENT_CHARACTER[1] = 0xbf;
REPLACEMENT_CHARACTER[2] = 0xbd;

// Whether `name` has a character that cannot be in the name of a block parameter: `!"#%&'()*+./;<=>@[\]^`{|}~`.
function hasBlockParamsForbidden(buf: Uint8Array, a: number, b: number): boolean {
  for (let i = a; i < b; i++) {
    switch (buf[i] | 0) {
      case 33: case 34: case 35: case 37: case 38: case 39: case 40: case 41: case 42: case 43: case 46: case 47:
      case 59: case 60: case 61: case 62: case 64: case 91: case 92: case 93: case 94: case 96: case 123: case 124:
      case 125: case 126:
        return true;
      default:
        break;
    }
  }
  return false;
}

class Builder {
  source: Uint8Array;
  st: Statements;
  tree: Tree;

  state: number;
  // Where the tokenizer is, and where the piece ends that it has been given.
  index: number;
  end: number;
  // The tokenizer has read one character more than it had.
  hasReadTooFar: boolean;
  // `tagNameBuffer` is empty. Otherwise it is `tag.name`.
  isTagNameBufferEmpty: boolean;

  tagOpen: number;
  // `Tag`
  tagIsEnd: boolean;
  tagNameS: number;
  tagNameL: number;
  tagStart: number;
  tagSelfClosing: boolean;
  // Something in it is dropped.
  tagWritten: boolean;
  // The attributes, modifiers and comments of `tag`.
  tagParts0: I32Vec;
  tagParts1: I32Vec;
  tagParts2: I32Vec;
  // The same, in the order of the template.
  sortedTagParts: I32Vec;
  // (start, len) pairs
  tagParams: I32Vec;
  // `Attribute`
  attrNameS: number;
  attrNameL: number;
  attrStart: number;
  attrValueStart: number;
  attrQuoted: boolean;
  attrDynamic: boolean;
  // Empty: there is none.
  attrPartS: number;
  attrPartL: number;
  attributeParts: I32Vec;
  // Of the text or the comment that is being read.
  start: number;
  commentS: number;
  commentL: number;
  // Something in the comment is dropped.
  isCommentWritten: boolean;
  // Where the dashes are that may end the comment.
  dash0: number;
  dash1: number;

  // What is open: an element, or the body of a block or of the template (`element` NOTHING).
  frameElement: I32Vec;
  // Where its children start in `children`.
  frameBase: I32Vec;
  // The children so far of everything that is open.
  children: I32Vec;
  // For blocks in each other.
  room: Stack;
  // A range of `tree.lists`, the result of `takeChildren` and `body`.
  rangeS: number;
  rangeL: number;

  constructor() {
    this.source = new Uint8Array(0);
    this.st = new Statements();
    this.tree = new Tree();
    this.state = S_BEFORE_DATA;
    this.index = 0;
    this.end = 0;
    this.hasReadTooFar = false;
    this.isTagNameBufferEmpty = true;
    this.tagOpen = 0;
    this.tagIsEnd = false;
    this.tagNameS = 0;
    this.tagNameL = 0;
    this.tagStart = 0;
    this.tagSelfClosing = false;
    this.tagWritten = false;
    this.tagParts0 = new I32Vec(16);
    this.tagParts1 = new I32Vec(8);
    this.tagParts2 = new I32Vec(8);
    this.sortedTagParts = new I32Vec(16);
    this.tagParams = new I32Vec(8);
    this.attrNameS = 0;
    this.attrNameL = 0;
    this.attrStart = 0;
    this.attrValueStart = 0;
    this.attrQuoted = false;
    this.attrDynamic = false;
    this.attrPartS = 0;
    this.attrPartL = 0;
    this.attributeParts = new I32Vec(8);
    this.start = 0;
    this.commentS = 0;
    this.commentL = 0;
    this.isCommentWritten = false;
    this.dash0 = 0;
    this.dash1 = 0;
    this.frameElement = new I32Vec(32);
    this.frameBase = new I32Vec(32);
    this.children = new I32Vec(64);
    this.room = Stack.forTree();
    this.rangeS = 0;
    this.rangeL = 0;
  }

  // The byte at the tokenizer, or -1.
  peek(): number {
    return this.index < this.end ? this.source[this.index] | 0 : -1;
  }

  // `message`, where the tokenizer is. Returns -1.
  error(message: number): number {
    return noteRefusal(message, this.index);
  }

  errorAt(message: number, at: number): number {
    return noteRefusal(message, at);
  }

  // ----------------------------------------------------------------------------------------- TokenizerEventHandlers

  appendToComment(start: number, end: number): void {
    if (start < end) {
      this.tree.appendSource(this.commentS, this.commentL, start, end);
      this.commentS = this.tree.rs;
      this.commentL = this.tree.rl;
    }
  }

  finishComment(): void {
    const tree = this.tree;
    const comment = tree.add2(K_COMMENT, this.start, this.index, this.commentS, this.commentL);
    if (this.isCommentWritten) {
      this.isCommentWritten = false;
      tree.keepAsWritten(comment);
    }
    this.children.push(comment);
  }

  beginData(): void {
    this.start = this.index;
  }

  finishData(): void {
    const start = this.start;
    const text = this.tree.add2(K_TEXT, start, this.index, start, this.index > start ? this.index - start : 0);
    this.children.push(text);
  }

  beginTag(isEnd: boolean): void {
    this.tagIsEnd = isEnd;
    this.tagNameS = 0;
    this.tagNameL = 0;
    this.tagStart = this.tagOpen;
    this.tagSelfClosing = false;
    this.tagWritten = false;
    this.isTagNameBufferEmpty = false;
    this.tagParts0.reset();
    this.tagParts1.reset();
    this.tagParts2.reset();
    this.tagParams.reset();
  }

  // The character before `index`.
  appendToTagName(): void {
    this.tree.appendSource(this.tagNameS, this.tagNameL, this.index - 1, this.index);
    this.tagNameS = this.tree.rs;
    this.tagNameL = this.tree.rl;
  }

  // The children from `base` on, as a list of the tree (`rangeS`, `rangeL`). With Prettier's `addBackslash`.
  takeChildren(base: number): void {
    const tree = this.tree;
    const children = this.children;
    const n = children.len;
    for (let index = base; index + 1 < n; index++) {
      const cur = children.data[index] | 0;
      const nxt = children.data[index + 1] | 0;
      if ((tree.tag[nxt] | 0) === K_MUSTACHE && (tree.tag[cur] | 0) === K_TEXT) {
        const cs = tree.f0[cur] | 0;
        const cl = tree.f1[cur] | 0;
        if (tree.textEndsWithByte(cs, cl, 92)) {
          tree.appendBytes(cs, cl, BACKSLASH, 0, 1);
          tree.f0[cur] = tree.rs | 0;
          tree.f1[cur] = tree.rl | 0;
        }
      }
    }
    const len = n > base ? n - base : 0;
    this.rangeS = tree.addListFrom(children.data, base, len);
    this.rangeL = len;
    children.truncate(base);
  }

  finishTag(): number {
    if (this.tagIsEnd) return this.finishEndTag(false);
    const tree = this.tree;
    // Prettier sorts them by where they start. Each list is in that order.
    const sorted = this.sortedTagParts;
    sorted.reset();
    const l0 = this.tagParts0;
    const l1 = this.tagParts1;
    const l2 = this.tagParts2;
    let i0 = 0;
    let i1 = 0;
    let i2 = 0;
    while (true) {
      let which = -1;
      let best = 0;
      if (i0 < l0.len) {
        which = 0;
        best = tree.start[l0.data[i0] | 0] | 0;
      }
      if (i1 < l1.len) {
        const s = tree.start[l1.data[i1] | 0] | 0;
        if (which < 0 || s < best) {
          which = 1;
          best = s;
        }
      }
      if (i2 < l2.len) {
        const s = tree.start[l2.data[i2] | 0] | 0;
        if (which < 0 || s < best) {
          which = 2;
          best = s;
        }
      }
      if (which < 0) break;
      if (which === 0) {
        sorted.push(l0.data[i0] | 0);
        i0 = i0 + 1;
      } else if (which === 1) {
        sorted.push(l1.data[i1] | 0);
        i1 = i1 + 1;
      } else {
        sorted.push(l2.data[i2] | 0);
        i2 = i2 + 1;
      }
    }
    const element = tree.add(K_ELEMENT, this.tagStart, this.index);
    tree.f0[element] = this.tagNameS | 0;
    tree.f1[element] = this.tagNameL | 0;
    tree.f2[element] = tree.addListFrom(sorted.data, 0, sorted.len) | 0;
    tree.f3[element] = sorted.len | 0;
    const params = this.tagParams;
    const np = params.len >> 1;
    tree.f4[element] = (np === 0 ? 0 : tree.addNamePairs(params.data, np)) | 0;
    tree.f5[element] = np | 0;
    tree.f6[element] = 0;
    tree.f7[element] = 0;
    tree.f8[element] = this.tagSelfClosing ? 1 : 0;
    if (this.tagWritten) tree.keepAsWritten(element);
    this.frameElement.push(element);
    this.frameBase.push(this.children.len);
    if (tree.textIs(this.tagNameS, this.tagNameL, ":")) return this.errorAt(MSG_INVALID_TAG_NAME, this.tagStart);
    if (this.tagIsVoid() || this.tagSelfClosing) return this.finishEndTag(true);
    return 0;
  }

  tagIsVoid(): boolean {
    const s = this.tagNameS;
    return isVoidTag(this.tree.buf, s, this.tagNameL);
  }

  finishEndTag(isVoid: boolean): number {
    const tree = this.tree;
    if (this.tagIsVoid() && !isVoid) return this.errorAt(MSG_END_TAG_OF_VOID_ELEMENT, this.tagStart);
    if (this.frameElement.len === 0) return this.errorAt(MSG_END_TAG_WITHOUT_START_TAG, this.tagStart);
    const element = this.frameElement.pop();
    const base = this.frameBase.pop();
    if ((tree.tag[element] | 0) !== K_ELEMENT) return this.errorAt(MSG_END_TAG_WITHOUT_START_TAG, this.tagStart);
    if (!tree.textEq(tree.f0[element] | 0, tree.f1[element] | 0, this.tagNameS, this.tagNameL)) {
      return this.errorAt(MSG_WRONG_END_TAG, this.tagStart);
    }
    this.takeChildren(base);
    tree.end[element] = this.index | 0;
    if (this.tagWritten) tree.written[element] = 1;
    tree.f6[element] = this.rangeS | 0;
    tree.f7[element] = this.rangeL | 0;
    this.children.push(element);
    return 0;
  }

  beginAttribute(): void {
    const position = this.index;
    this.attrNameS = 0;
    this.attrNameL = 0;
    this.attrStart = position;
    this.attrValueStart = position;
    this.attrQuoted = false;
    this.attrDynamic = false;
    this.attrPartS = 0;
    this.attrPartL = 0;
    this.attributeParts.reset();
  }

  // The character before `index`.
  appendToAttributeName(): number {
    this.tree.appendSource(this.attrNameS, this.attrNameL, this.index - 1, this.index);
    this.attrNameS = this.tree.rs;
    this.attrNameL = this.tree.rl;
    if (this.tree.textIs(this.attrNameS, this.attrNameL, "as")) return this.parsePossibleBlockParams();
    return 0;
  }

  beginAttributeValue(isQuoted: boolean): void {
    this.attrQuoted = isQuoted;
    this.attrPartS = 0;
    this.attrPartL = 0;
    this.attrValueStart = this.index;
  }

  appendToAttributeValue(start: number, end: number): void {
    if (start < end) {
      this.tree.appendSource(this.attrPartS, this.attrPartL, start, end);
      this.attrPartS = this.tree.rs;
      this.attrPartL = this.tree.rl;
    }
  }

  finalizeTextPart(): void {
    const s = this.attrPartS;
    const l = this.attrPartL;
    this.attrPartS = 0;
    this.attrPartL = 0;
    if (l !== 0) {
      const part = this.tree.add2(K_TEXT, 0, 0, s, l);
      this.attributeParts.push(part);
    }
  }

  appendDynamicAttributeValuePart(part: number): void {
    this.finalizeTextPart();
    this.attrDynamic = true;
    this.attributeParts.push(part);
  }

  finishAttributeValue(): number {
    const tree = this.tree;
    this.finalizeTextPart();
    const position = this.index;
    const start = this.attrStart;
    const valueStart = this.attrValueStart;
    if (this.tagIsEnd) return this.errorAt(MSG_ATTRIBUTE_IN_END_TAG, start);
    const parts = this.attributeParts;
    if (
      this.attrNameL > 0 &&
      (tree.buf[this.attrNameS] | 0) === 124 &&
      parts.len === 0 &&
      !this.attrQuoted &&
      !this.attrDynamic
    ) {
      return this.errorAt(MSG_INVALID_BLOCK_PARAMETERS, start);
    }
    // `assembleAttributeValue`
    let value = 0;
    if (this.attrDynamic && this.attrQuoted) {
      value = tree.add2(K_CONCAT, 0, 0, tree.addListFrom(parts.data, 0, parts.len), parts.len);
    } else if (parts.len === 1) {
      value = parts.data[0] | 0;
    } else if (parts.len >= 2) {
      const next = parts.data[1] | 0;
      if ((tree.tag[next] | 0) === K_TEXT && tree.textIs(tree.f0[next] | 0, tree.f1[next] | 0, "/")) {
        value = parts.data[0] | 0;
      } else {
        return this.errorAt(MSG_UNQUOTED_VALUE_WITH_MUSTACHE, valueStart);
      }
    } else {
      value = tree.add2(K_TEXT, 0, 0, 0, 0);
    }
    tree.start[value] = valueStart | 0;
    tree.end[value] = position | 0;
    const attribute = tree.add3(K_ATTR, start, position, this.attrNameS, this.attrNameL, value);
    this.tagParts0.push(attribute);
    return 0;
  }

  // Behind `as`. Where the piece ends in the parameters, an error is kept for the next mustache or the end of the
  // template, one of which comes.
  parsePossibleBlockParams(): number {
    const next0 = this.peek();
    if (next0 >= 0 && isSpace(next0)) {
      this.state = S_AFTER_ATTRIBUTE_NAME;
      this.index = this.index + 1;
    } else if (next0 === 124) {
      return this.error(MSG_INVALID_BLOCK_PARAMETERS);
    } else {
      return 0;
    }
    while (true) {
      const c = this.peek();
      if (c >= 0 && isSpace(c)) this.index = this.index + 1;
      else if (c === 124) break;
      else return 0;
    }
    this.state = S_BEFORE_ATTRIBUTE_NAME;
    this.index = this.index + 1;
    if (this.tagIsEnd) return this.error(MSG_INVALID_BLOCK_PARAMETERS);
    const src = this.source;
    while (true) {
      const c = this.peek();
      if (c < 0) return this.error(MSG_INVALID_BLOCK_PARAMETERS);
      if (isSpace(c)) {
        this.index = this.index + 1;
      } else if (c === 124 && this.tagParams.len === 0) {
        return this.error(MSG_INVALID_BLOCK_PARAMETERS);
      } else if (c === 124) {
        this.index = this.index + 1;
        break;
      } else if (c === 62 || c === 47) {
        return this.error(MSG_INVALID_BLOCK_PARAMETERS);
      } else {
        const start = this.index;
        let last = 0;
        while (true) {
          this.index = this.index + 1;
          const d = this.peek();
          if (d < 0) return this.error(MSG_INVALID_BLOCK_PARAMETERS);
          if (d === 62 || d === 47) return this.error(MSG_INVALID_BLOCK_PARAMETERS);
          if (d === 124 || isSpace(d)) {
            last = d;
            break;
          }
        }
        const len = this.index - start;
        if ((len === 4 && bytesIs(src, start, len, "this")) || hasBlockParamsForbidden(src, start, this.index)) {
          return this.errorAt(MSG_INVALID_BLOCK_PARAMETERS, start);
        }
        this.tagParams.push(start);
        this.tagParams.push(len);
        this.index = this.index + 1;
        if (last === 124) break;
      }
    }
    while (true) {
      const c = this.peek();
      if (c < 0) return this.error(MSG_INVALID_BLOCK_PARAMETERS);
      if (isSpace(c)) this.index = this.index + 1;
      else if (c === 62 || c === 47) return 0;
      else return this.error(MSG_INVALID_BLOCK_PARAMETERS);
    }
  }

  // ----------------------------------------------------------------------------------------- EventedTokenizer

  isIgnoredEndTag(): boolean {
    if (this.isTagNameBufferEmpty) return false;
    const tree = this.tree;
    let endTag = "";
    if (tree.textIs(this.tagNameS, this.tagNameL, "title")) endTag = "</title>";
    else if (tree.textIs(this.tagNameS, this.tagNameL, "style")) endTag = "</style>";
    else if (tree.textIs(this.tagNameS, this.tagNameL, "script")) endTag = "</script>";
    else return false;
    const n = endTag.length;
    if (this.index + n > this.end) return true;
    const src = this.source;
    for (let i = 0; i < n; i++) {
      if ((src[this.index + i] | 0) !== endTag.charCodeAt(i)) return true;
    }
    return false;
  }

  openTag(): void {
    this.state = S_TAG_OPEN;
    this.tagOpen = this.index;
    this.index = this.index + 1;
  }

  // `consume()`, where it matters that it takes a UTF-16 code unit. After half a character comes nothing that the state
  // goes on with.
  consumeUnit(): number {
    const c = this.peek();
    if (c < 0 || c < 0xc0) this.index = this.index + 1;
    else if (c < 0xe0) this.index = this.index + 2;
    else if (c < 0xf0) this.index = this.index + 3;
    else return this.error(MSG_UNEXPECTED_CHARACTER);
    return 0;
  }

  finishAttributeAndTag(): number {
    this.beginAttributeValue(false);
    let r = this.finishAttributeValue();
    if (r < 0) return r;
    this.index = this.index + 1;
    r = this.finishTag();
    if (r < 0) return r;
    this.state = S_BEFORE_DATA;
    return 0;
  }

  finishAttributeBeforeSlash(): number {
    this.beginAttributeValue(false);
    const r = this.finishAttributeValue();
    if (r < 0) return r;
    this.index = this.index + 1;
    this.state = S_SELF_CLOSING_START_TAG;
    return 0;
  }

  quotedAttributeValue(quote: number): number {
    const start = this.index | 0;
    const src = this.source;
    const end = this.end | 0;
    let found = -1;
    for (let i = start; i < end; i++) {
      if ((src[i] | 0) === quote) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      this.index = this.end;
      this.appendToAttributeValue(start, this.end);
    } else {
      this.appendToAttributeValue(start, found);
      this.index = found + 1;
      const r = this.finishAttributeValue();
      if (r < 0) return r;
      this.state = S_AFTER_ATTRIBUTE_VALUE_QUOTED;
    }
    return 0;
  }

  // Where `character` leads in a doctype, other than `>`: the state, or -1.
  nextDoctypeState(state: number, c: number): number {
    switch (state) {
      case S_DOCTYPE_NAME:
        return isSpace(c) ? S_AFTER_DOCTYPE_NAME : -1;
      case S_DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED:
        return c === 34 ? S_AFTER_DOCTYPE_PUBLIC_IDENTIFIER : -1;
      case S_DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED:
        return c === 39 ? S_AFTER_DOCTYPE_PUBLIC_IDENTIFIER : -1;
      case S_AFTER_DOCTYPE_PUBLIC_IDENTIFIER:
        if (isSpace(c)) return S_BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS;
        if (c === 34) return S_DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        if (c === 39) return S_DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
        return -1;
      case S_BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS:
        if (c === 34) return S_DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        if (c === 39) return S_DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
        return -1;
      case S_DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED:
        return c === 34 ? S_AFTER_DOCTYPE_SYSTEM_IDENTIFIER : -1;
      case S_DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED:
        return c === 39 ? S_AFTER_DOCTYPE_SYSTEM_IDENTIFIER : -1;
      default:
        return -1;
    }
  }

  // In a doctype: `>` ends it, `nextDoctypeState` says where another character leads.
  doctype(): void {
    const character = this.peek();
    if (character < 0) return;
    this.index = this.index + 1;
    if (character === 62) {
      this.state = S_BEFORE_DATA;
    } else {
      const s = this.nextDoctypeState(this.state, character);
      if (s >= 0) this.state = s;
    }
  }

  // One step. There is a character.
  step(character: number): number {
    const src = this.source;
    const tree = this.tree;
    switch (this.state) {
      case S_BEFORE_DATA:
        if (character === 60 && !this.isIgnoredEndTag()) {
          this.openTag();
        } else {
          this.state = S_DATA;
          this.beginData();
        }
        break;
      case S_DATA: {
        let found = -1;
        const end = this.end | 0;
        for (let i = this.index | 0; i < end; i++) {
          if ((src[i] | 0) === 60) {
            found = i;
            break;
          }
        }
        if (found < 0) {
          this.index = end;
        } else {
          this.index = found;
          if (this.isIgnoredEndTag()) {
            this.index = this.index + 1;
          } else {
            this.finishData();
            this.openTag();
          }
        }
        break;
      }
      case S_TAG_OPEN:
        this.index = this.index + 1;
        if (character === 33) {
          this.state = S_MARKUP_DECLARATION_OPEN;
        } else if (character === 47) {
          this.state = S_END_TAG_OPEN;
        } else if (startsTagName(character)) {
          this.state = S_TAG_NAME;
          this.beginTag(false);
          this.appendToTagName();
        } else {
          tree.hasLostText = true;
        }
        break;
      case S_MARKUP_DECLARATION_OPEN: {
        this.index = this.index + 1;
        if (character === 45 && this.peek() === 45) {
          this.index = this.index + 1;
          this.state = S_COMMENT_START;
          this.start = this.tagOpen;
          this.commentS = 0;
          this.commentL = 0;
        } else {
          let isDoctype = false;
          const from = this.index - 1;
          if (from + 7 <= this.end) {
            isDoctype = true;
            for (let i = 0; i < 7; i++) {
              let c = src[from + i] | 0;
              if (c >= 65 && c <= 90) c = c + 32;
              if (c !== "doctype".charCodeAt(i)) {
                isDoctype = false;
                break;
              }
            }
          }
          if (isDoctype) {
            this.index = this.index + 6;
            this.state = S_DOCTYPE;
          } else {
            tree.hasLostText = true;
          }
        }
        break;
      }
      case S_DOCTYPE:
        this.index = this.index + 1;
        if (isSpace(character)) this.state = S_BEFORE_DOCTYPE_NAME;
        break;
      case S_BEFORE_DOCTYPE_NAME:
        this.index = this.index + 1;
        if (!isSpace(character)) this.state = S_DOCTYPE_NAME;
        break;
      case S_DOCTYPE_NAME:
        this.doctype();
        break;
      case S_AFTER_DOCTYPE_NAME: {
        const isPublic = startsWithKeyword(src, this.index, this.end, "PUBLIC");
        const isSystem = startsWithKeyword(src, this.index, this.end, "SYSTEM");
        this.index = this.index + 1;
        if (character === 62) {
          this.state = S_BEFORE_DATA;
        } else if (isPublic || isSystem) {
          // One more than the keyword has.
          this.index = this.index - 1;
          for (let i = 0; i < 7; i++) {
            const r = this.consumeUnit();
            if (r < 0) return r;
          }
          this.state = isPublic ? S_AFTER_DOCTYPE_PUBLIC_KEYWORD : S_AFTER_DOCTYPE_SYSTEM_KEYWORD;
        }
        break;
      }
      case S_AFTER_DOCTYPE_PUBLIC_KEYWORD:
        if (isSpace(character)) this.state = S_BEFORE_DOCTYPE_PUBLIC_IDENTIFIER;
        else if (character === 34) this.state = S_DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED;
        else if (character === 39) this.state = S_DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED;
        else if (character === 62) this.state = S_BEFORE_DATA;
        // The tokenizer stays where it is for ever.
        else return this.error(MSG_INVALID_DOCTYPE);
        this.index = this.index + 1;
        break;
      case S_BEFORE_DOCTYPE_PUBLIC_IDENTIFIER:
      case S_AFTER_DOCTYPE_SYSTEM_KEYWORD:
        return this.error(MSG_INVALID_DOCTYPE);
      case S_DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED:
      case S_DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED:
      case S_AFTER_DOCTYPE_PUBLIC_IDENTIFIER:
      case S_BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS:
      case S_DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED:
      case S_DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED:
      case S_AFTER_DOCTYPE_SYSTEM_IDENTIFIER:
        this.doctype();
        break;
      case S_COMMENT_START:
        this.index = this.index + 1;
        if (character === 45) {
          this.dash0 = this.index - 1;
          this.state = S_COMMENT_START_DASH;
        } else if (character === 62) {
          this.finishComment();
          this.state = S_BEFORE_DATA;
        } else {
          this.appendToComment(this.index - 1, this.index);
          this.state = S_COMMENT;
        }
        break;
      case S_COMMENT_START_DASH:
        if (character === 45) {
          this.dash1 = this.index;
          this.index = this.index + 1;
          this.state = S_COMMENT_END;
        } else if (character === 62) {
          this.index = this.index + 1;
          this.finishComment();
          this.state = S_BEFORE_DATA;
        } else {
          // The character is dropped: a UTF-16 code unit.
          this.isCommentWritten = true;
          this.appendToComment(this.dash0, this.dash0 + 1);
          if (character >= 0xf0) {
            this.index = this.index + 4 < this.end ? this.index + 4 : this.end;
            tree.appendBytes(this.commentS, this.commentL, REPLACEMENT_CHARACTER, 0, 3);
            this.commentS = tree.rs;
            this.commentL = tree.rl;
          } else {
            const r = this.consumeUnit();
            if (r < 0) return r;
            if (this.index > this.end) this.index = this.end;
          }
          this.state = S_COMMENT;
        }
        break;
      case S_COMMENT: {
        const start = this.index | 0;
        let found = -1;
        const end = this.end | 0;
        for (let i = start; i < end; i++) {
          if ((src[i] | 0) === 45) {
            found = i;
            break;
          }
        }
        if (found < 0) {
          this.index = end;
          this.appendToComment(start, end);
        } else {
          this.appendToComment(start, found);
          this.dash0 = found;
          this.index = found + 1;
          this.state = S_COMMENT_END_DASH;
        }
        break;
      }
      case S_COMMENT_END_DASH:
        this.index = this.index + 1;
        if (character === 45) {
          this.dash1 = this.index - 1;
          this.state = S_COMMENT_END;
        } else {
          this.appendToComment(this.dash0, this.dash0 + 1);
          this.appendToComment(this.index - 1, this.index);
          this.state = S_COMMENT;
        }
        break;
      case S_COMMENT_END:
        this.index = this.index + 1;
        if (character === 62) {
          this.finishComment();
          this.state = S_BEFORE_DATA;
        } else {
          this.appendToComment(this.dash0, this.dash0 + 1);
          this.appendToComment(this.dash1, this.dash1 + 1);
          this.appendToComment(this.index - 1, this.index);
          this.state = S_COMMENT;
        }
        break;
      case S_TAG_NAME:
      case S_END_TAG_NAME: {
        this.index = this.index + 1;
        const isEnd = this.state === S_END_TAG_NAME;
        if (isSpace(character)) {
          this.state = S_BEFORE_ATTRIBUTE_NAME;
        } else if (character === 47) {
          this.state = S_SELF_CLOSING_START_TAG;
        } else if (character === 62) {
          const r = this.finishTag();
          if (r < 0) return r;
          this.state = S_BEFORE_DATA;
        } else {
          const start = (this.index - 1) | 0;
          const end = this.end | 0;
          let i = this.index | 0;
          while (i < end) {
            const c = src[i] | 0;
            if (c === 32 || (c >= 9 && c <= 13 && c !== 11 && c !== 13) || c === 47 || c === 62) break;
            i = ((i | 0) + 1) | 0;
          }
          this.index = i;
          tree.appendSource(this.tagNameS, this.tagNameL, start, i);
          this.tagNameS = tree.rs;
          this.tagNameL = tree.rl;
          return 0;
        }
        if (isEnd) this.isTagNameBufferEmpty = true;
        break;
      }
      case S_BEFORE_ATTRIBUTE_NAME:
        if (isSpace(character)) {
          const end = this.end | 0;
          let i = this.index | 0;
          while (i < end) {
            const c = src[i] | 0;
            if (!(c === 32 || c === 9 || c === 10 || c === 12)) break;
            i = ((i | 0) + 1) | 0;
          }
          this.index = i;
        } else if (character === 47) {
          this.state = S_SELF_CLOSING_START_TAG;
          this.index = this.index + 1;
        } else if (character === 62) {
          this.index = this.index + 1;
          const r = this.finishTag();
          if (r < 0) return r;
          this.state = S_BEFORE_DATA;
        } else if (character === 61) {
          return this.error(MSG_UNEXPECTED_CHARACTER);
        } else {
          this.state = S_ATTRIBUTE_NAME;
          this.beginAttribute();
        }
        break;
      case S_ATTRIBUTE_NAME: {
        if (isSpace(character)) {
          this.state = S_AFTER_ATTRIBUTE_NAME;
          this.index = this.index + 1;
        } else if (character === 47) {
          const r = this.finishAttributeBeforeSlash();
          if (r < 0) return r;
        } else if (character === 61) {
          this.state = S_BEFORE_ATTRIBUTE_VALUE;
          this.index = this.index + 1;
        } else if (character === 62) {
          const r = this.finishAttributeAndTag();
          if (r < 0) return r;
        } else if (character === 34 || character === 39 || character === 60) {
          return this.error(MSG_UNEXPECTED_CHARACTER);
        } else {
          let isAsOnTheWay = false;
          if (this.attrNameL === 0) {
            isAsOnTheWay = this.index + 2 <= this.end && (src[this.index] | 0) === 97 && (src[this.index + 1] | 0) === 115;
          } else if (this.attrNameL === 1 && tree.textIs(this.attrNameS, this.attrNameL, "a")) {
            isAsOnTheWay = character === 115;
          }
          if (isAsOnTheWay) {
            this.index = this.index + 1;
            const r = this.appendToAttributeName();
            if (r < 0) return r;
          } else {
            // It is not `as` on the way.
            const start = this.index | 0;
            const end = this.end | 0;
            let i = start;
            while (i < end) {
              const c = src[i] | 0;
              if (c === 32 || c === 9 || c === 10 || c === 12 || c === 47 || c === 61 || c === 62 || c === 34 || c === 39 || c === 60) break;
              i = ((i | 0) + 1) | 0;
            }
            this.index = i;
            tree.appendSource(this.attrNameS, this.attrNameL, start, i);
            this.attrNameS = tree.rs;
            this.attrNameL = tree.rl;
          }
        }
        break;
      }
      case S_AFTER_ATTRIBUTE_NAME:
        if (isSpace(character)) {
          this.index = this.index + 1;
        } else if (character === 47) {
          const r = this.finishAttributeBeforeSlash();
          if (r < 0) return r;
        } else if (character === 61) {
          this.index = this.index + 1;
          this.state = S_BEFORE_ATTRIBUTE_VALUE;
        } else if (character === 62) {
          const r = this.finishAttributeAndTag();
          if (r < 0) return r;
        } else {
          this.beginAttributeValue(false);
          let r = this.finishAttributeValue();
          if (r < 0) return r;
          this.state = S_ATTRIBUTE_NAME;
          this.beginAttribute();
          this.index = this.index + 1;
          r = this.appendToAttributeName();
          if (r < 0) return r;
        }
        break;
      case S_BEFORE_ATTRIBUTE_VALUE:
        if (isSpace(character)) {
          this.index = this.index + 1;
        } else if (character === 34 || character === 39) {
          this.state = character === 34 ? S_ATTRIBUTE_VALUE_DOUBLE_QUOTED : S_ATTRIBUTE_VALUE_SINGLE_QUOTED;
          this.beginAttributeValue(true);
          this.index = this.index + 1;
        } else if (character === 62) {
          const r = this.finishAttributeAndTag();
          if (r < 0) return r;
        } else {
          this.state = S_ATTRIBUTE_VALUE_UNQUOTED;
          this.beginAttributeValue(false);
          this.index = this.index + 1;
          this.appendToAttributeValue(this.index - 1, this.index);
        }
        break;
      case S_ATTRIBUTE_VALUE_DOUBLE_QUOTED:
        return this.quotedAttributeValue(34);
      case S_ATTRIBUTE_VALUE_SINGLE_QUOTED:
        return this.quotedAttributeValue(39);
      case S_ATTRIBUTE_VALUE_UNQUOTED:
        if (isSpace(character)) {
          const r = this.finishAttributeValue();
          if (r < 0) return r;
          this.index = this.index + 1;
          this.state = S_BEFORE_ATTRIBUTE_NAME;
        } else if (character === 47) {
          const r = this.finishAttributeValue();
          if (r < 0) return r;
          this.index = this.index + 1;
          this.state = S_SELF_CLOSING_START_TAG;
        } else if (character === 62) {
          let r = this.finishAttributeValue();
          if (r < 0) return r;
          this.index = this.index + 1;
          r = this.finishTag();
          if (r < 0) return r;
          this.state = S_BEFORE_DATA;
        } else {
          this.index = this.index + 1;
          this.appendToAttributeValue(this.index - 1, this.index);
        }
        break;
      case S_AFTER_ATTRIBUTE_VALUE_QUOTED:
        if (isSpace(character)) {
          this.index = this.index + 1;
          this.state = S_BEFORE_ATTRIBUTE_NAME;
        } else if (character === 47) {
          this.index = this.index + 1;
          this.state = S_SELF_CLOSING_START_TAG;
        } else if (character === 62) {
          this.index = this.index + 1;
          const r = this.finishTag();
          if (r < 0) return r;
          this.state = S_BEFORE_DATA;
        } else {
          this.state = S_BEFORE_ATTRIBUTE_NAME;
        }
        break;
      case S_SELF_CLOSING_START_TAG:
        if (character === 62) {
          this.index = this.index + 1;
          if (this.tagIsEnd) return this.errorAt(MSG_SELF_CLOSING_END_TAG, this.tagStart);
          this.tagSelfClosing = true;
          const r = this.finishTag();
          if (r < 0) return r;
          this.state = S_BEFORE_DATA;
        } else {
          this.state = S_BEFORE_ATTRIBUTE_NAME;
        }
        break;
      case S_END_TAG_OPEN:
        this.index = this.index + 1;
        if (startsTagName(character)) {
          this.state = S_END_TAG_NAME;
          this.beginTag(true);
          this.appendToTagName();
        } else {
          tree.hasLostText = true;
        }
        break;
      default:
        break;
    }
    return 0;
  }

  // `ContentStatement`: `tokenizePart` and `flushData`.
  content(start: number, end: number): number {
    this.index = start;
    this.end = end;
    const src = this.source;
    const tree = this.tree;
    // Only in a text and in the value of an attribute, an escaped mustache is printed with its backslash.
    if (end - start >= 2 && (src[start] | 0) === 123 && (src[start + 1] | 0) === 123) {
      switch (this.state) {
        case S_BEFORE_DATA:
        case S_BEFORE_ATTRIBUTE_VALUE:
        case S_ATTRIBUTE_VALUE_DOUBLE_QUOTED:
        case S_ATTRIBUTE_VALUE_SINGLE_QUOTED:
        case S_ATTRIBUTE_VALUE_UNQUOTED:
          break;
        case S_COMMENT_START:
        case S_COMMENT_START_DASH:
        case S_COMMENT:
        case S_COMMENT_END_DASH:
        case S_COMMENT_END:
          this.isCommentWritten = true;
          break;
        case S_TAG_NAME:
        case S_END_TAG_NAME:
        case S_BEFORE_ATTRIBUTE_NAME:
        case S_ATTRIBUTE_NAME:
        case S_AFTER_ATTRIBUTE_NAME:
        case S_AFTER_ATTRIBUTE_VALUE_QUOTED:
        case S_SELF_CLOSING_START_TAG:
          this.tagWritten = true;
          break;
        default:
          if (!isInDoctype(this.state)) tree.hasLostText = true;
          break;
      }
    }
    // It skips a character.
    if (this.hasReadTooFar) {
      this.hasReadTooFar = false;
      const c = this.peek();
      if (c < 0 || c === 10) return this.error(MSG_UNEXPECTED_CHARACTER);
      const r = this.consumeUnit();
      if (r < 0) return r;
      tree.hasLostText = true;
    }
    while (true) {
      const character = this.peek();
      if (character < 0) break;
      const wasInDoctype = isInDoctype(this.state);
      const r = this.step(character);
      if (r < 0) return r;
      if (wasInDoctype && this.state === S_BEFORE_DATA) {
        const e = this.index < this.end ? this.index : this.end;
        const doctype = tree.add(K_DOCTYPE, this.tagOpen, e);
        this.children.push(doctype);
      }
    }
    this.hasReadTooFar = this.index > this.end;
    this.index = this.end;
    if (this.state === S_DATA) {
      this.finishData();
      this.state = S_BEFORE_DATA;
    }
    return 0;
  }

  // ----------------------------------------------------------------------------------------- HandlebarsNodeVisitors

  addElementModifier(mustache: number): number {
    const tree = this.tree;
    if ((tree.tag[mustache] | 0) !== K_MUSTACHE) return this.error(MSG_MISPLACED_MUSTACHE);
    // Neither the third brace nor the tilde is in an `ElementModifierStatement`.
    if ((tree.f5[mustache] | 0) !== 0 || (tree.f6[mustache] | 0) !== 0) tree.keepAsWritten(mustache);
    const path = tree.f0[mustache] | 0;
    const pk = tree.kind(path);
    if (this.tagIsEnd || !(pk === K_PATH || pk === K_SUB_EXPRESSION)) return this.error(MSG_MISPLACED_MUSTACHE);
    tree.tag[mustache] = K_ELEMENT_MODIFIER;
    this.tagParts1.push(mustache);
    return 0;
  }

  mustache(mustache: number): number {
    switch (this.state) {
      case S_TAG_OPEN:
      case S_TAG_NAME:
        return this.error(MSG_MISPLACED_MUSTACHE);
      case S_BEFORE_ATTRIBUTE_NAME: {
        const r = this.addElementModifier(mustache);
        if (r < 0) return r;
        break;
      }
      case S_ATTRIBUTE_NAME:
      case S_AFTER_ATTRIBUTE_NAME: {
        this.beginAttributeValue(false);
        let r = this.finishAttributeValue();
        if (r < 0) return r;
        r = this.addElementModifier(mustache);
        if (r < 0) return r;
        this.state = S_BEFORE_ATTRIBUTE_NAME;
        break;
      }
      case S_AFTER_ATTRIBUTE_VALUE_QUOTED: {
        const r = this.addElementModifier(mustache);
        if (r < 0) return r;
        this.state = S_BEFORE_ATTRIBUTE_NAME;
        break;
      }
      case S_BEFORE_ATTRIBUTE_VALUE:
        this.beginAttributeValue(false);
        this.appendDynamicAttributeValuePart(mustache);
        this.state = S_ATTRIBUTE_VALUE_UNQUOTED;
        break;
      case S_ATTRIBUTE_VALUE_DOUBLE_QUOTED:
      case S_ATTRIBUTE_VALUE_SINGLE_QUOTED:
      case S_ATTRIBUTE_VALUE_UNQUOTED:
        this.appendDynamicAttributeValuePart(mustache);
        break;
      // Where a comment starts or ends, `@glimmer/syntax` puts it before the comment.
      case S_COMMENT_START:
      case S_COMMENT_START_DASH:
      case S_COMMENT_END_DASH:
      case S_COMMENT_END:
        this.isCommentWritten = true;
        this.state = S_COMMENT;
        break;
      default:
        if (this.state !== S_BEFORE_DATA && this.state !== S_DATA) this.tree.hasLostText = true;
        this.children.push(mustache);
        break;
    }
    return 0;
  }

  statement(index: number): number {
    const st = this.st;
    const tree = this.tree;
    const kind = st.kind[index] | 0;
    const start = st.start[index] | 0;
    const end = st.end[index] | 0;
    if (kind === SK_CONTENT) return this.content(start, end);
    if (kind === SK_UNSUPPORTED) return this.errorAt(MSG_UNSUPPORTED_MUSTACHE, start);
    // In an HTML comment, mustaches are text.
    if (this.state === S_COMMENT) {
      this.appendToComment(start, end);
      return 0;
    }
    if (kind === SK_COMMENT) {
      const comment = tree.add2(K_MUSTACHE_COMMENT, start, end, st.a[index] | 0, st.b[index] | 0);
      const state = this.state;
      if ((state === S_BEFORE_ATTRIBUTE_NAME || state === S_AFTER_ATTRIBUTE_NAME) && !this.tagIsEnd) {
        this.tagParts2.push(comment);
      } else if (state === S_BEFORE_DATA || state === S_DATA) {
        this.children.push(comment);
      } else {
        return this.errorAt(MSG_MISPLACED_COMMENT, start);
      }
    } else if (kind === SK_MUSTACHE) {
      const node = st.a[index] | 0;
      const flags = st.flags[index] | 0;
      if ((flags & SF_VALID) === 0) return this.errorAt(MSG_UNSUPPORTED_MUSTACHE, start);
      if ((flags & SF_WRITTEN) !== 0) tree.keepAsWritten(node);
      return this.mustache(node);
    } else if (kind === SK_BLOCK) {
      const node = st.a[index] | 0;
      const firstEnd = st.b[index] | 0;
      const flags = st.flags[index] | 0;
      const next = st.next[index] | 0;
      const bpS = st.bpS[index] | 0;
      const bpL = st.bpL[index] | 0;
      const hasSecond = (flags & SF_HAS_SECOND) !== 0;
      const isInverted = (flags & SF_INVERTED) !== 0;
      const isValid = (flags & SF_VALID) !== 0;
      const isWritten = (flags & SF_WRITTEN) !== 0;
      if (!(this.state === S_DATA || this.state === S_BEFORE_DATA) || !isValid) {
        return this.errorAt(MSG_MISPLACED_BLOCK, start);
      }
      let defaultBlock = 0;
      let elseBlock = 0;
      let r = 0;
      if (isInverted) {
        r = this.block(firstEnd, next, 0, 0);
        if (r < 0) return r;
        defaultBlock = r;
        r = this.block(index + 1, firstEnd, 0, 0);
        if (r < 0) return r;
        elseBlock = r;
      } else if (hasSecond) {
        r = this.block(index + 1, firstEnd, bpS, bpL);
        if (r < 0) return r;
        defaultBlock = r;
        r = this.block(firstEnd, next, 0, 0);
        if (r < 0) return r;
        elseBlock = r;
      } else {
        r = this.block(index + 1, firstEnd, bpS, bpL);
        if (r < 0) return r;
        defaultBlock = r;
        elseBlock = NOTHING;
      }
      tree.start[node] = start | 0;
      tree.end[node] = end | 0;
      tree.written[node] = isWritten ? 1 : 0;
      tree.f5[node] = defaultBlock | 0;
      tree.f6[node] = elseBlock | 0;
      this.children.push(node);
    }
    return 0;
  }

  // `parseProgram`: the statements `first..last`. The range of its children is in `rangeS`, `rangeL`.
  body(first: number, last: number): number {
    if (first >= last) {
      this.rangeS = 0;
      this.rangeL = 0;
      return 0;
    }
    if (!this.room.enter()) return -2;
    const depth = this.frameElement.len;
    this.frameElement.push(NOTHING);
    this.frameBase.push(this.children.len);
    let index = first;
    const st = this.st;
    while (index < last) {
      if (index >= st.n) break;
      const next = st.next[index] | 0;
      const r = this.statement(index);
      if (r < 0) return r;
      index = next;
    }
    // What is left of a tag or a comment goes on behind the block, or is lost.
    if (this.state !== S_BEFORE_DATA) this.tree.hasLostText = true;
    // An element that is open stays so.
    if (this.frameElement.len === 0) return this.error(MSG_END_TAG_WITHOUT_START_TAG);
    const element = this.frameElement.pop();
    const base = this.frameBase.pop();
    if (this.frameElement.len === depth) {
      this.takeChildren(base);
      this.room.leave();
      return 0;
    }
    if (element !== NOTHING) return this.errorAt(MSG_UNCLOSED_ELEMENT, this.tree.start[element] | 0);
    return this.error(MSG_END_TAG_WITHOUT_START_TAG);
  }

  // `Program`: the id of the block node (> 0).
  block(first: number, last: number, bpS: number, bpL: number): number {
    const r = this.body(first, last);
    if (r < 0) return r;
    const tree = this.tree;
    const node = tree.add(K_BLOCK, 0, 0);
    tree.f0[node] = this.rangeS | 0;
    tree.f1[node] = this.rangeL | 0;
    tree.f2[node] = bpS | 0;
    tree.f3[node] = bpL | 0;
    return node;
  }
}

const builder = new Builder();

// Adds the template that `statements` are to `tree`. `frontMatter` (a node, or -1) comes first in it. Returns the
// template (> 0), -1 (a syntax error is noted) or -2 (nested too deeply).
export function build(source: Uint8Array, statements: Statements, frontMatter: number, tree: Tree): number {
  const b = builder;
  b.source = source;
  b.st = statements;
  b.tree = tree;
  b.state = S_BEFORE_DATA;
  b.index = 0;
  b.end = 0;
  b.hasReadTooFar = false;
  b.isTagNameBufferEmpty = true;
  b.tagOpen = 0;
  b.tagIsEnd = false;
  b.tagNameS = 0;
  b.tagNameL = 0;
  b.tagStart = 0;
  b.tagSelfClosing = false;
  b.tagWritten = false;
  b.tagParts0.reset();
  b.tagParts1.reset();
  b.tagParts2.reset();
  b.sortedTagParts.reset();
  b.tagParams.reset();
  b.attrNameS = 0;
  b.attrNameL = 0;
  b.attrStart = 0;
  b.attrValueStart = 0;
  b.attrQuoted = false;
  b.attrDynamic = false;
  b.attrPartS = 0;
  b.attrPartL = 0;
  b.attributeParts.reset();
  b.start = 0;
  b.commentS = 0;
  b.commentL = 0;
  b.isCommentWritten = false;
  b.dash0 = 0;
  b.dash1 = 0;
  b.frameElement.reset();
  b.frameBase.reset();
  b.children.reset();
  b.room = Stack.forTree();
  const r = b.body(0, statements.n);
  if (r < 0) return r;
  let bodyS = b.rangeS;
  let bodyL = b.rangeL;
  if (frontMatter >= 0) {
    const nodes = new Int32Array(bodyL + 1);
    nodes[0] = frontMatter | 0;
    for (let i = 0; i < bodyL; i++) nodes[i + 1] = tree.lists[bodyS + i] | 0;
    bodyS = tree.addListFrom(nodes, 0, bodyL + 1);
    bodyL = bodyL + 1;
  }
  return tree.add2(K_TEMPLATE, 0, source.length, bodyS, bodyL);
}
