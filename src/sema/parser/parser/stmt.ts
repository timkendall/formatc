// Port of vendor/bun/src/sema/parser/parser/stmt.rs: statements and declarations.
//
// Conventions: those of mod.ts (module-level `lx`, `p`, `s`; free functions; several results via `p.outPos/outLen/outA/outB`).
// `Start { pos, full }` is passed as two numbers `(startPos, startFull)`. A statement is pushed with `pushStmt<Kind>(startPos, ..)`
// and given its `loc` and modifiers by `finishStmt` (Rust `add_stmt`).
// Only the non-recovering Babel/TypeScript parse is ported: the branches for oxc, Flow, JSDoc and recovery are `// TODO(..)` comments.
import {
  FLAG_ABSTRACT,
  FLAG_ACCESSOR,
  FLAG_AMBIENT,
  FLAG_ASYNC,
  FLAG_CONST,
  FLAG_DEFAULT,
  FLAG_DEFINITE,
  FLAG_EXPORT,
  FLAG_IN,
  FLAG_OUT,
  FLAG_OVERRIDE,
  FLAG_PRIVATE,
  FLAG_PROTECTED,
  FLAG_PUBLIC,
  FLAG_READONLY,
  FLAG_STATIC,
  MODK_DECORATOR,
  MODK_KEYWORD,
  MODNAME_GLOBAL,
  MODNAME_IDENT,
  MODNAME_STRING,
  NK_IDENTIFIER,
  NONE,
  PAT_IDENT,
  PK_COMPUTED,
  PK_NAME,
  PK_PRIVATE,
  RARE_AWAIT_USING,
  RARE_DECLARATION_AS_BODY,
  RARE_FOR_AWAIT,
  RARE_NESTED_DECLARE,
  RARE_ODD_DECLARATION,
  RARE_ODD_JUMP,
  RARE_ODD_LOOP_HEAD,
  STMT_CLASS,
  STMT_FN,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_EXPR,
  STMT_IMPORT,
  STMT_VAR,
  EXPR_IDENT,
  VAR_AWAIT_USING,
  VAR_CONST,
  VAR_LET,
  VAR_USING,
  VAR_VAR,
  DK_GRAMMAR,
  hir,
  pushExprMissing,
  pushStmtBlock,
  pushStmtBreak,
  pushStmtContinue,
  pushStmtDebugger,
  pushStmtDoWhile,
  pushStmtEmpty,
  pushStmtEnum,
  pushStmtExpr,
  pushStmtFor,
  pushStmtForIn,
  pushStmtForOf,
  pushStmtIf,
  pushStmtLabeled,
  pushStmtModule,
  pushStmtReturn,
  pushStmtSwitch,
  pushStmtThrow,
  pushStmtTry,
  pushStmtVar,
  pushStmtWhile,
} from "../../hir.ts";
import { ATOM_NONE } from "../../atom.ts";
import {
  T_ABSTRACT,
  T_ACCESSOR,
  T_ASYNC,
  T_AS,
  T_AT,
  T_ASTERISK,
  T_AWAIT,
  T_BIG_INT,
  T_BREAK,
  T_CASE,
  T_CATCH,
  T_CLASS,
  T_CLOSE_BRACE,
  T_CLOSE_PAREN,
  T_COLON,
  T_COMMA,
  T_CONST,
  T_CONTINUE,
  T_DEBUGGER,
  T_DECLARE,
  T_DEFAULT,
  T_DO,
  T_DOT,
  T_DOT_DOT_DOT,
  T_ELSE,
  T_ENUM,
  T_EOF,
  T_EQUALS,
  T_EXCLAMATION,
  T_EXPORT,
  T_FINALLY,
  T_FOR,
  T_FUNCTION,
  T_GET,
  T_GLOBAL,
  T_IDENTIFIER,
  T_IF,
  T_IMPORT,
  T_IN,
  T_INSTANCE_OF,
  T_INTERFACE,
  T_LET,
  T_MODULE,
  T_NAMESPACE,
  T_NUMBER,
  T_OF,
  T_OPEN_BRACE,
  T_OPEN_BRACKET,
  T_OPEN_PAREN,
  T_OVERRIDE,
  T_PRIVATE,
  T_PRIVATE_IDENTIFIER,
  T_PROTECTED,
  T_PUBLIC,
  T_READONLY,
  T_RETURN,
  T_SEMICOLON,
  T_SET,
  T_STATIC,
  T_STRING,
  T_SWITCH,
  T_THROW,
  T_TRY,
  T_TYPE,
  T_USING,
  T_VAR,
  T_WHILE,
  T_WITH,
  T_OUT,
  isModifier,
} from "../token.ts";
import { R_REPORTED } from "../lib.ts";
import {
  CTX_AMBIENT,
  CTX_AWAIT,
  CTX_DECORATOR,
  CTX_DISALLOW_IN,
  CTX_IN_LOOP,
  CTX_IN_NAMESPACE,
  CTX_IN_SWITCH,
  CTX_TOP_LEVEL,
  CTX_YIELD,
  LK_BLOCK_STATEMENTS,
  LK_ENUM_MEMBERS,
  LK_SWITCH_CLAUSES,
  LK_SWITCH_CLAUSE_STATEMENTS,
  LK_VARIABLE_DECLARATIONS,
  MODS_CLASS_MEMBER,
  MODS_DECLARATION,
  MODS_TYPE_PARAMETER,
  ambient,
  canParseSemicolon,
  eat,
  enterContext,
  enterDepth,
  enterList,
  errorAtToken,
  expect,
  expectMatching,
  fail,
  failUnlessRecovering,
  flag,
  hasContext,
  identifier,
  isBefore,
  isBindingIdentifier,
  isIdentifier,
  isInList,
  leaveDepth,
  leaveList,
  lookAheadEnd,
  lx,
  missingIdentifier,
  missingName,
  names,
  nextAfterName,
  noteIdentifier,
  p,
  peek,
  refuse,
  report,
  s,
  semicolon,
  takeIds,
  takeList,
} from "./mod.ts";
import { isAtElement, goesOnWithoutComma } from "./recover.ts";
import {
  assignmentExpression,
  decoratorExpression,
  expression,
  expressionAllowingIn,
  isFollowedByWordOnSameLine,
  isParenthesized,
  nextIsFunctionOnSameLine,
  noteAwait,
  noteTarget,
  propertyName,
} from "./expr.ts";
import { checkJsStatement } from "./js_syntax.ts";
import { classDeclaration } from "./class.ts";
import { functionDeclaration } from "./func.ts";
import { identifierOrPattern } from "./pattern.ts";
import { typeAliasDeclaration, interfaceDeclaration, typeAnnotation } from "./ty.ts";
import {
  exportAssignment,
  exportDeclaration,
  importDeclarationOrImportEquals,
  namespaceExportDeclaration,
} from "./module.ts";
import { takeStrayDecorators } from "./recover.ts";
import { missingSemicolonAfter } from "./mod.ts";
import { T_DEFER, T_MINUS, T_PLUS } from "../token.ts";
import {
  flowDeclarationAfterExpression,
  flowDeclarationAtWord,
  flowDeclareBeforeExport,
  flowDeclareClass,
  flowDeclareExportDefaultType,
  flowDeclareFunction,
  flowDeclareModuleExports,
  flowEnum,
  flowInterface,
  flowIsAtDeclarationWord,
  flowTypeAlias,
} from "./flow.ts";
import { error } from "./mod.ts";
import { missingBindingIdentifier } from "./pattern.ts";
import { identifierName } from "./mod.ts";

