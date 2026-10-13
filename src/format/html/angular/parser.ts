// Port of vendor/bun/src/format/html/angular/parser.rs: the parser for the expressions of Angular: `Parser` and `_ParseAST` of
// `@angular/compiler`.
//
// It accepts what Angular accepts without an error. It makes no tree: what it makes of an expression is TypeScript that the parser for
// TypeScript reads into the tree that Angular makes of the expression. That is the text of the expression, except that
//
// - a pipe `a | b: c : d` is `a | b( c , d)`. Angular has no bitwise operators;
// - there are parentheses where TypeScript would group otherwise: `a => b | c` is `(a => b) | c`, `a && b ?? c` is `a && (b ?? c)`,
//   `a + b = c` is `a + (b = c)`, `--a` is `-(-a)`, ``a?.b`c`.d`` is ``(a?.b)`c`.d``, and `a < b` is `(a < b)`, which cannot be the start
//   of type arguments;
// - what TypeScript does not take is something as long that it takes: a name that is a reserved word starts with `_`, a line break before
//   `!`, before `=>` or after `.` is a blank, `1.2.3` is `11111`, and an escape sequence or a line break in a string is `_`.
//
// Names, numbers and strings are written as they are in the text, not as they are parsed: the formatter for JavaScript takes them from a
// second text, `shown`.
//
// `Result<T, Failed>` is a thrown number (`FAILED`); the entry points catch it.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { I32Vec } from "../../../base/i32vec.ts";
import { Stack } from "../../../base/stack.ts";
import {
  CH,
  K_ERROR,
  K_IDENTIFIER,
  K_KEYWORD,
  K_NUMBER,
  K_OPERATOR,
  K_REG_EXP_BODY,
  K_REG_EXP_FLAGS,
  K_STRING,
  K_TEMPLATE_END,
  K_TEMPLATE_PART,
  TKS,
  tokenize,
} from "./lexer.ts";

export const FAILED = 7001;

/** What is to be written for an expression. */
export class NgExpression {
  /** What Prettier prints, which is one string (`Code::Printed`); else `code` is the TypeScript. */
  isPrinted: boolean = false;
  printed: Uint8Array = EMPTY;
  /** `(`, the expression, a line break and `)`. */
  code: Uint8Array = EMPTY;
  /** The same, as long, for whoever writes a part of the text or looks at it, if that is not the same: with every name as it is written,
   * and blanks for the parentheses that are not written. */
  shown: Uint8Array | null = null;
  /** Prettier's `hasNgSideEffect`: there is a call or an assignment in it. */
  hasSideEffect: boolean = false;
}

const EMPTY = new Uint8Array(0);

// What an expression is, as far as that says where TypeScript needs parentheses to read it as Angular does.
const SH_PIPE = 0;
const SH_CONDITIONAL = 1;
const SH_OR = 2;
const SH_AND = 3;
const SH_NULLISH = 4;
/** Any other binary operator. */
const SH_BINARY = 5;
/** `+a`, `-a` */
const SH_SIGN = 6;
/** `!a`, `typeof a`, `void a` */
const SH_PREFIX = 7;
const SH_ARROW = 8;
const SH_ASSIGNMENT = 9;
const SH_OTHER = 10;

class Operand {
  start: number;
  end: number;
  shape: number;
  constructor(start: number, end: number, shape: number) {
    this.start = start;
    this.end = end;
    this.shape = shape;
  }
}

// Change
/** `)` before the byte, which ends the arguments of a pipe. */
const C_END_ARGUMENTS = 0;
/** `)` before the byte, which is shown as a blank: what asks what follows an expression finds what is in the text. */
const C_CLOSE = 1;
/** `(` before the byte, which is shown as a blank. */
const C_OPEN = 2;
/** Another byte in its place. */
const C_PUT = 3;
/** Another byte in its place, which is not shown. */
const C_HIDE = 4;

// The levels of binary operators, from the one that binds least.
const OR = 1;
const AND = 2;
const NULLISH = 3;
const EQUALITY = 4;
const RELATIONAL = 5;
const ADDITIVE = 6;
const MULTIPLICATIVE = 7;

const RESERVED = new Set<string>([
  "as", "do", "if", "in", "for", "let", "new", "try", "var", "case", "else", "enum", "eval", "null", "this", "true", "void", "with", "await",
  "break", "catch", "class", "const", "false", "super", "throw", "while", "yield", "delete", "export", "import", "public", "return", "static",
  "switch", "typeof", "default", "extends", "finally", "package", "private", "continue", "debugger", "function", "arguments", "interface",
  "protected", "undefined", "implements", "instanceof",
]);

