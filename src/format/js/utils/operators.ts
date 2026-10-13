// Port of vendor/bun/src/format/js/utils/operators.rs: questions about operators.
//
// `BinOp` / `UnOp` are the `BIN_*` / `UN_*` ints of the HIR. Rust's `BinOpExt` / `UnOpExt` methods are functions.
import {
  BIN_ADD,
  BIN_AND,
  BIN_BIT_AND,
  BIN_BIT_OR,
  BIN_BIT_XOR,
  BIN_COMMA,
  BIN_DIV,
  BIN_EQ_EQ,
  BIN_EQ_EQ_EQ,
  BIN_GE,
  BIN_GT,
  BIN_IN,
  BIN_INSTANCEOF,
  BIN_LE,
  BIN_LT,
  BIN_MUL,
  BIN_NOT_EQ,
  BIN_NOT_EQ_EQ,
  BIN_NULLISH,
  BIN_OR,
  BIN_REM,
  BIN_SHL,
  BIN_SHR,
  BIN_SUB,
  BIN_USHR,
  UN_DELETE,
  UN_POST_DEC,
  UN_POST_INC,
  UN_PRE_DEC,
  UN_PRE_INC,
  UN_TYPEOF,
  UN_VOID,
  binOpText,
  unOpText,
} from "../../../lint/ast/index.ts";

// `Precedence`: how tightly an operator binds. Only the order matters.
export const PREC_COMMA: number = 0;
export const PREC_NULLISH_COALESCING: number = 1;
export const PREC_LOGICAL_OR: number = 2;
export const PREC_LOGICAL_AND: number = 3;
export const PREC_BITWISE_OR: number = 4;
export const PREC_BITWISE_XOR: number = 5;
export const PREC_BITWISE_AND: number = 6;
export const PREC_EQUALS: number = 7;
export const PREC_COMPARE: number = 8;
export const PREC_SHIFT: number = 9;
export const PREC_ADD: number = 10;
export const PREC_MULTIPLY: number = 11;
export const PREC_EXPONENTIATION: number = 12;

export function precedenceIsBitwise(p: number): boolean {
  return p === PREC_BITWISE_OR || p === PREC_BITWISE_XOR || p === PREC_BITWISE_AND;
}
export function precedenceIsShift(p: number): boolean {
  return p === PREC_SHIFT;
}
export function precedenceIsAdditive(p: number): boolean {
  return p === PREC_ADD;
}

/** `BinOp::precedence` */
export function binOpPrecedence(op: number): number {
  switch (op) {
    case BIN_COMMA:
      return PREC_COMMA;
    case BIN_NULLISH:
      return PREC_NULLISH_COALESCING;
    case BIN_OR:
      return PREC_LOGICAL_OR;
    case BIN_AND:
      return PREC_LOGICAL_AND;
    case BIN_BIT_OR:
      return PREC_BITWISE_OR;
    case BIN_BIT_XOR:
      return PREC_BITWISE_XOR;
    case BIN_BIT_AND:
      return PREC_BITWISE_AND;
    case BIN_EQ_EQ:
    case BIN_NOT_EQ:
    case BIN_EQ_EQ_EQ:
    case BIN_NOT_EQ_EQ:
      return PREC_EQUALS;
    case BIN_LT:
    case BIN_LE:
    case BIN_GT:
    case BIN_GE:
    case BIN_IN:
    case BIN_INSTANCEOF:
      return PREC_COMPARE;
    case BIN_SHL:
    case BIN_SHR:
    case BIN_USHR:
      return PREC_SHIFT;
    case BIN_ADD:
    case BIN_SUB:
      return PREC_ADD;
    case BIN_MUL:
    case BIN_DIV:
    case BIN_REM:
      return PREC_MULTIPLY;
    default:
      return PREC_EXPONENTIATION;
  }
}

/** `BinOp::as_str` (a JS string: for the cold paths; `binOpText`). */
export function binOpAsStr(op: number): string {
  return binOpText(op);
}

/** `&&`, `||`, `??`: ESTree's `LogicalExpression`. */
export function binOpIsLogical(op: number): boolean {
  return op === BIN_AND || op === BIN_OR || op === BIN_NULLISH;
}

export function binOpIsRemainder(op: number): boolean {
  return op === BIN_REM;
}

/** `UnOp::as_str` */
export function unOpAsStr(op: number): string {
  return unOpText(op);
}

/** `typeof`, `void`, `delete` */
export function unOpIsKeyword(op: number): boolean {
  return op === UN_TYPEOF || op === UN_VOID || op === UN_DELETE;
}

/** `++`, `--`: ESTree's `UpdateExpression`. */
export function unOpIsUpdate(op: number): boolean {
  return op === UN_PRE_INC || op === UN_PRE_DEC || op === UN_POST_INC || op === UN_POST_DEC;
}

/** `++a`, `--a`, as opposed to `a++`, `a--`. */
export function unOpIsPrefix(op: number): boolean {
  return op !== UN_POST_INC && op !== UN_POST_DEC;
}