/** `ModifierToFlag` */
export function modifierFlag(token: number): number {
  switch (token) {
    case T_ABSTRACT:
      return FLAG_ABSTRACT;
    case T_ACCESSOR:
      return FLAG_ACCESSOR;
    case T_ASYNC:
      return FLAG_ASYNC;
    case T_CONST:
      return FLAG_CONST;
    case T_DECLARE:
      return FLAG_AMBIENT;
    case T_DEFAULT:
      return FLAG_DEFAULT;
    case T_EXPORT:
      return FLAG_EXPORT;
    case T_IN:
      return FLAG_IN;
    case T_OUT:
      return FLAG_OUT;
    case T_OVERRIDE:
      return FLAG_OVERRIDE;
    case T_PRIVATE:
      return FLAG_PRIVATE;
    case T_PROTECTED:
      return FLAG_PROTECTED;
    case T_PUBLIC:
      return FLAG_PUBLIC;
    case T_READONLY:
      return FLAG_READONLY;
    case T_STATIC:
      return FLAG_STATIC;
    default:
      return 0;
  }
}

/** The number of bits set in `x`. */
function popCount(x: number): number {
  let n = 0;
  let v = x | 0;
  while (v !== 0) {
    v = v & ((v - 1) | 0);
    n = (n + 1) | 0;
  }
  return n;
}

/**
 * `finishNode` for a statement that ends with the previous token: sets its `loc` (from `startFull` to the end of the previous token)
 * and its modifiers (`modStart`, `modLen`). Returns the statement.
 */
export function finishStmt(stmt: number, startFull: number, modStart: number, modLen: number): number {
  hir.stmtLocPos[stmt] = startFull | 0;
  hir.stmtLocEnd[stmt] = lx.fullStart | 0;
  hir.stmtModStart[stmt] = modStart | 0;
  hir.stmtModLen[stmt] = modLen | 0;
  return stmt;
}

/** `parseStatement` */
export function statement(): number {
  if (!enterDepth()) return NONE;
  const r = statementInDoor();
  leaveDepth();
  return r;
}

function statementInDoor(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  const t = lx.token;
  switch (t) {
    case T_SEMICOLON:
      lx.next();
      return finishStmt(pushStmtEmpty(startPos), startFull, 0, 0);
    case T_OPEN_BRACE:
      return block();
    case T_VAR:
    case T_CONST:
      return declaration();
    case T_LET:
      if (isLetDeclaration()) return declaration();
      return expressionOrLabeledStatement();
    case T_AWAIT:
      if (isAwaitUsingDeclaration()) return declaration();
      return expressionOrLabeledStatement();
    case T_USING:
      if (isUsingDeclaration()) return declaration();
      return expressionOrLabeledStatement();
    case T_FUNCTION:
    case T_CLASS:
    case T_ENUM:
    case T_AT:
      return declaration();
    case T_IF:
      return ifStatement();
    case T_DO:
      return doStatement();
    case T_WHILE:
      return whileStatement();
    case T_FOR:
      return forStatement();
    case T_CONTINUE:
    case T_BREAK:
      return breakOrContinue();
    case T_RETURN:
      return returnStatement();
    case T_WITH:
      return withStatement();
    case T_SWITCH:
      return switchStatement();
    case T_THROW:
      return throwStatement();
    case T_TRY:
      return tryStatement();
    case T_DEBUGGER:
      lx.next();
      semicolon();
      return finishStmt(pushStmtDebugger(startPos), startFull, 0, 0);
    case T_CATCH:
    case T_FINALLY:
      if (p.recovers) return tryStatement();
      return expressionOrLabeledStatement();
    case T_ASYNC:
      // Nothing but `function` follows it in a declaration.
      if (p.isEcmascript && !nextIsFunctionOnSameLine()) return expressionOrLabeledStatement();
      if (isStartOfDeclaration()) return declaration();
      return expressionOrLabeledStatement();
    case T_INTERFACE:
    case T_TYPE:
    case T_MODULE:
    case T_NAMESPACE:
    case T_DECLARE:
    case T_EXPORT:
    case T_IMPORT:
    case T_ABSTRACT:
    case T_GLOBAL:
      if (isStartOfDeclaration()) return declaration();
      return expressionOrLabeledStatement();
    case T_PRIVATE:
    case T_PROTECTED:
    case T_PUBLIC:
    case T_ACCESSOR:
    case T_STATIC:
    case T_READONLY:
      if (isStartOfDeclaration()) return declaration();
      // `isStartOfStatement`: "they may be the start of a class member if an identifier immediately follows. Otherwise they're an
      // identifier in an expression statement." TODO(oxc): `&& !dialect.oxc`
      if (!p.isEcmascript && !p.recovers && isFollowedByWordOnSameLine()) {
        fail();
        return NONE;
      }
      return expressionOrLabeledStatement();
    default:
      return expressionOrLabeledStatement();
  }
}

/** `nextTokenIsBindingIdentifierOrStartOfDestructuring` */
function isLetDeclaration(): boolean {
  // TODO(oxc): `isEcmascript || dialect.oxc`
  const isEcmascript = p.isEcmascript;
  const m = lx.mark();
  const had = lx.refusal | 0;
  lx.next();
  const t = lx.token;
  let r = false;
  if (t === T_OPEN_BRACE || t === T_OPEN_BRACKET) r = true;
  // acorn's `isLet`
  else if ((t === T_IN || t === T_INSTANCE_OF) && isEcmascript) r = false;
  else if (isEcmascript) r = t >= T_IDENTIFIER;
  else r = isBindingIdentifier();
  lookAheadEnd(m, had);
  return r;
}

/**
 * `parseStatement` where a declaration cannot be: the body of an `if`, of a loop, of a `with` or of a label. For acorn and oxc `let` is
 * a name there, unless a `[` or a name with an escape follows.
 */
export function embeddedStatement(): number {
  // `let: let: ..` does not get to `statement`.
  if (!enterDepth()) return NONE;
  const r = embeddedStatementInDoor();
  leaveDepth();
  return r;
}

function embeddedStatementInDoor(): number {
  // TODO(oxc): `|| dialect.oxc`
  if (lx.token === T_LET && p.isEcmascript) {
    const m = lx.mark();
    const had = lx.refusal | 0;
    lx.next();
    const isDeclaration = lx.token === T_OPEN_BRACKET || (lx.token === T_IDENTIFIER && lx.hasEscape);
    lookAheadEnd(m, had);
    if (!isDeclaration) return expressionOrLabeledStatement();
  }
  const st = statement();
  // TODO(jsdoc): `if (readsJsdoc()) statementJsdoc(st)`
  if (st >= 0 && st < hir.nStmts) {
    switch (hir.stmtTag[st] | 0) {
      // The other parser takes these for statements of the file if no block is around them.
      case STMT_IMPORT:
      case STMT_EXPORT_NAMED:
      case STMT_EXPORT_STAR:
        hir.hasModuleSyntax = true;
        break;
      case STMT_VAR:
      case STMT_FN:
      case STMT_CLASS:
        hir.rareSyntax = hir.rareSyntax | RARE_DECLARATION_AS_BODY;
        // TODO(oxc): `if (reportsLikeOxc()) oxc::declaration_as_body(st)`
        break;
      // TODO(oxc): Interface | TypeAlias | Enum | Module: `oxc::declaration_as_body(st)`
      default:
        break;
    }
  }
  return st;
}

/** `nextTokenIsBindingIdentifierOrStartOfDestructuringOnSameLine`. Consumes tokens: call it in a lookahead. */
function nextIsBindingOnSameLine(disallowOf: boolean): boolean {
  lx.next();
  if (disallowOf && lx.token === T_OF) {
    const t = peek();
    return t === T_EQUALS || t === T_SEMICOLON || t === T_COLON;
  }
  return (isBindingIdentifier() || lx.token === T_OPEN_BRACE) && !lx.newlineBefore;
}

function isUsingDeclaration(): boolean {
  const m = lx.mark();
  const had = lx.refusal | 0;
  const r = nextIsBindingOnSameLine(false);
  lookAheadEnd(m, had);
  return r;
}

function isAwaitUsingDeclaration(): boolean {
  const m = lx.mark();
  const had = lx.refusal | 0;
  lx.next();
  // acorn and oxc ask for `using` on the line of `await`. TODO(oxc): `|| dialect.oxc`
  const r = lx.token === T_USING && !(lx.newlineBefore && p.isEcmascript) && nextIsBindingOnSameLine(false);
  lookAheadEnd(m, had);
  return r;
}