function isAssignmentOperation(op: string): boolean {
  switch (op) {
    case "=":
    case "+=":
    case "-=":
    case "*=":
    case "/=":
    case "%=":
    case "**=":
    case "&&=":
    case "||=":
    case "??=":
      return true;
    default:
      return false;
  }
}

/** `Parser._commentStart`: where the comment starts that goes on to the end of `input`. -1: none. */
export function commentStart(input: Uint8Array, s: number, e: number): number {
  let hasSlashes = false;
  for (let i = s; i + 1 < e; i++) {
    if ((input[i] | 0) === 47 && (input[i + 1] | 0) === 47) {
      hasSlashes = true;
      break;
    }
  }
  if (!hasSlashes) return -1;
  let outerQuote = -1;
  for (let i = s; i < e; i++) {
    const b = input[i] | 0;
    if (b === 47 && i + 1 < e && (input[i + 1] | 0) === 47 && outerQuote < 0) return i - s;
    if (outerQuote === b) outerQuote = -1;
    else if (outerQuote < 0 && (b === 39 || b === 34 || b === 96)) outerQuote = b;
  }
  return -1;
}

/** The result of `parseChain`. */
export class ChainResult {
  expressions: NgExpression[] = [];
  nodeStart: number = 0;
  nodeEnd: number = 0;
}

export class AngularParser {
  input: Uint8Array;
  tokens: I32Vec;
  oddBlanks: I32Vec;
  index: number;
  /** `parseFlags & 1`: assignments and no pipes. */
  isAction: boolean;
  /** What makes TypeScript of the expression that is being parsed: `at`, `rank`, `change`, `byte` for each. */
  edits: I32Vec;
  /** How many calls and assignments there have been. */
  sideEffects: number;
  /** Where the parentheses are that have been closed last, and what is in them without parentheses of its own. */
  lastPS: number = 0;
  lastPE: number = 0;
  lastIS: number = 0;
  lastIE: number = 0;
  stack: Stack;

  /** `input`: all of the text. `len`: how much of it is not a comment. */
  constructor(input: Uint8Array, len: number, isAction: boolean) {
    this.input = input;
    this.tokens = new I32Vec(64);
    this.oddBlanks = new I32Vec(8);
    tokenize(input, len < input.length ? len : input.length, this.tokens, this.oddBlanks);
    this.index = 0;
    this.isAction = isAction;
    this.edits = new I32Vec(32);
    this.sideEffects = 0;
    this.stack = Stack.forTree();
  }

  // ───────────────────────────── tokens ─────────────────────────────

  tokenCount(): number {
    return this.tokens.len / TKS;
  }
  /** The token at `i`, or the end (kind `CH + 0`, start and end -1). */
  tk(i: number): number {
    return i < this.tokenCount() ? this.tokens.data[i * TKS] | 0 : CH;
  }
  ts(i: number): number {
    return i < this.tokenCount() ? this.tokens.data[i * TKS + 1] | 0 : -1;
  }
  te(i: number): number {
    return i < this.tokenCount() ? this.tokens.data[i * TKS + 2] | 0 : -1;
  }
  nextKind(): number {
    return this.tk(this.index);
  }
  nextStart(): number {
    return this.ts(this.index);
  }
  isAtEnd(): boolean {
    return this.index >= this.tokenCount();
  }
  textOf(i: number): string {
    const s = this.ts(i);
    const e = this.te(i);
    if (s < 0) return "";
    let r = "";
    for (let k = s; k < e; k++) r += String.fromCharCode(this.input[k] | 0);
    return r;
  }
  /** Whether the text of token `i` is `lit`. */
  textIs(i: number, lit: string): boolean {
    const s = this.ts(i);
    const e = this.te(i);
    if (s < 0 || e - s !== lit.length) return false;
    for (let k = 0; k < lit.length; k++) {
      if ((this.input[s + k] | 0) !== lit.charCodeAt(k)) return false;
    }
    return true;
  }

  /** `inputIndex` */
  inputIndex(): number {
    if (this.index < this.tokenCount()) return this.ts(this.index);
    return this.currentEndIndex();
  }

