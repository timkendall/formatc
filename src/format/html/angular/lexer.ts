// Port of vendor/bun/src/format/html/angular/lexer.rs: the lexer for the expressions of Angular: `_Scanner` of `@angular/compiler`.
import { I32Vec } from "../../../base/i32vec.ts";

// Kind
/** One of `( ) [ ] { } , : ; .`: `CH + the byte`. */
export const CH: number = 1000;
export const K_IDENTIFIER: number = 1;
export const K_PRIVATE_IDENTIFIER: number = 2;
/** One of `KEYWORDS`. */
export const K_KEYWORD: number = 3;
export const K_STRING: number = 4;
/** The text of a template up to a `${`. */
export const K_TEMPLATE_PART: number = 5;
/** The text of a template up to its end. */
export const K_TEMPLATE_END: number = 6;
/** It is what it is written as. */
export const K_OPERATOR: number = 7;
export const K_NUMBER: number = 8;
export const K_REG_EXP_BODY: number = 9;
export const K_REG_EXP_FLAGS: number = 10;
export const K_ERROR: number = 11;

export const TKS: number = 3;

function isKeyword(b: Uint8Array, s: number, e: number): boolean {
  const names = ["var", "let", "as", "null", "undefined", "true", "false", "if", "else", "this", "typeof", "void", "in", "instanceof"];
  for (let k = 0; k < names.length; k++) {
    const n = names[k];
    if (n.length !== e - s) continue;
    let same = true;
    for (let i = 0; i < n.length; i++) {
      if ((b[s + i] | 0) !== n.charCodeAt(i)) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

function isAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isIdentifierStart(c: number): boolean {
  return isAlpha(c) || c === 95 || c === 36;
}
function isIdentifierPart(c: number): boolean {
  return isAlpha(c) || isDigit(c) || c === 95 || c === 36;
}
function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

// What a `}` ends.
const BRACE_EXPRESSION = 0;
const BRACE_INTERPOLATION = 1;

class Scanner {
  input: Uint8Array;
  len: number;
  index: number;
  tokens: I32Vec;
  /** Where there is white space that is none to TypeScript. */
  oddBlanks: I32Vec;
  braceStack: I32Vec;

  constructor(input: Uint8Array, len: number, tokens: I32Vec, oddBlanks: I32Vec) {
    this.input = input;
    this.len = len;
    this.index = 0;
    this.tokens = tokens;
    this.oddBlanks = oddBlanks;
    this.braceStack = new I32Vec(8);
  }

  /** 0 at the end, as a NUL is. */
  peek(): number {
    return this.index < this.len ? this.input[this.index] | 0 : 0;
  }

  advance(): void {
    this.index = this.index + 1;
  }

  pushToken(kind: number, start: number, end: number): void {
    this.tokens.push(kind);
    this.tokens.push(start);
    this.tokens.push(end);
  }

  /** Makes a token that ends where the cursor is: returned in `rk`, `rs`, `re`. */
  rk: number = 0;
  rs: number = 0;
  re: number = 0;
  token(kind: number, start: number): void {
    this.rk = kind;
    this.rs = start;
    this.re = this.index < this.len ? this.index : this.len;
  }

  /** `start`: where what cannot be read starts. */
  error(start: number): void {
    this.token(K_ERROR, start);
  }

  /** Scans a token into `rk`, `rs`, `re`. Returns false at the end. */
  scanToken(): boolean {
    const input = this.input;
    const len = this.len;
    for (;;) {
      if (this.index >= len) return false;
      const c = input[this.index] | 0;
      if ((c >= 9 && c <= 13) || c === 32) {
        this.index = this.index + 1;
      } else if (c <= 32) {
        this.oddBlanks.push(this.index);
        this.index = this.index + 1;
      } else if (c === 0xc2 && this.index + 1 < len && (input[this.index + 1] | 0) === 0xa0) {
        // A no-break space.
        this.index = this.index + 2;
      } else {
        break;
      }
    }
    const start = this.index;
    const peek = this.peek();
    if (isIdentifierStart(peek)) {
      this.scanIdentifier();
      return true;
    }
    if (isDigit(peek)) {
      this.scanNumber(start);
      return true;
    }
    switch (peek) {
      case 46: {
        this.advance();
        if (isDigit(this.peek())) {
          this.scanNumber(start);
          return true;
        }
        if (this.peek() !== 46) {
          this.token(CH + 46, start);
          return true;
        }
        this.advance();
        if (this.peek() !== 46) {
          this.error(start);
          return true;
        }
        this.advance();
        this.token(K_OPERATOR, start);
        return true;
      }
      case 40:
      case 41:
      case 91:
      case 93:
      case 44:
      case 58:
      case 59:
        this.advance();
        this.token(CH + peek, start);
        return true;
      case 123:
        this.braceStack.push(BRACE_EXPRESSION);
        this.advance();
        this.token(CH + peek, start);
        return true;
      case 125: {
        this.advance();
        this.token(CH + peek, start);
        const brace = this.braceStack.len > 0 ? this.braceStack.pop() : -1;
        if (brace !== BRACE_INTERPOLATION) return true;
        this.pushToken(this.rk, this.rs, this.re);
        this.scanTemplateLiteralPart(this.index);
        return true;
      }
      case 39:
      case 34:
        this.scanString();
        return true;
      case 96:
        this.advance();
        this.scanTemplateLiteralPart(start);
        return true;
      case 35:
        this.advance();
        if (!isIdentifierStart(this.peek())) {
          this.error(start);
          return true;
        }
        while (isIdentifierPart(this.peek())) this.advance();
        this.token(K_PRIVATE_IDENTIFIER, start);
        return true;
      case 47:
        if (this.isStartOfRegex()) {
          this.scanRegex(start);
          return true;
        }
        this.scanComplexOperator(start, 61, -1);
        return true;
      case 43:
      case 45:
      case 37:
      case 60:
      case 62:
        this.scanComplexOperator(start, 61, -1);
        return true;
      case 94:
        this.advance();
        this.token(K_OPERATOR, start);
        return true;
      case 42:
        this.advance();
        if (this.peek() === 42) this.advance();
        if (this.peek() === 61) this.advance();
        this.token(K_OPERATOR, start);
        return true;
      case 63:
        this.advance();
        if (this.peek() === 63) {
          this.advance();
          if (this.peek() === 61) this.advance();
        } else if (this.peek() === 46) {
          this.advance();
        }
        this.token(K_OPERATOR, start);
        return true;
      case 33:
        this.scanComplexOperator(start, 61, 61);
        return true;
      case 61:
        this.advance();
        if (this.peek() === 62) {
          this.advance();
        } else if (this.peek() === 61) {
          this.advance();
          if (this.peek() === 61) this.advance();
        }
        this.token(K_OPERATOR, start);
        return true;
      case 38:
      case 124:
        this.scanComplexOperator(start, peek, 61);
        return true;
      default:
        // All of a character that is not ASCII.
        this.advance();
        while (this.peek() >= 0x80 && this.peek() <= 0xbf) this.advance();
        this.error(start);
        return true;
    }
  }

  scanComplexOperator(start: number, two: number, three: number): void {
    this.advance();
    if (this.peek() === two) this.advance();
    if (three >= 0 && this.peek() === three) this.advance();
    this.token(K_OPERATOR, start);
  }

  scanIdentifier(): void {
    const start = this.index;
    this.advance();
    while (isIdentifierPart(this.peek())) this.advance();
    const end = this.index < this.len ? this.index : this.len;
    this.token(isKeyword(this.input, start, end) ? K_KEYWORD : K_IDENTIFIER, start);
  }

  /** `start`: where the number starts, which is at the character before if that is a `.`. */
  scanNumber(start: number): void {
    const input = this.input;
    const len = this.len;
    const isDigitAt = (i: number): boolean => i >= 0 && i < len && isDigit(input[i] | 0);
    this.advance();
    for (;;) {
      const c = this.peek();
      if ((c >= 48 && c <= 57) || c === 46) {
        // fine
      } else if (c === 95) {
        if (!isDigitAt(this.index - 1) || !isDigitAt(this.index + 1)) {
          this.error(start);
          return;
        }
      } else if (c === 101 || c === 69) {
        this.advance();
        if (this.peek() === 45 || this.peek() === 43) this.advance();
        if (!isDigit(this.peek())) {
          this.error(start);
          return;
        }
      } else {
        break;
      }
      this.advance();
    }
    this.token(K_NUMBER, start);
  }

  /** What follows a `\`. Returns whether it can. */
  scanStringBackslash(): boolean {
    this.advance();
    if (this.peek() !== 117) {
      this.advance();
      return true;
    }
    const restStart = this.index + 1;
    const hexEnd = Math.min(this.len, restStart + 4);
    if (hexEnd <= restStart) return false;
    for (let i = restStart; i < hexEnd; i++) {
      if (!isHexDigit(this.input[i] | 0)) return false;
    }
    this.index = this.index + 5;
    return true;
  }

  scanString(): void {
    const start = this.index;
    const quote = this.peek();
    this.advance();
    while (this.peek() !== quote) {
      const c = this.peek();
      if (c === 92) {
        if (!this.scanStringBackslash()) {
          this.error(start);
          return;
        }
      } else if (c === 0) {
        this.error(start);
        return;
      } else {
        this.advance();
      }
    }
    this.advance();
    this.token(K_STRING, start);
  }

  scanTemplateLiteralPart(start: number): void {
    while (this.peek() !== 96) {
      const c = this.peek();
      if (c === 92) {
        if (!this.scanStringBackslash()) {
          this.error(start);
          return;
        }
      } else if (c === 36) {
        const dollar = this.index;
        this.advance();
        if (this.peek() === 123) {
          this.braceStack.push(BRACE_INTERPOLATION);
          this.pushToken(K_TEMPLATE_PART, start, dollar);
          this.advance();
          this.token(K_OPERATOR, dollar);
          return;
        }
      } else if (c === 0) {
        this.error(start);
        return;
      } else {
        this.advance();
      }
    }
    this.advance();
    this.token(K_TEMPLATE_END, start);
  }

  isOperatorToken(i: number, lit: string): boolean {
    const t = this.tokens.data;
    if ((t[i * TKS] | 0) !== K_OPERATOR) return false;
    const s = t[i * TKS + 1] | 0;
    const e = t[i * TKS + 2] | 0;
    if (e - s !== lit.length) return false;
    for (let k = 0; k < lit.length; k++) {
      if ((this.input[s + k] | 0) !== lit.charCodeAt(k)) return false;
    }
    return true;
  }

  isStartOfRegex(): boolean {
    const n = this.tokens.len / TKS;
    if (n === 0) return true;
    const t = this.tokens.data;
    const prev = n - 1;
    if (this.isOperatorToken(prev, "!")) {
      // It negates what follows it. After one of these it asserts that what is before it is not null.
      if (prev === 0) return true;
      const k = t[(prev - 1) * TKS] | 0;
      return !(k === K_IDENTIFIER || k === CH + 41 || k === CH + 93);
    }
    const k = t[prev * TKS] | 0;
    return k === K_OPERATOR || k === CH + 40 || k === CH + 91 || k === CH + 44 || k === CH + 58;
  }

  scanRegex(start: number): void {
    this.advance();
    let isInEscape = false;
    let isInCharacterClass = false;
    for (;;) {
      const c = this.peek();
      if (c === 0) {
        this.error(start);
        return;
      }
      if (isInEscape) {
        isInEscape = false;
      } else if (c === 92) {
        isInEscape = true;
      } else if (c === 91) {
        isInCharacterClass = true;
      } else if (c === 93) {
        isInCharacterClass = false;
      } else if (c === 47 && !isInCharacterClass) {
        break;
      }
      this.advance();
    }
    this.advance();
    this.token(K_REG_EXP_BODY, start);
    if (!isAlpha(this.peek())) return;
    this.pushToken(this.rk, this.rs, this.re);
    const flagsStart = this.index;
    while (isAlpha(this.peek())) this.advance();
    this.token(K_REG_EXP_FLAGS, flagsStart);
  }
}

/**
 * Appends the tokens of `input[..len]` to `tokens` (three numbers each: kind, start, end), and to `oddBlanks` where there is a character
 * between them that is white space to Angular and not to TypeScript.
 */
export function tokenize(input: Uint8Array, len: number, tokens: I32Vec, oddBlanks: I32Vec): void {
  const scanner = new Scanner(input, len, tokens, oddBlanks);
  while (scanner.scanToken()) scanner.pushToken(scanner.rk, scanner.rs, scanner.re);
}