// `isDeclaration` leaves the start of the last token it looked at here.
let declarationLast = 0;

/** `isStartOfDeclaration` */
export function isStartOfDeclaration(): boolean {
  // The scan steps over one modifier at a time and remembers nothing, so it ends the same way from each of them. Without this
  // `declare declare ..` is scanned once from each word. The commonest, for which the text says what the scan would.
  if (lx.token === T_IMPORT && isBefore(" {")) return true;
  const from = lx.start | 0;
  const context = p.context & (CTX_YIELD | CTX_AWAIT);
  if (p.declarationScanContext === context && p.declarationScanFrom <= from && from <= p.declarationScanTo) {
    return p.declarationScanAnswer;
  }
  const m = lx.mark();
  const had = lx.refusal | 0;
  declarationLast = from;
  const answer = isDeclaration();
  const to = declarationLast;
  lookAheadEnd(m, had);
  if (to - from > 64) {
    p.declarationScanFrom = from;
    p.declarationScanTo = to;
    p.declarationScanContext = context;
    p.declarationScanAnswer = answer;
  }
  return answer;
}

/** `nextTokenIsIdentifierOnSameLine` */
function nextIsIdentifierOnSameLine(): boolean {
  lx.next();
  return isIdentifier() && !lx.newlineBefore;
}

/** `isDeclaration`. `declarationLast` is set to the start of the last token at which the loop was. */
function isDeclaration(): boolean {
  while (true) {
    declarationLast = lx.start | 0;
    switch (lx.token) {
      case T_VAR:
      case T_LET:
      case T_CONST:
      case T_FUNCTION:
      case T_CLASS:
      case T_ENUM:
        return true;
      case T_USING:
        return isUsingDeclarationHere();
      case T_AWAIT:
        return isAwaitUsingDeclarationHere();
      // TODO(oxc): `Interface | Type if dialect.oxc`
      case T_DEFER:
        if (p.recovers) return nextIsIdentifierOnSameLine();
        return false;
      case T_INTERFACE:
      case T_TYPE:
        return nextIsIdentifierOnSameLine();
      case T_MODULE:
      case T_NAMESPACE:
        lx.next();
        // oxc leaves the await context for the declaration.
        return !lx.newlineBefore && (isIdentifier() || lx.token === T_STRING);
      case T_ABSTRACT:
      case T_ACCESSOR:
      case T_ASYNC:
      case T_DECLARE:
      case T_PRIVATE:
      case T_PROTECTED:
      case T_PUBLIC:
      case T_READONLY: {
        const previous = lx.token;
        lx.next();
        // "ASI takes effect for this modifier."
        if (lx.newlineBefore) return false;
        // "If we see 'declare type', then commit to parsing a type alias."
        if (previous === T_DECLARE && lx.token === T_TYPE) return true;
        // TODO(oxc): `declare` is a name before `using`/`await`.
        // `declare module.exports: T`
        if (previous === T_DECLARE && lx.token === T_MODULE && p.isFlow) return true;
        break;
      }
      case T_GLOBAL: {
        lx.next();
        const t = lx.token;
        return !p.isEcmascript && (t === T_OPEN_BRACE || t === T_IDENTIFIER || t === T_EXPORT);
      }
      case T_IMPORT: {
        lx.next();
        const t = lx.token;
        return t === T_STRING || t === T_ASTERISK || t === T_OPEN_BRACE || t >= T_IDENTIFIER;
      }
      case T_EXPORT: {
        lx.next();
        let current = lx.token;
        if (current === T_TYPE) {
          // The native parser decides by the token after `type` alone.
          if (p.recovers) {
            lx.next();
            return lx.token === T_ASTERISK || lx.token === T_OPEN_BRACE || (isIdentifier() && !lx.newlineBefore);
          }
          current = peek();
        }
        if (current === T_EQUALS || current === T_ASTERISK || current === T_OPEN_BRACE || current === T_DEFAULT || current === T_AS || current === T_AT) {
          return true;
        }
        break;
      }
      case T_STATIC:
        lx.next();
        break;
      default:
        return p.isFlow && flowIsAtDeclarationWord();
    }
  }
}

// `is_using_declaration` / `is_await_using_declaration` called inside the lookahead of `isDeclaration`: they nest their own lookahead.
function isUsingDeclarationHere(): boolean {
  return isUsingDeclaration();
}
function isAwaitUsingDeclarationHere(): boolean {
  return isAwaitUsingDeclaration();
}

// ───────────────────────────── modifiers ─────────────────────────────

/** `isLiteralPropertyName` */
export function isLiteralPropertyName(): boolean {
  const t = lx.token;
  return t >= T_IDENTIFIER || t === T_STRING || t === T_NUMBER || t === T_BIG_INT;
}

/** `canFollowModifier` */
function canFollowModifier(): boolean {
  const t = lx.token;
  return (
    t === T_OPEN_BRACKET ||
    t === T_OPEN_BRACE ||
    t === T_ASTERISK ||
    t === T_DOT_DOT_DOT ||
    isLiteralPropertyName() ||
    ((t === T_PLUS || t === T_MINUS) && p.isFlow)
  );
}

/** `canFollowExportModifier` */
function canFollowExportModifier(): boolean {
  const t = lx.token;
  return t === T_AT || (!(t === T_ASTERISK || t === T_AS || t === T_OPEN_BRACE) && canFollowModifier());
}

/** `nextTokenCanFollowDefaultKeyword` */
function nextCanFollowDefaultKeyword(): boolean {
  lx.next();
  switch (lx.token) {
    case T_CLASS:
    case T_FUNCTION:
    case T_AT:
      return true;
    // For oxc the name is on the same line.
    case T_INTERFACE:
      // TODO(oxc): `!dialect.oxc || lookAhead(next; !newlineBefore)`
      return true;
    case T_ABSTRACT: {
      const m = lx.mark();
      const had = lx.refusal | 0;
      lx.next();
      const r = lx.token === T_CLASS && !lx.newlineBefore;
      lookAheadEnd(m, had);
      return r;
    }
    case T_ASYNC: {
      const m = lx.mark();
      const had = lx.refusal | 0;
      lx.next();
      const r = lx.token === T_FUNCTION && !lx.newlineBefore;
      lookAheadEnd(m, had);
      return r;
    }
    case T_ENUM:
      return p.isFlow;
    default:
      return p.isFlow && flowIsAtDeclarationWord();
  }
}

/** `nextTokenCanFollowModifier`. It leaves the parser after the modifier. */
function nextCanFollowModifier(): boolean {
  switch (lx.token) {
    // "'const' is only a modifier if followed by 'enum'."
    case T_CONST:
      lx.next();
      return lx.token === T_ENUM;
    case T_EXPORT: {
      lx.next();
      const t = lx.token;
      if (t === T_DEFAULT) {
        const m = lx.mark();
        const had = lx.refusal | 0;
        const r = nextCanFollowDefaultKeyword();
        lookAheadEnd(m, had);
        return r;
      }
      if (t === T_TYPE) {
        const m = lx.mark();
        const had = lx.refusal | 0;
        lx.next();
        const r = canFollowExportModifier();
        lookAheadEnd(m, had);
        return r;
      }
      return canFollowExportModifier();
    }
    // `nextTokenCanFollowDefaultKeyword` consumes `default` alone.
    case T_DEFAULT:
      return nextCanFollowDefaultKeyword();
    case T_STATIC:
    case T_GET:
    case T_SET:
      lx.next();
      return canFollowModifier();
    default:
      lx.next();
      return !lx.newlineBefore && canFollowModifier();
  }
}

/**
 * `parseModifiers`: pushes the modifiers at the token on the stack of modifiers (ids of `hir.modifiers` rows). Returns their flags.
 * The caller pops them from `base`, the length of the stack before (`takeModifiers`).
 */