  /** `currentEndIndex` */
  currentEndIndex(): number {
    if (this.index >= 1 && this.index - 1 < this.tokenCount()) return this.te(this.index - 1);
    return this.tokenCount() > 0 ? this.ts(0) : this.input.length;
  }

  advance(): void {
    this.index = this.index + 1;
  }

  isCharacter(byte: number): boolean {
    return this.nextKind() === CH + byte;
  }

  isOperatorToken(i: number, op: string): boolean {
    return this.tk(i) === K_OPERATOR && this.textIs(i, op);
  }

  isOperator(op: string): boolean {
    return this.isOperatorToken(this.index, op);
  }

  isKeyword(kw: string): boolean {
    return this.nextKind() === K_KEYWORD && this.textIs(this.index, kw);
  }

  consumeOptionalCharacter(byte: number): boolean {
    const is = this.isCharacter(byte);
    if (is) this.advance();
    return is;
  }

  consumeOptionalOperator(op: string): boolean {
    const is = this.isOperator(op);
    if (is) this.advance();
    return is;
  }

  expectCharacter(byte: number): void {
    if (!this.consumeOptionalCharacter(byte)) throw FAILED;
  }

  isAssignmentOperator(): boolean {
    return this.nextKind() === K_OPERATOR && isAssignmentOperation(this.textOf(this.index));
  }

  // ───────────────────────────── TypeScript ─────────────────────────────

  edit(at: number, change: number, byte: number): void {
    const rank = change === C_END_ARGUMENTS || change === C_CLOSE ? 0 : change === C_OPEN ? 1 : 2;
    this.edits.push(at);
    this.edits.push(rank);
    this.edits.push(change);
    this.edits.push(byte);
  }

  /** Puts `operand` in parentheses. */
  wrap(o: Operand): void {
    this.edit(o.start, C_OPEN, 0);
    this.edit(o.end, C_CLOSE, 0);
  }

  /** Puts `operand` in parentheses if nothing but a comma, a colon or a bracket can be around it in TypeScript. */
  wrapArrowOrAssignment(o: Operand): void {
    if (o.shape === SH_ARROW || o.shape === SH_ASSIGNMENT) this.wrap(o);
  }

  /** Takes the line breaks out from before the token that is next, where TypeScript does not take one. */
  joinWithPreviousLine(): void {
    const from = this.currentEndIndex();
    const to = this.inputIndex();
    for (let at = from; at < to; at++) {
      if ((this.input[at] | 0) === 10) this.edit(at, C_HIDE, 32);
    }
  }

  /** `name` is where TypeScript expects a name that is not a reserved word. */
  hideReservedWord(i: number): void {
    if (RESERVED.has(this.textOf(i))) this.edit(this.ts(i), C_HIDE, 95);
  }

  /** Angular takes a line break and any escape sequence in a string. What is in it is nothing to the parser. */
  hideWhatIsInString(i: number): void {
    const s = this.ts(i);
    const e = this.te(i);
    let at = s;
    while (at < e) {
      const c = this.input[at] | 0;
      if (c === 92 || c === 10) {
        this.edit(at, C_HIDE, 95);
        at = at + 1;
        if (c === 92) {
          if (at < e && (this.input[at] | 0) < 128) this.edit(at, C_HIDE, 95);
          at = at + 1;
        }
      } else {
        at = at + 1;
      }
    }
  }

  /** Angular takes `1.2.3`, `1e2e3` and `01`. */
  hideWhatIsNoNumber(i: number): void {
    const s = this.ts(i);
    const e = this.te(i);
    let exponentAt = e;
    for (let k = s; k < e; k++) {
      const c = this.input[k] | 0;
      if (c === 101 || c === 69) {
        exponentAt = k;
        break;
      }
    }
    let dots = 0;
    for (let k = s; k < exponentAt; k++) {
      if ((this.input[k] | 0) === 46) dots = dots + 1;
    }
    let isNumber = dots <= 1;
    if (isNumber && exponentAt - s >= 2 && (this.input[s] | 0) === 48) {
      const c1 = this.input[s + 1] | 0;
      if ((c1 >= 48 && c1 <= 57) || c1 === 95) isNumber = false;
    }
    if (isNumber) {
      for (let k = exponentAt + 1; k < e; k++) {
        const c = this.input[k] | 0;
        if (c === 101 || c === 69 || c === 46) {
          isNumber = false;
          break;
        }
      }
    }
    if (!isNumber) {
      for (let at = s; at < e; at++) this.edit(at, C_HIDE, 49);
    }
  }

