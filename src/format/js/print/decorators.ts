// Port of vendor/bun/src/format/js/print/decorators.rs.
// FormatDecorators::new(decorators, parent): the decorators are the modifiers `(modsStart, modsLen)` that are decorators.
import { Formatter } from "../../ir/formatter.ts";
import { AT, LPAREN, RPAREN } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  SP,
  exprCallee,
  exprObject,
  listAt,
  memberModifiersLen,
  memberModifiersStart,
  modifierDecorator,
  paramModifiersLen,
  paramModifiersStart,
} from "../../../lint/ast/index.ts";
import {
  AN_ACCESSOR_PROPERTY,
  AN_CALL_EXPRESSION,
  AN_DECORATOR,
  AN_EXPORT_DEFAULT_DECLARATION,
  AN_EXPORT_NAMED_DECLARATION,
  AN_FORMAL_PARAMETER,
  AN_FORMAL_PARAMETER_REST,
  AN_IDENTIFIER_REFERENCE,
  AN_METHOD_DEFINITION,
  AN_PROPERTY_DEFINITION,
  AN_STATIC_MEMBER_EXPRESSION,
  anSpan,
  anEnd,
  anTag,
  exprAsAstNodes,
  memberAsAstNodes,
  mkAn,
  paramAsAstNodes,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { JOIN_SOFT_LINE, joinNodesSeparator } from "../builders.ts";
import { PK_NODE, enterScope, fmtExpr, leaveScope, writeTrailingCommentsIn } from "../format.ts";
import { formatLeadingComments } from "../trivia.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";

/** Whether one of them is followed by a line break in the source. */
function shouldExpand(modsStart: number, modsLen: number, f: Formatter): boolean {
  const src = cxOf(f).src;
  for (let i = 0; i < modsLen; i++) {
    const d = modifierDecorator(listAt(modsStart, i));
    if (d < 0) continue;
    if (src.hasLineTerminatorAfter(anEnd(mkAn(AN_DECORATOR, d)))) return true;
  }
  return false;
}

/** Of a member of a class. Prettier does not. */
function keepsEmptyLinesBetweenDecorators(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * The decorators of a class, a member or a parameter, and the space or the line break after them. `parent`: what has them (an `AstNodes`).
 * For a class whose decorators are written before `export`, the `ExportNamedDeclaration` or the `ExportDefaultDeclaration`.
 */
export function fmtDecorators(modsStart: number, modsLen: number, parent: number, f: Formatter): void {
  let count = 0;
  for (let i = 0; i < modsLen; i++) {
    if (modifierDecorator(listAt(modsStart, i)) >= 0) count = (count + 1) | 0;
  }
  if (count === 0) return;
  const SP$ = SP;
  switch (anTag(parent)) {
    case AN_PROPERTY_DEFINITION:
    case AN_METHOD_DEFINITION:
    case AN_ACCESSOR_PROPERTY: {
      f.startGroupExpand(shouldExpand(modsStart, modsLen, f));
      const keeps = keepsEmptyLinesBetweenDecorators(f);
      let has = false;
      for (let i = 0; i < modsLen; i++) {
        const d = modifierDecorator(listAt(modsStart, i));
        if (d < 0) continue;
        if (has) {
          if (keeps) {
            anSpan(mkAn(AN_DECORATOR, d));
            joinNodesSeparator(f, JOIN_SOFT_LINE, SP$.s0 | 0, SP$.s1 | 0);
          } else f.softLineBreakOrSpace();
        }
        has = true;
        fmtDecorator(d, f);
      }
      f.softLineBreakOrSpace();
      f.endGroup();
      return;
    }
    case AN_FORMAL_PARAMETER:
    case AN_FORMAL_PARAMETER_REST:
      if (shouldExpand(modsStart, modsLen, f)) f.expandParent();
      break;
    case AN_EXPORT_NAMED_DECLARATION:
    case AN_EXPORT_DEFAULT_DECLARATION:
      f.hardLineBreak();
      break;
    default:
      f.expandParent();
      break;
  }
  let has = false;
  for (let i = 0; i < modsLen; i++) {
    const d = modifierDecorator(listAt(modsStart, i));
    if (d < 0) continue;
    if (has) f.softLineBreakOrSpace();
    has = true;
    fmtDecorator(d, f);
  }
  f.softLineBreakOrSpace();
}

export function fmtDecoratorsOfParam(param: number, f: Formatter): void {
  fmtDecorators(paramModifiersStart(param), paramModifiersLen(param), paramAsAstNodes(param), f);
}

export function fmtDecoratorsOfMember(member: number, f: Formatter): void {
  fmtDecorators(memberModifiersStart(member), memberModifiersLen(member), memberAsAstNodes(member), f);
}

/** `a`, `a.b.c` */
function isIdentifierOrStaticMemberOnly(callee: number): boolean {
  let e = callee;
  while (true) {
    const an = exprAsAstNodes(e);
    const t = anTag(an);
    if (t === AN_IDENTIFIER_REFERENCE) return true;
    if (t !== AN_STATIC_MEMBER_EXPRESSION) return false;
    e = exprObject(e);
    if (e < 0) return false;
  }
}

/** The `@e` around `e`. */
export function fmtDecorator(expression: number, f: Formatter): void {
  const cx = cxOf(f);
  const node = mkAn(AN_DECORATOR, expression);
  anSpan(node);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  // format_node(span, || node.parent(), f, |f| { .. })
  if (cx.isQuiet) {
    writeDecoratorBody(expression, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    writeDecoratorBody(expression, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_NODE, node, f);
}

function writeDecoratorBody(expression: number, f: Formatter): void {
  // `@a`, `@a.b`, `@a.b()` are written as they are. Anything else is in parentheses.
  let needsParentheses = true;
  const an = exprAsAstNodes(expression);
  switch (anTag(an)) {
    case AN_IDENTIFIER_REFERENCE:
      needsParentheses = false;
      break;
    case AN_CALL_EXPRESSION: {
      const callee = exprCallee(expression);
      needsParentheses = !(callee >= 0 && isIdentifierOrStaticMemberOnly(callee));
      break;
    }
    case AN_STATIC_MEMBER_EXPRESSION: {
      const object = exprObject(expression);
      needsParentheses = !(object >= 0 && isIdentifierOrStaticMemberOnly(object));
      break;
    }
    default:
      break;
  }
  f.token(AT);
  if (needsParentheses) f.token(LPAREN);
  fmtExpr(expression, f);
  if (needsParentheses) f.token(RPAREN);
}