export function modifiers(of: number): number {
  const allowDecorators = of === MODS_DECLARATION || of === MODS_CLASS_MEMBER;
  const permitConst = of === MODS_TYPE_PARAMETER || of === MODS_CLASS_MEMBER;
  const stopOnStaticBlock = of === MODS_CLASS_MEMBER;
  let flags = 0;
  // "[...leadingDecorators, ...leadingModifiers, ...trailingDecorators, ...trailingModifiers]"
  let hasTrailingDecorators = false;
  let hasTrailingModifiers = false;
  while (true) {
    const token = lx.token;
    if (token === T_AT) {
      if (!allowDecorators) {
        failUnlessRecovering();
        return flags;
      }
      if (hasTrailingModifiers) return flags;
      hasTrailingDecorators = flags !== 0;
      decorator();
      continue;
    }
    if (!isModifier(token)) return flags;
    if (token === T_CONST && !permitConst && lx.isConstBeforeBinding()) return flags;
    const pos = lx.start;
    const mark = lx.mark();
    let isMod = false;
    if (token === T_CONST && permitConst) {
      // "We need to ensure that any subsequent modifiers appear on the same line"
      lx.next();
      isMod = !lx.newlineBefore && canFollowModifier();
    } else if (token === T_STATIC && ((flags & FLAG_STATIC) !== 0 || (stopOnStaticBlock && peek() === T_OPEN_BRACE))) {
      lx.release(mark);
      return flags;
    } else {
      // TODO(oxc): `token === T_DEFAULT && of === MODS_CLASS_MEMBER && dialect.oxc`
      isMod = nextCanFollowModifier();
    }
    if (!isMod) {
      lx.reset(mark);
      return flags;
    }
    lx.release(mark);
    const flagBit = modifierFlag(token);
    // TODO(oxc): `oxc::modifier_after(..)`
    flags = flags | flagBit;
    hasTrailingModifiers = hasTrailingDecorators;
    s.modifiers.push(hir.pushModifier(MODK_KEYWORD, flagBit, pos));
  }
}

/** `tryParseDecorator`: pushes it on the stack of modifiers. */
function decorator(): void {
  // The expression can be a class with decorators.
  if (!enterDepth()) return;
  const pos = lx.start;
  expect(T_AT);
  const saved = enterContext(CTX_DECORATOR, 0);
  const e = decoratorExpression();
  p.context = saved;
  s.modifiers.push(hir.pushModifier(MODK_DECORATOR, e, pos));
  leaveDepth();
}

/** Pops the modifiers from `base` on and makes them a list of the file. Returns its start, the length is in `p.outLen`. */
export function takeModifiers(base: number): number {
  if (s.modifiers.len === base) {
    p.outLen = 0;
    return 0;
  }
  return takeList(s.modifiers, base);
}

// ───────────────────────────── declarations ─────────────────────────────

/** `parseDeclaration` */
function declaration(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  const base = s.modifiers.len;
  // acorn stops here, whatever is wrong further on.
  if (p.recovers && lx.isScript && (lx.token === T_IMPORT || lx.token === T_EXPORT)) errorAtToken(1128);
  // The common declarations have no modifier.
  let flags = 0;
  let isDecorated = false;
  const t = lx.token;
  if (
    t === T_VAR ||
    t === T_LET ||
    t === T_FUNCTION ||
    t === T_CLASS ||
    t === T_ENUM ||
    t === T_IMPORT ||
    t === T_INTERFACE ||
    t === T_TYPE ||
    (t === T_CONST && lx.isConstBeforeBinding())
  ) {
    // none
  } else {
    flags = modifiers(MODS_DECLARATION);
    // Or it has a keyword twice.
    const keywords = popCount(flags);
    isDecorated = s.modifiers.len - base > keywords;
  }
  // No other modifier is before a declaration.
  const isNoJavascript =
    p.isEcmascript &&
    ((flags & ~(FLAG_EXPORT | FLAG_DEFAULT | FLAG_ASYNC)) !== 0 || ((flags & FLAG_ASYNC) !== 0 && lx.token !== T_FUNCTION) || hasModifierTwice(base, flags));
  if (isNoJavascript) {
    // TODO(oxc): `oxc::declaration` says what oxc does.
    if (p.isFlow) flowDeclareBeforeExport(base, flags);
    else report();
  }
  const saved = p.context;
  // TODO(oxc): `leaveAwaitLikeOxc(flags)`
  if ((flags & FLAG_AMBIENT) !== 0) {
    if ((p.context & (CTX_TOP_LEVEL | CTX_IN_NAMESPACE)) !== CTX_TOP_LEVEL) hir.rareSyntax = hir.rareSyntax | RARE_NESTED_DECLARE;
    p.context = p.context | CTX_AMBIENT;
    // `parseClassDeclarationOrExpression`: no `await` in it has the statement reparsed.
    if (p.recovers && lx.token === T_CLASS && (flags & FLAG_EXPORT) === 0 && (p.context & CTX_TOP_LEVEL) !== 0) p.context = p.context & ~CTX_AWAIT;
  }
  const st = declarationWorker(startPos, startFull, base, flags);
  p.context = saved;
  void isDecorated;
  // TODO(oxc): `if ((isDecorated || isOdd) && isForOxc()) oxc::declaration(..)`
  if (p.isJavascript) checkJsStatement(st);
  return st;
}

/** Whether a keyword is more than once among the modifiers from `base` on, which have `flags`. */
function hasModifierTwice(base: number, flags: number): boolean {
  let keywords = 0;
  const ms = s.modifiers;
  for (let i = base; i < ms.len; i++) {
    if ((hir.modifierKind[ms.data[i] | 0] | 0) === MODK_KEYWORD) keywords = (keywords + 1) | 0;
  }
  return keywords !== popCount(flags);
}

/** `parseDeclarationWorker` */
function declarationWorker(startPos: number, startFull: number, base: number, flags: number): number {
  switch (lx.token) {
    case T_VAR:
    case T_LET:
    case T_CONST:
    case T_USING:
      return variableStatement(startPos, startFull, base, flags);
    case T_AWAIT:
      if (!p.recovers || isAwaitUsingDeclaration()) return variableStatement(startPos, startFull, base, flags);
      return missingDeclaration(startPos, startFull, base);
    case T_FUNCTION:
      if ((flags & FLAG_AMBIENT) !== 0 && p.isFlow) return flowDeclareFunction(startPos, startFull, base, flags);
      return functionDeclaration(startPos, startFull, base, flags);
    case T_CLASS:
      if ((flags & FLAG_AMBIENT) !== 0 && p.isFlow) return flowDeclareClass(startPos, startFull, base, flags);
      return classDeclaration(startPos, startFull, base, flags);
    case T_INTERFACE:
      if (p.isFlow) return flowInterface(startPos, startFull, base, flags);
      // TODO(oxc): `leaveAwaitLikeOxc(flags)`
      return interfaceDeclaration(startPos, startFull, base, flags);
    case T_TYPE:
      if (p.isFlow) return flowTypeAlias(startPos, startFull, base, flags);
      return typeAliasDeclaration(startPos, startFull, base, flags);
    case T_ENUM:
      if (p.isFlow) return flowEnum(startPos, startFull, base, flags);
      return enumDeclaration(startPos, startFull, base, flags);
    case T_GLOBAL:
      if (p.isEcmascript) {
        fail();
        return NONE;
      }
      return moduleDeclaration(startPos, startFull, base, flags);
    case T_MODULE:
    case T_NAMESPACE:
      if (lx.token === T_MODULE && p.isFlow && peek() === T_DOT) return flowDeclareModuleExports(startPos, startFull, base);
      return moduleDeclaration(startPos, startFull, base, flags);
    case T_IMPORT:
      return importDeclarationOrImportEquals(startPos, startFull, base, flags);
    case T_EXPORT: {
      const exportPos = lx.start | 0;
      lx.next();
      switch (lx.token) {
        case T_DEFAULT:
          if ((flags & FLAG_AMBIENT) !== 0 && p.isFlow) return flowDeclareExportDefaultType(startPos, startFull, base, exportPos);
          return exportAssignment(startPos, startFull, base);
        case T_EQUALS:
          return exportAssignment(startPos, startFull, base);
        case T_AS:
          return namespaceExportDeclaration(startPos, startFull, base);
        default:
          return exportDeclaration(startPos, startFull, base);
      }
    }
    default:
      if (p.isFlow) return flowDeclarationAtWord(startPos, startFull, base, flags);
      return missingDeclaration(startPos, startFull, base);
  }
}