  operand(start: number, shape: number): Operand {
    return new Operand(start, this.currentEndIndex(), shape);
  }

  /**
   * What Prettier prints for the tokens `[first, last)`, which are an expression, if its document for that is nothing but strings: `a`, `a.b`,
   * `a()`, `a.b()`, a word that stands for a value or digits, after any number of `!`. A member access after anything but a name can be on a
   * line of its own, as can one after `a.b`. null: it is not.
   */
  printed(first: number, last: number): Uint8Array | null {
    if (first > last || last > this.tokenCount()) return null;
    let negations = 0;
    while (first + negations < last && this.isOperatorToken(first + negations, "!")) negations = negations + 1;
    let a = first + negations;
    let b = last;
    const n = b - a;
    if (n >= 2 && this.tk(b - 2) === CH + 40 && this.tk(b - 1) === CH + 41) {
      b = b - 2;
    } else if (n === 1 && this.tk(a) === K_KEYWORD) {
      return this.concatenated(first, last);
    } else if (n === 1 && this.tk(a) === K_NUMBER) {
      const s = this.ts(a);
      const e = this.te(a);
      for (let k = s; k < e; k++) {
        const c = this.input[k] | 0;
        if (c < 48 || c > 57) return null;
      }
      return this.concatenated(first, last);
    }
    const m = b - a;
    let isPrinted = false;
    if (m === 1) {
      isPrinted = this.tk(a) === K_IDENTIFIER;
    } else if (m === 3) {
      const property = this.tk(a + 2);
      isPrinted = this.tk(a) === K_IDENTIFIER && this.tk(a + 1) === CH + 46 && (property === K_IDENTIFIER || property === K_KEYWORD);
    }
    return isPrinted ? this.concatenated(first, last) : null;
  }

  concatenated(first: number, last: number): Uint8Array {
    const out = new ByteBuf(32);
    for (let i = first; i < last; i++) out.append(this.input, this.ts(i), this.te(i));
    return out.view().slice();
  }

  /**
   * Makes TypeScript of `operand`, which is all that has been parsed since the last call: the tokens from `firstToken` on.
   */
  finish(firstToken: number, o: Operand, hasSideEffect: boolean): NgExpression {
    const result = new NgExpression();
    result.hasSideEffect = hasSideEffect;
    const printed = this.printed(firstToken, this.index);
    if (printed !== null) {
      this.edits.reset();
      result.isPrinted = true;
      result.printed = printed;
      return result;
    }
    const start = o.start;
    const end = o.end;
    const blanks = this.oddBlanks;
    for (let i = 0; i < blanks.len; i++) {
      const at = blanks.data[i] | 0;
      if (at >= start && at < end) this.edit(at, C_PUT, 32);
    }
    // Sort by (at, rank), stably.
    const ed = this.edits.data;
    const count = this.edits.len / 4;
    for (let i = 1; i < count; i++) {
      let j = i;
      while (j > 0) {
        const a0 = ed[(j - 1) * 4] | 0;
        const a1 = ed[(j - 1) * 4 + 1] | 0;
        const b0 = ed[j * 4] | 0;
        const b1 = ed[j * 4 + 1] | 0;
        if (a0 > b0 || (a0 === b0 && a1 > b1)) {
          for (let k = 0; k < 4; k++) {
            const tmp = ed[(j - 1) * 4 + k] | 0;
            ed[(j - 1) * 4 + k] = ed[j * 4 + k] | 0;
            ed[j * 4 + k] = tmp;
          }
          j = j - 1;
        } else {
          break;
        }
      }
    }
    const code = new ByteBuf(end - start + count + 4);
    code.push(40);
    // Where a byte is hidden, and the byte.
    const hidden = new I32Vec(8);
    let from = start;
    for (let i = 0; i < count; i++) {
      const at = ed[i * 4] | 0;
      const change = ed[i * 4 + 2] | 0;
      const byte = ed[i * 4 + 3] | 0;
      if (at > from) code.append(this.input, from, at);
      from = at;
      if (change === C_END_ARGUMENTS) {
        code.push(41);
      } else if (change === C_CLOSE) {
        hidden.push(code.len);
        hidden.push(32);
        code.push(41);
      } else if (change === C_OPEN) {
        hidden.push(code.len);
        hidden.push(32);
        code.push(40);
      } else if (change === C_PUT) {
        code.push(byte);
        from = at + 1;
      } else {
        hidden.push(code.len);
        hidden.push(at < this.input.length ? this.input[at] | 0 : byte);
        code.push(byte);
        from = at + 1;
      }
    }
    this.edits.reset();
    if (end > from) code.append(this.input, from, end);
    code.appendAscii("\n)");
    result.code = code.view().slice();
    if (hidden.len > 0) {
      const shown = result.code.slice();
      for (let i = 0; i < hidden.len; i += 2) shown[hidden.data[i] | 0] = hidden.data[i + 1] | 0;
      result.shown = shown;
    }
    return result;
  }

