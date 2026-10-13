// Port of vendor/bun/src/format/html/error.rs: the errors of `angular-html-parser`, with its messages.
import { ByteBuf } from "../../base/bytebuf.ts";

export const EK_UNEXPECTED_CHARACTER: number = 0;
export const EK_UNKNOWN_ENTITY: number = 1;
export const EK_DECIMAL_ENTITY_WITHOUT_SEMICOLON: number = 2;
export const EK_HEXADECIMAL_ENTITY_WITHOUT_SEMICOLON: number = 3;
export const EK_UNCLOSED_BLOCK: number = 4;
export const EK_ICU_WITHOUT_CLOSING_BRACE: number = 5;
export const EK_ICU_WITHOUT_OPENING_BRACE: number = 6;
export const EK_SELF_CLOSED: number = 7;
export const EK_OPENING_TAG_NOT_TERMINATED: number = 8;
export const EK_END_TAG_OF_VOID_ELEMENT: number = 9;
export const EK_UNEXPECTED_CLOSING_TAG: number = 10;
export const EK_UNEXPECTED_CLOSING_BLOCK: number = 11;
export const EK_INCOMPLETE_BLOCK: number = 12;
export const EK_LET_WITHOUT_VALUE: number = 13;
export const EK_LET_NOT_TERMINATED: number = 14;
export const EK_INCOMPLETE_LET: number = 15;
/** None of the parser's, for which `$EOF` is 0: a NUL between tags ends the text, and Prettier prints nothing of what follows. */
export const EK_TEXT_BEHIND_NUL: number = 16;
/** None of the parser's: Prettier fails over what has been parsed. */
export const EK_OTHER: number = 17;

/** The lexer finds it. Its errors come before those of the parser. */
export function errorIsOfLexer(kind: number): boolean {
  return kind <= EK_HEXADECIMAL_ENTITY_WITHOUT_SEMICOLON;
}

/** `name` of an error that names a literal "null" (no range of the text). */
export const NAME_NULL: number = -2;

export const E_STRIDE: number = 8;
export const EF_AT: number = 0;
export const EF_KIND: number = 1;
/** The namespace of `name`, if that is the name of an element. */
export const EF_PREFIX_S: number = 2;
export const EF_PREFIX_E: number = 3;
/** What the message names. For a character: the text from it on. */
export const EF_NAME_S: number = 4;
export const EF_NAME_E: number = 5;
/** `_isInExpansionForm()`, when it was thrown by the lexer. */
export const EF_IN_EXPANSION: number = 6;

/** A list of `SyntaxError`s, as a table. */
export class ErrorList {
  d: Int32Array;
  count: number;
  constructor() {
    this.d = new Int32Array(E_STRIDE * 8);
    this.count = 0;
  }
  clear(): void {
    this.count = 0;
  }
  push(at: number, kind: number, prefixS: number, prefixE: number, nameS: number, nameE: number, inExpansion: boolean): void {
    const i = this.count * E_STRIDE;
    if (i + E_STRIDE > this.d.length) {
      const nd = new Int32Array(this.d.length * 2);
      nd.set(this.d);
      this.d = nd;
    }
    const d = this.d;
    d[i + EF_AT] = at | 0;
    d[i + EF_KIND] = kind | 0;
    d[i + EF_PREFIX_S] = prefixS | 0;
    d[i + EF_PREFIX_E] = prefixE | 0;
    d[i + EF_NAME_S] = nameS | 0;
    d[i + EF_NAME_E] = nameE | 0;
    d[i + EF_IN_EXPANSION] = inExpansion ? 1 : 0;
    this.count = this.count + 1;
  }
  at(i: number): number {
    return this.d[i * E_STRIDE + EF_AT] | 0;
  }
  kind(i: number): number {
    return this.d[i * E_STRIDE + EF_KIND] | 0;
  }
}

function appendAscii(out: ByteBuf, s: string): void {
  out.appendAscii(s);
}

/** The length in bytes of the UTF-8 character that starts at `text[at]`. */
function charSize(text: Uint8Array, at: number, end: number): number {
  const b = text[at] | 0;
  let n = 1;
  if (b >= 0xf0) n = 4;
  else if (b >= 0xe0) n = 3;
  else if (b >= 0xc0) n = 2;
  return at + n > end ? end - at : n;
}