/**
 * The end of `parseDeclarationWorker`: a `MissingDeclaration`, which is an empty statement. Its decorators are statements before it, in
 * the list that is being parsed. Without recovery it is an error.
 */
function missingDeclaration(startPos: number, startFull: number, base0: number): number {
  if (!p.recovers) {
    fail();
    return NONE;
  }
  const end = lx.fullStart | 0;
  error(1146, end, -1);
  const base = base0 < s.modifiers.len ? base0 : s.modifiers.len;
  for (let i = base; i < s.modifiers.len; i++) {
    const m = s.modifiers.data[i] | 0;
    if ((hir.modifierKind[m] | 0) === MODK_DECORATOR) s.ids.push(strayDecorator(hir.modifierValue[m] | 0, hir.modifierPos[m] | 0, end));
  }
  s.modifiers.len = base;
  return finishStmt(pushStmtEmpty(startPos), startFull, 0, 0);
}

/**
 * The statement that `expression` is: that of a decorator which decorates nothing, and which `checkDecorators` does not visit. `at`: its
 * `@`. `end`: the end of the decorators.
 */
function strayDecorator(expression: number, at: number, end: number): number {
  let start = at;
  let last = at;
  if (expression >= 0 && expression < hir.nExprs) {
    start = hir.exprPos[expression] | 0;
    last = hir.exprEnd[expression] | 0;
  }
  // The outermost parentheses are the last.
  for (let i = hir.nParens - 1; i >= 0; i--) {
    if ((hir.parenExpr[i] | 0) === expression) {
      start = hir.parenStart[i] | 0;
      last = hir.parenEnd[i] | 0;
      break;
    }
  }
  hir.pushStrayDecorators(start, end);
  const id = pushStmtExpr(start, expression);
  hir.stmtLocPos[id] = (at + 1) | 0;
  hir.stmtLocEnd[id] = last;
  return id;
}

/** `parseVariableStatement` */
function variableStatement(startPos: number, startFull: number, base: number, flags: number): number {
  const decls = variableDeclarationList(false, flags & FLAG_EXPORT);
  const declsLen = p.outLen | 0;
  semicolon();
  const modStart = takeModifiers(base);
  const modLen = p.outLen | 0;
  return finishStmt(pushStmtVar(startPos, decls, declsLen), startFull, modStart, modLen);
}

/** `parseVariableDeclarationList`. Returns the list start, the length is in `p.outLen`. */
export function variableDeclarationList(isInFor: boolean, flags0: number): number {
  let kind = VAR_VAR;
  switch (lx.token) {
    case T_VAR:
      kind = VAR_VAR;
      break;
    case T_LET:
      kind = VAR_LET;
      break;
    case T_CONST:
      kind = VAR_CONST;
      break;
    case T_USING:
      hir.rareSyntax = hir.rareSyntax | RARE_ODD_DECLARATION;
      // TODO(oxc): `checkExportedUsingLikeOxc(flags, pos)`
      kind = VAR_USING;
      break;
    default:
      noteAwait();
      p.suspensions = (p.suspensions + 1) | 0;
      hir.rareSyntax = hir.rareSyntax | RARE_AWAIT_USING | RARE_ODD_DECLARATION;
      // TODO(oxc): as for an `await` expression: `operand_of_await_outside_async`.
      lx.next();
      if (lx.token !== T_USING) fail();
      // TODO(oxc): `checkExportedUsingLikeOxc(flags, keyword)`
      kind = VAR_AWAIT_USING;
      break;
  }
  lx.next();
  // `for (let of X) { }`: the list is empty, and `of` is the keyword.
  if (p.recovers && lx.token === T_OF && isBeforeIdentifierAndCloseParen()) {
    hir.rareSyntax = hir.rareSyntax | RARE_ODD_DECLARATION;
    p.outLen = 0;
    return 0;
  }
  const flags = flags0 | ambient();
  const saved = isInFor ? enterContext(CTX_DISALLOW_IN, 0) : enterContext(0, CTX_DISALLOW_IN);
  // TODO(oxc): `declares = kind === VAR_VAR ? DECLARES_VAR : DECLARES_LEXICAL`
  const base = s.varDecls.len;
  const lists = enterList(LK_VARIABLE_DECLARATIONS);
  while (isAtElement(LK_VARIABLE_DECLARATIONS)) {
    // `isListElement`, `isListTerminator`: the list can be empty, and can end with a comma. The checker reports both.
    const t0 = lx.token;
    if (
      !isBindingIdentifier() &&
      !(t0 === T_OPEN_BRACKET || t0 === T_OPEN_BRACE || t0 === T_PRIVATE_IDENTIFIER) &&
      // TODO(oxc): `(!isEcmascript || dialect.oxc && varDecls.len > base)`
      !p.isEcmascript &&
      (canParseSemicolon() || t0 === T_IN || t0 === T_OF)
    ) {
      hir.rareSyntax = hir.rareSyntax | RARE_ODD_DECLARATION;
      break;
    }
    // `parseVariableDeclaration`
    const full = lx.fullStart;
    let pat = NONE;
    if (t0 === T_PRIVATE_IDENTIFIER) {
      pat = missingBindingIdentifier(18029);
    } else if ((t0 === T_OPEN_BRACKET || t0 === T_OPEN_BRACE) && isInFor && p.recovers) {
      // `parseArrayBindingPattern`, `parseObjectBindingPattern`: `in` is an operator.
      const savedIn = enterContext(0, CTX_DISALLOW_IN);
      pat = identifierOrPattern();
      p.context = savedIn;
    } else {
      pat = identifierOrPattern();
    }
    // TODO(oxc): `declarePattern(pat, declares)`
    let declFlags = flags;
    const isName = pat >= 0 && (hir.patTag[pat] | 0) === PAT_IDENT;
    if (!isInFor && lx.token === T_EXCLAMATION && !lx.newlineBefore && isName) {
      lx.next();
      declFlags = declFlags | FLAG_DEFINITE;
    }
    const ty = typeAnnotation();
    let init = NONE;
    if (lx.token === T_EQUALS) {
      init = initializer();
    } else {
      // TODO(oxc): `T_QUESTION && ty < 0 && reportsLikeOxc()`: reported, and the type annotation again.
      const token = lx.token;
      if (
        (declFlags & FLAG_AMBIENT) === 0 &&
        !(isInFor && (token === T_OF || token === T_IN)) &&
        (kind === VAR_CONST || !isName)
      ) {
        hir.rareSyntax = hir.rareSyntax | RARE_ODD_DECLARATION;
      }
      // TODO(oxc): `oxc::pattern_without_initializer(..)`
    }
    const decl = hir.pushVarDecl(pat, ty, init, kind, declFlags, full, lx.fullStart);
    // TODO(oxc): `oxc::variable(..)`
    s.varDecls.push(decl);
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_VARIABLE_DECLARATIONS, full)) break;
  }
  leaveList(lists);
  p.context = saved;
  const decls = takeList(s.varDecls, base);
  const len = p.outLen | 0;
  if (len !== 1 && (len === 0 || lx.token === T_OF || lx.token === T_IN)) hir.rareSyntax = hir.rareSyntax | RARE_ODD_DECLARATION;
  // TODO(jsdoc): `variableDeclarationsJsdoc(decls)`
  p.outLen = len;
  return decls;
}

/** `nextIsIdentifierAndCloseParen`, in a `lookAhead`. */
function isBeforeIdentifierAndCloseParen(): boolean {
  const m = lx.mark();
  const had = lx.refusal | 0;
  lx.next();
  let r = false;
  if (isIdentifier()) {
    lx.next();
    r = lx.token === T_CLOSE_PAREN;
  }
  lookAheadEnd(m, had);
  return r;
}