  // ───────────────────────────── `_ParseAST` ─────────────────────────────

  /** Where `operand` is without the parentheses that all of it is in: into `wpS`, `wpE`. */
  wpS: number = 0;
  wpE: number = 0;
  withoutParentheses(o: Operand): void {
    if (this.lastPS === o.start && this.lastPE === o.end) {
      this.wpS = this.lastIS;
      this.wpE = this.lastIE;
    } else {
      this.wpS = o.start;
      this.wpE = o.end;
    }
  }

  /** `parseChain`. null: Angular reports an error, or the expression is nested too deeply. */
  parseChain(): ChainResult | null {
    try {
      return this.parseChainInner();
    } catch (e) {
      if (e === FAILED) return null;
      throw e;
    }
  }

  parseChainInner(): ChainResult {
    const result = new ChainResult();
    const start = this.inputIndex();
    let nodeS = start;
    let nodeE = start;
    while (!this.isAtEnd()) {
      const firstToken = this.index;
      const sideEffects = this.sideEffects;
      const operand = this.parsePipe();
      const hasSideEffect = this.sideEffects > sideEffects;
      result.expressions.push(this.finish(firstToken, operand, hasSideEffect));
      this.withoutParentheses(operand);
      nodeS = this.wpS;
      nodeE = this.wpE;
      if (this.consumeOptionalCharacter(59)) {
        if (!this.isAction) throw FAILED;
        while (this.consumeOptionalCharacter(59)) {
          // (more of them)
        }
      } else if (!this.isAtEnd()) {
        throw FAILED;
      }
    }
    if (result.expressions.length > 1) {
      nodeS = start;
      nodeE = this.currentEndIndex();
    }
    result.nodeStart = nodeS;
    result.nodeEnd = nodeE;
    return result;
  }

  parsePipe(): Operand {
    const start = this.inputIndex();
    let result = this.parseConditional();
    if (!this.isOperator("|")) return result;
    if (this.isAction) throw FAILED;
    if (result.shape === SH_OR || result.shape === SH_AND || result.shape === SH_NULLISH || result.shape === SH_ARROW || result.shape === SH_ASSIGNMENT) {
      this.wrap(result);
    }
    while (this.consumeOptionalOperator("|")) {
      const name = this.index;
      const k = this.nextKind();
      if (k !== K_IDENTIFIER && k !== K_KEYWORD) throw FAILED;
      this.hideReservedWord(name);
      this.advance();
      let hasArguments = false;
      while (this.isCharacter(58)) {
        this.edit(this.nextStart(), C_PUT, hasArguments ? 44 : 40);
        this.advance();
        hasArguments = true;
        this.parseConditional();
      }
      if (hasArguments) this.edit(this.currentEndIndex(), C_END_ARGUMENTS, 0);
      result = this.operand(start, SH_PIPE);
    }
    return result;
  }

  /** `parseExpression` */
  parseConditional(): Operand {
    const start = this.inputIndex();
    const result = this.parseBinary(OR);
    if (!this.consumeOptionalOperator("?")) return result;
    this.parsePipe();
    this.expectCharacter(58);
    this.parsePipe();
    return this.operand(start, SH_CONDITIONAL);
  }

  /** The level of the binary operator that is next: 0 if it is none. */
  binaryLevel(): number {
    const k = this.nextKind();
    if (k !== K_OPERATOR && k !== K_KEYWORD) return 0;
    const text = this.textOf(this.index);
    if (k === K_OPERATOR) {
      switch (text) {
        case "||": return OR;
        case "&&": return AND;
        case "??": return NULLISH;
        case "==":
        case "===":
        case "!=":
        case "!==": return EQUALITY;
        case "<":
        case ">":
        case "<=":
        case ">=": return RELATIONAL;
        case "+":
        case "-": return ADDITIVE;
        case "*":
        case "%":
        case "/": return MULTIPLICATIVE;
        default: return 0;
      }
    }
    return text === "in" || text === "instanceof" ? RELATIONAL : 0;
  }