/** `error.msg` of the error number `i` of `list`, appended to `out`. `text` is what the ranges are of. */
export function errorMessage(list: ErrorList, i: number, text: Uint8Array, out: ByteBuf): void {
  const d = list.d;
  const b = i * E_STRIDE;
  const kind = d[b + EF_KIND] | 0;
  const prefixS = d[b + EF_PREFIX_S] | 0;
  const prefixE = d[b + EF_PREFIX_E] | 0;
  let nameS = d[b + EF_NAME_S] | 0;
  let nameE = d[b + EF_NAME_E] | 0;
  const isNull = nameS === NAME_NULL;
  const nameIsEmpty = !isNull && nameS >= nameE;
  let before = "";
  let after = "";
  switch (kind) {
    case EK_UNEXPECTED_CHARACTER:
      before = 'Unexpected character "';
      after = '"';
      break;
    case EK_UNKNOWN_ENTITY:
      before = 'Unknown entity "';
      after = '" - use the "&#<decimal>;" or  "&#x<hex>;" syntax';
      break;
    case EK_DECIMAL_ENTITY_WITHOUT_SEMICOLON:
      before = 'Unable to parse entity "';
      after = '" - decimal character reference entities must end with ";"';
      break;
    case EK_HEXADECIMAL_ENTITY_WITHOUT_SEMICOLON:
      before = 'Unable to parse entity "';
      after = '" - hexadecimal character reference entities must end with ";"';
      break;
    case EK_UNCLOSED_BLOCK:
      before = 'Unclosed block "';
      after = '"';
      break;
    case EK_ICU_WITHOUT_CLOSING_BRACE:
      before = "Invalid ICU message. Missing '}'.";
      break;
    case EK_ICU_WITHOUT_OPENING_BRACE:
      before = "Invalid ICU message. Missing '{'.";
      break;
    case EK_SELF_CLOSED:
      before = 'Only void, custom and foreign elements can be self closed "';
      after = '"';
      break;
    case EK_OPENING_TAG_NOT_TERMINATED:
      before = 'Opening tag "';
      after = '" not terminated.';
      break;
    case EK_END_TAG_OF_VOID_ELEMENT:
      before = 'Void elements do not have end tags "';
      after = '"';
      break;
    case EK_UNEXPECTED_CLOSING_TAG:
      before = 'Unexpected closing tag "';
      after =
        '". It may happen when the tag has already been closed by another tag. For more info see https://www.w3.org/TR/html5/syntax.html#closing-elements-that-have-implied-end-tags';
      break;
    case EK_UNEXPECTED_CLOSING_BLOCK:
      // The prefix counts for the name here.
      if (nameIsEmpty && prefixS >= prefixE) {
        before =
          'Unexpected closing block. The block may have been closed earlier. If you meant to write the `}` character, you should use the "&#125;" HTML entity instead.';
      } else {
        before = "Unexpected closing block. The block may have been closed earlier. Did you forget to close the <";
        after = '> element? If you meant to write the `}` character, you should use the "&#125;" HTML entity instead.';
      }
      break;
    case EK_INCOMPLETE_BLOCK:
      before = 'Incomplete block "';
      after = '". If you meant to write the @ character, you should use the "&#64;" HTML entity instead.';
      break;
    case EK_LET_WITHOUT_VALUE:
      before = 'Invalid @let declaration "';
      after = '". Declaration must have a value.';
      break;
    case EK_LET_NOT_TERMINATED:
      before = 'Unterminated @let declaration "';
      after = '". Declaration must be terminated with a semicolon.';
      break;
    case EK_INCOMPLETE_LET:
      if (nameIsEmpty && prefixS >= prefixE) {
        before = "Incomplete @let declaration. @let declarations must be written as `@let <name> = <value>;`";
      } else {
        before = 'Incomplete @let declaration "';
        after = '". @let declarations must be written as `@let <name> = <value>;`';
      }
      break;
    case EK_TEXT_BEHIND_NUL:
      before = "Unexpected NUL character";
      break;
    default:
      before = "Unexpected token";
      break;
  }
  appendAscii(out, before);
  if (kind === EK_UNEXPECTED_CHARACTER) {
    if (isNull) {
      appendAscii(out, "null");
    } else if (nameS >= nameE || (text[nameS] | 0) === 0) {
      appendAscii(out, "EOF");
    } else {
      const len = charSize(text, nameS, nameE);
      out.append(text, nameS, nameS + len);
    }
  } else if (kind === EK_ICU_WITHOUT_CLOSING_BRACE || kind === EK_ICU_WITHOUT_OPENING_BRACE || kind === EK_OTHER) {
    // No name.
  } else {
    if (prefixS < prefixE) {
      out.push(58);
      out.append(text, prefixS, prefixE);
      out.push(58);
    }
    if (isNull) appendAscii(out, "null");
    else out.append(text, nameS, nameE);
  }
  appendAscii(out, after);
  if ((d[b + EF_IN_EXPANSION] | 0) !== 0) {
    appendAscii(out, ' (Do you have an unescaped "{" in your template? Use "{{ \'{\' }}") to escape it.)');
  }
  void nameE;
  void nameS;
  nameS = 0;
  nameE = 0;
}