/** `parseInitializer`, at the `=`. */
export function initializer(): number {
  lx.next();
  return assignmentExpression();
}

/** `parseInitializer` */
export function optionalInitializer(): number {
  if (lx.token === T_EQUALS) return initializer();
  return NONE;
}

/** `parseEnumDeclaration` */
function enumDeclaration(startPos: number, startFull: number, base: number, flags: number): number {
  // TODO(oxc): `unexpectedLikeOxc` for `enum` in JavaScript, `checkTypeNameLikeOxc(Enum)`.
  lx.next();
  const name = isIdentifier() ? identifier() : missingName();
  const namePos = p.outPos | 0;
  // TODO(oxc): `declare(name, flags & CONST ? DECLARES_CONST_ENUM : DECLARES_ENUM)`
  const hasMembers = expect(T_OPEN_BRACE);
  // TODO(oxc): `openScope()`
  const saved = enterContext(0, p.clearedInTypes);
  const members = s.enumMembers.len;
  const lists = enterList(LK_ENUM_MEMBERS);
  while (hasMembers && isInList(T_CLOSE_BRACE) && isAtElement(LK_ENUM_MEMBERS)) {
    // `parseEnumMember`
    const memberPos = lx.start;
    const memberFull = lx.fullStart;
    // The checker reports a number, a computed name and so on.
    const isBigInt = lx.token === T_BIG_INT;
    const bigStart = lx.start;
    const bigEnd = lx.end;
    propertyName();
    let keyKind = p.keyKind | 0;
    let keyVal = p.keyVal | 0;
    let nameKind = p.nameKind | 0;
    // TODO(oxc): `oxc::enum_member_name(..)`
    if (isBigInt) {
      keyKind = PK_NAME;
      keyVal = names.atomOfSourceRange(bigStart, bigEnd);
    }
    let memberName = ATOM_NONE;
    let computedName = NONE;
    if (keyKind === PK_NAME || keyKind === PK_PRIVATE) {
      // TODO(oxc): `declare(name, DECLARES_ENUM_MEMBER)`
      memberName = keyVal;
    } else if (keyKind === PK_COMPUTED) {
      // `["a"]` is a name to oxc. TODO(oxc): `mayRedeclare()`
      nameKind = NK_IDENTIFIER;
      computedName = keyVal;
    }
    const saved2 = enterContext(0, CTX_DISALLOW_IN);
    const init = optionalInitializer();
    p.context = saved2;
    s.enumMembers.push(hir.pushEnumMember(memberName, nameKind, computedName, init, memberPos, memberFull, lx.fullStart));
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_ENUM_MEMBERS, memberFull)) break;
  }
  leaveList(lists);
  p.context = saved;
  // TODO(oxc): `closeScope()`
  if (hasMembers) expect(T_CLOSE_BRACE);
  // TODO(oxc): `oxc::enum_members(..)`
  const membersStart = takeList(s.enumMembers, members);
  const membersLen = p.outLen | 0;
  const declarationId = hir.pushEnum(name, namePos, ambient() | (flags & (FLAG_CONST | FLAG_EXPORT)), membersStart, membersLen, NONE);
  const modStart = takeModifiers(base);
  const modLen = p.outLen | 0;
  return finishStmt(pushStmtEnum(startPos, declarationId), startFull, modStart, modLen);
}

/** `parseModuleDeclaration` */
function moduleDeclaration(startPos: number, startFull: number, base: number, flags0: number): number {
  const flags = ambient() | (flags0 & FLAG_EXPORT);
  let nameKind = MODNAME_IDENT;
  let name = ATOM_NONE;
  let namePos = 0;
  if (lx.token === T_GLOBAL) {
    // `parseAmbientExternalModuleDeclaration`
    nameKind = MODNAME_GLOBAL;
    namePos = lx.start;
    // `parseIdentifier`
    nextAfterName();
  } else {
    const keyword = lx.token;
    lx.next();
    let isString = lx.token === T_STRING;
    // Only after `module` is a string a name.
    if (isString && keyword === T_NAMESPACE) {
      if (p.recovers) isString = false;
      else report();
    }
    if (!isString) {
      const modStart = takeModifiers(base);
      const modLen = p.outLen | 0;
      const ident = identifier();
      const identPos = p.outPos | 0;
      // TODO(oxc): `declare(ident, DECLARES_NAMESPACE)`
      return namespaceDeclaration(startPos, startFull, modStart, modLen, flags, keyword === T_MODULE, ident, identPos);
    }
    nameKind = MODNAME_STRING;
    name = lx.atom;
    namePos = lx.start;
    lx.next();
  }
  let bodyStart = 0;
  let bodyLen = 0;
  let hasBody = 0;
  if (lx.token === T_OPEN_BRACE) {
    bodyStart = moduleBlock();
    bodyLen = p.outLen | 0;
    hasBody = 1;
  } else {
    semicolon();
  }
  const mod = hir.pushModule(nameKind, name, namePos, flags, bodyStart, bodyLen, hasBody, 0, NONE);
  const modStart = takeModifiers(base);
  const modLen = p.outLen | 0;
  return finishStmt(pushStmtModule(startPos, mod), startFull, modStart, modLen);
}

/** `parseModuleOrNamespaceDeclaration`, after the name. */
function namespaceDeclaration(
  startPos: number,
  startFull: number,
  modStart: number,
  modLen: number,
  flags: number,
  specifiesModule: boolean,
  name: number,
  namePos: number,
): number {
  if (!enterDepth()) return NONE;
  let bodyStart = 0;
  let bodyLen = 0;
  if (lx.token === T_DOT) {
    lx.next();
    // The `b` of `namespace a.b` is exported from `a`, and starts with its name.
    const innerPos = lx.start;
    const innerFull = lx.fullStart;
    // `parseIdentifierName`, for the `b` of `namespace a.b`: with recovery any word.
    let nested: number;
    let nestedPos: number;
    if (p.recovers) {
      nested = identifierName();
      nestedPos = p.outPos | 0;
      noteIdentifier(nested, nestedPos);
    } else {
      nested = identifier();
      nestedPos = p.outPos | 0;
    }
    const innerFlags = (flags & FLAG_AMBIENT) | FLAG_EXPORT;
    const inner = namespaceDeclaration(innerPos, innerFull, 0, 0, innerFlags, specifiesModule, nested, nestedPos);
    if (p.isJavascript) checkJsStatement(inner);
    const b = s.ids.len;
    s.ids.push(inner);
    bodyStart = takeIds(b);
    bodyLen = p.outLen | 0;
  } else {
    bodyStart = moduleBlock();
    bodyLen = p.outLen | 0;
    // TODO(oxc): `oxc::namespace_body(..)`
  }
  const mod = hir.pushModule(MODNAME_IDENT, name, namePos, flags, bodyStart, bodyLen, 1, specifiesModule ? 1 : 0, NONE);
  const st = finishStmt(pushStmtModule(startPos, mod), startFull, modStart, modLen);
  leaveDepth();
  return st;
}

/** `parseModuleBlock`. Returns the list start, the length is in `p.outLen`. */
function moduleBlock(): number {
  if (!expect(T_OPEN_BRACE)) {
    p.outLen = 0;
    return 0;
  }
  // It stays in the context of the function around it. To oxc an `await` in an exported namespace is one of the top level.
  let saved = 0;
  if (hasContext(CTX_TOP_LEVEL)) {
    // TODO(oxc): `dialect.oxc && hasContext(CTX_AWAIT)`: `saved = p.context`
    saved = enterContext(0, CTX_TOP_LEVEL | p.clearedInTypes);
  } else {
    saved = p.context;
  }
  p.context = (p.context & ~(CTX_IN_LOOP | CTX_IN_SWITCH)) | CTX_IN_NAMESPACE;
  // TODO(oxc): `openScopeForVars()`
  const list = statementsUntilCloseBrace();
  const len = p.outLen | 0;
  // TODO(oxc): `closeScope()`
  p.context = saved;
  expect(T_CLOSE_BRACE);
  p.outLen = len;
  return list;
}