  /** `parseLogicalOr` down to `parseMultiplicative`: what the operators of `level` and above make. */
  parseBinary(level: number): Operand {
    const start = this.inputIndex();
    let left = this.parseExponentiation();
    for (;;) {
      const operatorLevel = this.binaryLevel();
      if (operatorLevel === 0 || operatorLevel < level) break;
      const operatorToken = this.index;
      const operatorEnd = this.te(operatorToken);
      const isLessThan = this.textIs(operatorToken, "<");
      this.advance();
      const right = this.parseBinary(operatorLevel + 1);
      this.wrapArrowOrAssignment(right);
      const shape = operatorLevel === OR ? SH_OR : operatorLevel === AND ? SH_AND : operatorLevel === NULLISH ? SH_NULLISH : SH_BINARY;
      if (operatorLevel === OR || operatorLevel === AND) {
        // TypeScript does not take `??` next to these.
        if (left.shape === SH_NULLISH) this.wrap(left);
        if (right.shape === SH_NULLISH) this.wrap(right);
      } else if (operatorLevel === ADDITIVE) {
        // `a--b`, `a++b % c`, `a//b/`
        const c = this.input[right.start] | 0;
        if (right.start < this.input.length && (c === 43 || c === 45)) this.wrap(right);
      } else if (operatorLevel === MULTIPLICATIVE) {
        if (right.start === operatorEnd && right.start < this.input.length && (this.input[right.start] | 0) === 47) this.wrap(right);
      }
      left = this.operand(start, shape);
      if (isLessThan) this.wrap(left);
    }
    return left;
  }

  parseExponentiation(): Operand {
    const start = this.inputIndex();
    let result = this.parsePrefix();
    while (this.isOperator("**")) {
      if (result.shape === SH_SIGN || result.shape === SH_PREFIX) throw FAILED;
      this.advance();
      const right = this.parseExponentiation();
      this.wrapArrowOrAssignment(right);
      result = this.operand(start, SH_BINARY);
    }
    return result;
  }

  parsePrefix(): Operand {
    if (!this.stack.enter()) throw FAILED;
    const o = this.parsePrefixInner();
    this.stack.leave();
    return o;
  }

  parsePrefixInner(): Operand {
    const next = this.index;
    const k = this.nextKind();
    let shape: number;
    if (k === K_OPERATOR && (this.textIs(next, "+") || this.textIs(next, "-"))) shape = SH_SIGN;
    else if ((k === K_OPERATOR && this.textIs(next, "!")) || (k === K_KEYWORD && (this.textIs(next, "typeof") || this.textIs(next, "void")))) shape = SH_PREFIX;
    else return this.parseCallChain();
    const nextStart = this.ts(next);
    this.advance();
    const operand = this.parsePrefix();
    this.wrapArrowOrAssignment(operand);
    // `--a`
    if (shape === SH_SIGN && operand.shape === SH_SIGN) this.wrap(operand);
    return this.operand(nextStart, shape);
  }

  parseCallChain(): Operand {
    const start = this.inputIndex();
    let result = this.parsePrimary();
    // There has been a `?.`.
    let isOptionalChain = false;
    for (;;) {
      if (this.consumeOptionalCharacter(46)) {
        this.joinWithPreviousLine();
        result = this.parseAccessMember(start, false);
      } else if (this.consumeOptionalOperator("?.")) {
        isOptionalChain = true;
        if (this.consumeOptionalCharacter(40)) {
          result = this.parseCall(start);
        } else if (this.consumeOptionalCharacter(91)) {
          result = this.parseKeyedReadOrWrite(start, true);
        } else {
          this.joinWithPreviousLine();
          result = this.parseAccessMember(start, true);
        }
      } else if (this.consumeOptionalCharacter(91)) {
        result = this.parseKeyedReadOrWrite(start, false);
      } else if (this.consumeOptionalCharacter(40)) {
        result = this.parseCall(start);
      } else if (this.isOperator("!")) {
        this.joinWithPreviousLine();
        this.advance();
        result = this.operand(start, SH_OTHER);
      } else if (this.nextKind() === K_TEMPLATE_END || this.nextKind() === K_TEMPLATE_PART) {
        // To TypeScript the chain goes on behind the template.
        if (isOptionalChain) {
          isOptionalChain = false;
          this.wrap(result);
        }
        this.parseTemplateLiteral();
        result = this.operand(start, SH_OTHER);
      } else {
        return result;
      }
    }
  }