// ───────────────────────────── statements ─────────────────────────────

/**
 * `parseList(PCBlockStatements, parseStatement)`. It has no frame of its own: one is on the stack for each `{` that is open.
 * Returns the list start, the length is in `p.outLen`.
 */
export function statementsUntilCloseBrace(): number {
  const base = s.ids.len;
  // Only a statement of the file makes it a module.
  const wasModule = hir.hasModuleSyntax;
  const lists = enterList(LK_BLOCK_STATEMENTS);
  const strays = s.strayDecorators.len;
  while (isInList(T_CLOSE_BRACE) && isAtElement(LK_BLOCK_STATEMENTS)) {
    const st = statement();
    takeStrayDecorators(strays);
    // TODO(jsdoc): `statementJsdoc(st); listReparsed(..)`
    s.ids.push(st);
  }
  leaveList(lists);
  hir.hasModuleSyntax = wasModule;
  return takeIds(base);
}

/** `parseBlock` */
export function block(): number {
  // TODO(oxc): `openScope()` / `closeScope()`
  const startPos = lx.start;
  const startFull = lx.fullStart;
  if (!expect(T_OPEN_BRACE)) return finishStmt(pushStmtBlock(startPos, 0, 0), startFull, 0, 0);
  const list = statementsUntilCloseBrace();
  const len = p.outLen | 0;
  expectMatching(T_OPEN_BRACE, T_CLOSE_BRACE, startPos);
  if (lx.token === T_EQUALS) equalsAfterBlock();
  return finishStmt(pushStmtBlock(startPos, list, len), startFull, 0, 0);
}

/** The end of `parseBlock`, at a `=` after the `}`: it is reported and skipped. */
export function equalsAfterBlock(): void {
  if (p.recovers) {
    // TODO(recover): errorAtToken(2809); lx.next()
    errorAtToken(2809);
    lx.next();
  }
}

/** `(` expression `)` */
function parenthesizedCondition(): number {
  const open = lx.start;
  const opened = expect(T_OPEN_PAREN);
  const test = expressionAllowingIn();
  expectMatching(T_OPEN_PAREN, T_CLOSE_PAREN, opened ? open : -1);
  return test;
}

function ifStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  lx.next();
  const test = parenthesizedCondition();
  const yes = embeddedStatement();
  const no = eat(T_ELSE) ? embeddedStatement() : NONE;
  return finishStmt(pushStmtIf(startPos, test, yes, no), startFull, 0, 0);
}

function bodyOfLoop(): number {
  const saved = enterContext(CTX_IN_LOOP, 0);
  const body = embeddedStatement();
  p.context = saved;
  return body;
}

function doStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  lx.next();
  const body = bodyOfLoop();
  expect(T_WHILE);
  const test = parenthesizedCondition();
  // "do;while(0)x will have a semicolon inserted before x."
  eat(T_SEMICOLON);
  return finishStmt(pushStmtDoWhile(startPos, body, test), startFull, 0, 0);
}

function whileStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  lx.next();
  const test = parenthesizedCondition();
  const body = bodyOfLoop();
  return finishStmt(pushStmtWhile(startPos, test, body), startFull, 0, 0);
}

/** `parseWithStatement`: a block of the expression, as a statement, and the body. */
function withStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  lx.next();
  const open = lx.start;
  const opened = expect(T_OPEN_PAREN);
  const full = lx.fullStart;
  const object = expressionAllowingIn();
  // `add_stmt(Expr(object), start)` and then `loc.pos = full`.
  const objectStmt = finishStmt(pushStmtExpr(startPos, object), full, 0, 0);
  const close = lx.start;
  expectMatching(T_OPEN_PAREN, T_CLOSE_PAREN, opened ? open : -1);
  const body = embeddedStatement();
  const end = body >= 0 && body < hir.nStmts ? hir.stmtLocEnd[body] | 0 : 0;
  hir.pushWithBodies((close + 1) | 0, end);
  const b = s.ids.len;
  s.ids.push(objectStmt);
  s.ids.push(body);
  const list = takeIds(b);
  return finishStmt(pushStmtBlock(startPos, list, 2), startFull, 0, 0);
}

/** `parseForOrForInOrForOfStatement` */
function forStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  lx.next();
  const isAwait = lx.token === T_AWAIT;
  if (isAwait) {
    hir.rareSyntax = hir.rareSyntax | RARE_FOR_AWAIT;
    noteAwait();
    // TODO(oxc): it tells oxc nothing about whether the file is a module.
    lx.next();
  }
  expect(T_OPEN_PAREN);
  // TODO(oxc): `openScope()`
  let init = NONE;
  let startsWithLet = false;
  if (lx.token !== T_SEMICOLON) {
    const atPos = lx.start;
    const atFull = lx.fullStart;
    startsWithLet = lx.token === T_LET;
    let isDeclaration = false;
    switch (lx.token) {
      case T_LET:
        // TODO(oxc): `|| dialect.oxc`
        isDeclaration = p.isEcmascript ? isLetDeclaration() : true;
        break;
      case T_VAR:
      case T_CONST:
        isDeclaration = true;
        break;
      case T_USING: {
        const m = lx.mark();
        const had = lx.refusal | 0;
        isDeclaration = nextIsBindingOnSameLine(true);
        lookAheadEnd(m, had);
        break;
      }
      case T_AWAIT:
        isDeclaration = isAwaitUsingDeclaration();
        break;
      default:
        break;
    }
    if (isDeclaration) {
      const decls = variableDeclarationList(true, 0);
      init = finishStmt(pushStmtVar(atPos, decls, p.outLen | 0), atFull, 0, 0);
    } else {
      const saved = enterContext(CTX_DISALLOW_IN, 0);
      const e = expression();
      p.context = saved;
      init = finishStmt(pushStmtExpr(atPos, e), atFull, 0, 0);
    }
  }
  const t = lx.token;
  // Whatever the dialect: the checks for JavaScript and for oxfmt ask for the bit too.
  if ((t === T_OF || t === T_IN) && init >= 0 && (hir.stmtTag[init] | 0) === STMT_VAR) {
    const ls = hir.stmtA[init] | 0;
    const ln = hir.stmtB[init] | 0;
    for (let i = 0; i < ln; i++) {
      const d = hir.ids[(ls + i) | 0] | 0;
      if ((hir.varDeclInit[d] | 0) >= 0 || (hir.varDeclTy[d] | 0) >= 0) {
        hir.rareSyntax = hir.rareSyntax | RARE_ODD_LOOP_HEAD;
        break;
      }
    }
  }
  // TODO(oxc): `async_before_of`
  if ((t === T_OF || t === T_IN) && init >= 0 && (hir.stmtTag[init] | 0) === STMT_EXPR) noteTarget(hir.stmtA[init] | 0);
  if (t === T_OF && startsWithLet && init >= 0 && (hir.stmtTag[init] | 0) === STMT_EXPR) {
    // TODO(oxc): `oxc::let_before_of(..)`
    report();
  }
  // oxc reads the other loops after `for await` too. TODO(oxc): `isOtherLoop`
  let st = NONE;
  let isFor = false;
  if ((isAwait || lx.token === T_OF) && expect(T_OF)) {
    const saved = enterContext(0, CTX_DISALLOW_IN);
    const expr = assignmentExpression();
    p.context = saved;
    expect(T_CLOSE_PAREN);
    const body = bodyOfLoop();
    st = pushStmtForOf(startPos, init, expr, body, isAwait ? 1 : 0);
  } else if (eat(T_IN)) {
    const expr = expressionAllowingIn();
    expect(T_CLOSE_PAREN);
    const body = bodyOfLoop();
    st = pushStmtForIn(startPos, init, expr, body);
  } else {
    expect(T_SEMICOLON);
    const test = lx.token === T_SEMICOLON || lx.token === T_CLOSE_PAREN ? NONE : expressionAllowingIn();
    expect(T_SEMICOLON);
    const update = lx.token === T_CLOSE_PAREN ? NONE : expressionAllowingIn();
    expect(T_CLOSE_PAREN);
    const body = bodyOfLoop();
    st = pushStmtFor(startPos, init, test, update, body);
    isFor = true;
  }
  // TODO(oxc): `closeScope()`
  if (init < 0 && !isFor) failUnlessRecovering();
  return finishStmt(st, startFull, 0, 0);
}

function breakOrContinue(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  const isBreak = lx.token === T_BREAK;
  lx.next();
  let label = ATOM_NONE;
  if (canParseSemicolon()) {
    label = ATOM_NONE;
  } else if (!isIdentifier()) {
    label = missingIdentifier(0, 0);
  } else {
    // The reference notes the name at the start of the statement. TODO(oxc): at the label for oxc.
    label = lx.atom;
    noteIdentifier(label, startPos);
    nextAfterName();
  }
  const targets = isBreak ? CTX_IN_LOOP | CTX_IN_SWITCH : CTX_IN_LOOP;
  if (label >= 0 || !hasContext(targets)) hir.rareSyntax = hir.rareSyntax | RARE_ODD_JUMP;
  semicolon();
  const st = isBreak ? pushStmtBreak(startPos, label) : pushStmtContinue(startPos, label);
  return finishStmt(st, startFull, 0, 0);
}

function returnStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  lx.next();
  const value = canParseSemicolon() ? NONE : expressionAllowingIn();
  semicolon();
  return finishStmt(pushStmtReturn(startPos, value), startFull, 0, 0);
}

function throwStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  lx.next();
  let value = NONE;
  if (lx.newlineBefore) {
    // TODO(oxc): oxc reports the line break and goes on with the expression.
    if (!p.isEcmascript) {
      // The checker reports the line break.
      const end = lx.fullStart | 0;
      value = pushExprMissing(end, end);
    } else {
      fail();
    }
  } else {
    value = expressionAllowingIn();
  }
  if (!eat(T_SEMICOLON) && !canParseSemicolon()) {
    if (p.recovers) missingSemicolonAfter(value);
    else fail();
  }
  return finishStmt(pushStmtThrow(startPos, value), startFull, 0, 0);
}

function switchStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  lx.next();
  expect(T_OPEN_PAREN);
  const expr = expressionAllowingIn();
  expect(T_CLOSE_PAREN);
  expect(T_OPEN_BRACE);
  // TODO(oxc): `openScope()`
  const saved = enterContext(CTX_IN_SWITCH, 0);
  const base = s.cases.len;
  let defaults = 0;
  const lists = enterList(LK_SWITCH_CLAUSES);
  while (isInList(T_CLOSE_BRACE) && isAtElement(LK_SWITCH_CLAUSES)) {
    const pos = lx.start;
    let test = NONE;
    if (lx.token === T_CASE) {
      lx.next();
      test = expressionAllowingIn();
    } else if (lx.token === T_DEFAULT) {
      defaults = (defaults + 1) | 0;
      lx.next();
    } else {
      fail();
      break;
    }
    expect(T_COLON);
    // `checkSwitchStatement` reports the second one, up to its `:`.
    if (defaults === 2 && test < 0) {
      defaults = (defaults + 1) | 0;
      flag(DK_GRAMMAR, 1113, pos, lx.fullStart);
    }
    const ids = s.ids.len;
    // TODO(jsdoc): `const reparsed = ..`
    const lists2 = enterList(LK_SWITCH_CLAUSE_STATEMENTS);
    while (!(lx.token === T_CASE || lx.token === T_DEFAULT || lx.token === T_CLOSE_BRACE || lx.token === T_EOF) && isAtElement(LK_SWITCH_CLAUSE_STATEMENTS)) {
      const st = statement();
      // TODO(jsdoc): `statementJsdoc(st); listReparsedOfClause(..)`
      s.ids.push(st);
    }
    leaveList(lists2);
    const body = takeIds(ids);
    const bodyLen = p.outLen | 0;
    // TODO(jsdoc): `clauseJsdoc(pos)`
    s.cases.push(hir.pushCase(test, body, bodyLen, pos, lx.fullStart));
  }
  leaveList(lists);
  p.context = saved;
  // TODO(oxc): `closeScope()`
  expect(T_CLOSE_BRACE);
  const cases = takeList(s.cases, base);
  return finishStmt(pushStmtSwitch(startPos, expr, cases, p.outLen | 0), startFull, 0, 0);
}

function tryStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  expect(T_TRY);
  const blk = block();
  let param = NONE;
  let handler = NONE;
  let finalizer = NONE;
  if (eat(T_CATCH)) {
    // TODO(oxc): `openScope()`
    if (eat(T_OPEN_PAREN)) {
      // `parseVariableDeclaration`
      const full = lx.fullStart;
      const pat = identifierOrPattern();
      // TODO(oxc): `declarePattern(pat, isName ? DECLARES_PARAMETER : DECLARES_LEXICAL)`
      const ty = typeAnnotation();
      // `checkCatchClause` reports it.
      let init = NONE;
      if (lx.token === T_EQUALS) {
        if (p.recovers) {
          init = initializer();
        } else {
          refuse(R_REPORTED);
        }
      }
      param = hir.pushVarDecl(pat, ty, init, VAR_LET, 0, full, lx.fullStart);
      // TODO(jsdoc): `variableDeclarationJsdoc(param)`
      expect(T_CLOSE_PAREN);
    }
    // The block of a `catch` is one scope with the parameter.
    handler = block();
    // TODO(oxc): `closeScope()`
  }
  if (lx.token === T_FINALLY || handler < 0) {
    // The block starts at the keyword.
    const keywordPos = lx.start;
    if (!eat(T_FINALLY)) errorAtToken(1472);
    finalizer = block();
    if (finalizer >= 0 && finalizer < hir.nStmts) hir.stmtStart[finalizer] = keywordPos;
  }
  return finishStmt(pushStmtTry(startPos, blk, param, handler, finalizer), startFull, 0, 0);
}

/** `parseExpressionOrLabeledStatement` */
function expressionOrLabeledStatement(): number {
  const startPos = lx.start;
  const startFull = lx.fullStart;
  if (p.isFlow) p.flowStatementStart = startPos;
  // TypeScript 5 has `allowInAnd(parseExpression)` here, the native parser has not.
  const e = p.isTypescript5 || p.isEcmascript ? expressionAllowingIn() : expression();
  if (
    lx.token === T_COLON &&
    e >= 0 &&
    e + 1 === hir.nExprs &&
    (hir.exprTag[e] | 0) === EXPR_IDENT &&
    (hir.exprPos[e] | 0) === startPos
  ) {
    const label = hir.exprA[e] | 0;
    hir.nExprs = e;
    lx.next();
    const body = embeddedStatement();
    hir.rareSyntax = hir.rareSyntax | RARE_ODD_JUMP;
    return finishStmt(pushStmtLabeled(startPos, label, body), startFull, 0, 0);
  }
  // `parseSemicolon`
  if (lx.token === T_SEMICOLON) {
    lx.next();
  } else if (!canParseSemicolon()) {
    return statementWithoutSemicolon(startPos, startFull, e);
  }
  return finishStmt(pushStmtExpr(startPos, e), startFull, 0, 0);
}

/** The token cannot follow the expression statement `e`. */
function statementWithoutSemicolon(startPos: number, startFull: number, e: number): number {
  if (p.isFlow) return flowDeclarationAfterExpression(startPos, startFull, e);
  // `parseErrorForMissingSemicolonAfter`: "If a declared node failed to parse, it would have emitted a diagnostic already."
  if (!p.isEcmascript && e >= 0 && (hir.exprTag[e] | 0) === EXPR_IDENT && names.atomIs(hir.exprA[e] | 0, "declare") && !isParenthesized(e)) {
    return finishStmt(pushStmtExpr(startPos, e), startFull, 0, 0);
  }
  if (p.recovers) {
    missingSemicolonAfter(e);
    return finishStmt(pushStmtExpr(startPos, e), startFull, 0, 0);
  }
  fail();
  return NONE;
}