  parsePrimary(): Operand {
    const start = this.inputIndex();
    if (this.isArrowFunction()) return this.parseArrowFunction(start);
    const next = this.index;
    const k = this.nextKind();
    if (k === CH + 40) {
      this.advance();
      const inner = this.parsePipe();
      this.expectCharacter(41);
      this.withoutParentheses(inner);
      this.lastIS = this.wpS;
      this.lastIE = this.wpE;
      this.lastPS = start;
      this.lastPE = this.currentEndIndex();
    } else if (
      k === K_KEYWORD &&
      (this.textIs(next, "null") || this.textIs(next, "undefined") || this.textIs(next, "true") || this.textIs(next, "false") || this.textIs(next, "this"))
    ) {
      this.advance();
    } else if (k === CH + 91) {
      this.parseLiteralArray();
    } else if (k === CH + 123) {
      this.parseLiteralMap();
    } else if (k === K_IDENTIFIER) {
      this.hideReservedWord(next);
      // To TypeScript, `async(...a)` and `async() :` can only be the start of an arrow function.
      if (this.textIs(next, "async") && this.tk(this.index + 1) === CH + 40) this.edit(this.ts(next), C_HIDE, 95);
      return this.parseAccessMember(start, false);
    } else if (k === K_NUMBER) {
      this.hideWhatIsNoNumber(next);
      this.advance();
    } else if (k === K_STRING) {
      this.hideWhatIsInString(next);
      this.advance();
    } else if (k === K_TEMPLATE_END || k === K_TEMPLATE_PART) {
      this.parseTemplateLiteral();
    } else if (k === K_REG_EXP_BODY) {
      this.parseRegularExpressionLiteral();
    } else {
      throw FAILED;
    }
    return this.operand(start, SH_OTHER);
  }

  /** `...` and what is spread, or an expression. */
  parseSpreadElementOrPipe(): void {
    this.consumeOptionalOperator("...");
    this.parsePipe();
  }

  parseLiteralArray(): void {
    this.advance();
    while (!this.isCharacter(93)) {
      this.parseSpreadElementOrPipe();
      if (!this.consumeOptionalCharacter(44)) break;
    }
    this.expectCharacter(93);
  }

  parseLiteralMap(): void {
    this.advance();
    if (this.consumeOptionalCharacter(125)) return;
    for (;;) {
      if (this.isOperator("...")) {
        this.parseSpreadElementOrPipe();
      } else {
        const key = this.index;
        const kind = this.nextKind();
        this.advance();
        if (kind === K_STRING) {
          this.hideWhatIsInString(key);
          this.expectCharacter(58);
          this.parsePipe();
        } else if (kind === K_TEMPLATE_END) {
          // To Angular it is a string like another.
          const s = this.ts(key);
          const e = this.te(key);
          for (let i = s; i < e; i++) {
            const c = this.input[i] | 0;
            if (c === 39 || c === 34 || c === 92 || c === 10) throw FAILED;
          }
          this.edit(s, C_PUT, 39);
          this.edit(e - 1, C_PUT, 39);
          this.expectCharacter(58);
          this.parsePipe();
        } else if (kind === K_IDENTIFIER || kind === K_KEYWORD) {
          if (this.consumeOptionalCharacter(58)) this.parsePipe();
          else this.hideReservedWord(key);
        } else {
          throw FAILED;
        }
      }
      if (!this.consumeOptionalCharacter(44) || this.isCharacter(125)) break;
    }
    this.expectCharacter(125);
  }

  /** The name of a property, which is next. `start`: where what it is a property of starts, or the name. */
  parseAccessMember(start: number, isSafe: boolean): Operand {
    const k = this.nextKind();
    if (k !== K_IDENTIFIER && k !== K_KEYWORD) throw FAILED;
    this.advance();
    if (!this.isAssignmentOperator()) return this.operand(start, SH_OTHER);
    if (isSafe || !this.isAction) throw FAILED;
    return this.parseAssignedValue(start);
  }

  /** The operator of an assignment, which is next, and the value. */
  parseAssignedValue(start: number): Operand {
    this.advance();
    this.parseConditional();
    this.sideEffects = this.sideEffects + 1;
    return this.operand(start, SH_ASSIGNMENT);
  }

  /** The arguments, after the `(`. */
  parseCall(start: number): Operand {
    if (!this.isCharacter(41)) {
      for (;;) {
        this.parseSpreadElementOrPipe();
        if (!this.consumeOptionalCharacter(44)) break;
      }
    }
    this.expectCharacter(41);
    this.sideEffects = this.sideEffects + 1;
    return this.operand(start, SH_OTHER);
  }

  /** The key, after the `[`. */
  parseKeyedReadOrWrite(start: number, isSafe: boolean): Operand {
    this.parsePipe();
    this.expectCharacter(93);
    if (!this.isAssignmentOperator()) return this.operand(start, SH_OTHER);
    if (isSafe) throw FAILED;
    return this.parseAssignedValue(start);
  }

  /** `parseTemplateLiteral`, `parseNoInterpolationTemplateLiteral` */
  parseTemplateLiteral(): void {
    while (!this.isAtEnd()) {
      const token = this.index;
      const kind = this.nextKind();
      this.advance();
      if (kind === K_TEMPLATE_PART) {
        // (nothing)
      } else if (kind === K_TEMPLATE_END) {
        break;
      } else if (kind === K_OPERATOR && this.textIs(token, "${")) {
        this.parsePipe();
      } else if (kind === CH + 125 && (this.nextKind() === K_TEMPLATE_PART || this.nextKind() === K_TEMPLATE_END) && this.nextStart() === this.te(token)) {
        // The end of what is interpolated.
      } else {
        // Angular passes over anything else.
        for (let at = this.ts(token); at < this.te(token); at++) this.edit(at, C_PUT, 32);
      }
    }
  }

  parseRegularExpressionLiteral(): void {
    // `//`, which Angular takes, starts a comment in TypeScript. A name is written as it is in the text too.
    const body = this.index;
    const bs = this.ts(body);
    const be = this.te(body);
    if (be - bs === 2) {
      this.edit(bs, C_HIDE, 95);
      this.edit(bs + 1, C_HIDE, 95);
    }
    // So does `/*`, and a line break ends a regular expression there.
    for (let at = bs; at < be; at++) {
      const c = this.input[at] | 0;
      if (c === 10 || (c === 42 && at === bs + 1)) this.edit(at, C_HIDE, 95);
    }
    this.advance();
    const flags = this.index;
    if (this.nextKind() !== K_REG_EXP_FLAGS) return;
    this.advance();
    const seen = new Uint8Array(128);
    for (let at = this.ts(flags); at < this.te(flags); at++) {
      const flag = this.input[at] | 0;
      const ok = flag === 100 || flag === 103 || flag === 105 || flag === 109 || flag === 115 || flag === 117 || flag === 118 || flag === 121;
      if (!ok || (seen[flag] | 0) !== 0) throw FAILED;
      seen[flag] = 1;
    }
  }

  isArrowFunction(): boolean {
    const i = this.index;
    if (i + 1 < this.tokenCount() + 0 && this.tk(i) === K_IDENTIFIER) return this.isOperatorToken(i + 1, "=>");
    if (this.tk(i) === CH + 40 && i < this.tokenCount()) {
      let parameters = 0;
      for (;;) {
        const k = this.tk(i + 1 + parameters);
        if (i + 1 + parameters < this.tokenCount() && (k === K_IDENTIFIER || k === CH + 44)) parameters = parameters + 1;
        else break;
      }
      const close = i + 1 + parameters;
      return close + 1 < this.tokenCount() && this.tk(close) === CH + 41 && this.isOperatorToken(close + 1, "=>");
    }
    return false;
  }

  parseArrowFunction(start: number): Operand {
    if (!this.consumeOptionalCharacter(40)) {
      this.hideReservedWord(this.index);
      this.advance();
    } else if (!this.consumeOptionalCharacter(41)) {
      for (;;) {
        const parameter = this.index;
        if (this.nextKind() !== K_IDENTIFIER) throw FAILED;
        this.hideReservedWord(parameter);
        this.advance();
        if (this.consumeOptionalCharacter(41)) break;
        this.expectCharacter(44);
      }
    }
    this.joinWithPreviousLine();
    if (!this.consumeOptionalOperator("=>") || this.isCharacter(123)) throw FAILED;
    const isAction = this.isAction;
    this.isAction = true;
    try {
      this.parseConditional();
    } finally {
      this.isAction = isAction;
    }
    return this.operand(start, SH_ARROW);
  }
}

void K_ERROR;
void EQUALITY;
