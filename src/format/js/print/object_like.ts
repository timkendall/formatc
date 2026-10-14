// Port of vendor/bun/src/format/js/print/object_like.rs: `{ .. }`: an object literal or a type literal.
//
// Rust's `ObjectLike::ObjectExpression(e, props)` / `ObjectLike::TSTypeLiteral(ty, members)` are `writeObjectLikeExpression(e, propsStart, propsLen, f)` /
// `writeObjectLikeTsTypeLiteral(ty, membersStart, membersLen, f)`; `ObjectLike::TSTypeLiteral(ty, _).should_hug(f)` is `objectLikeTsTypeLiteralShouldHug(ty, f)`.
import { Formatter } from "../../ir/formatter.ts";
import { COMMA, LBRACE, RBRACE } from "../../ir/tokens.ts";
import { EXPAND_AUTO, FLAVOR_OXFMT, FTC_ES5, trailingSeparator } from "../../options.ts";
import { SP, exprSpan, listAt, memberSpan, paramDefault, paramFuncOf, propSpan, typeSpan } from "../../../lint/ast/index.ts";
import {
  AN_FORMAL_PARAMETER,
  AN_FUNCTION,
  AN_TS_THIS_PARAMETER,
  AN_TS_TYPE_ANNOTATION,
  anId,
  anParent,
  anTag,
  funcAsAstNodes,
  typeAstParent,
} from "../ast_nodes.ts";
import { JOIN_SOFT_LINE, joinNodesSeparator, writeSeparatorAfter } from "../builders.ts";
import { cxOf } from "../context.ts";
import { shouldHugFunctionParameters } from "./parameters.ts";
import { fmtObjectMember } from "./expressions.ts";
import { writeTsSignatures } from "./ts_types.ts";
import { DANGLING_NONE, DANGLING_SOFT, formatDanglingComments } from "../trivia.ts";

/** `ObjectLike::TSTypeLiteral(ty, _).should_hug(f)`: it is the type of the only parameter of a function: `const fn = ({ foo }: { foo: string }) => {}`. */
export function objectLikeTsTypeLiteralShouldHug(ty: number, f: Formatter): boolean {
  const annotation = typeAstParent(ty);
  if (anTag(annotation) !== AN_TS_TYPE_ANNOTATION) return false;
  const parent = anParent(annotation);
  const t = anTag(parent);
  if (t === AN_FORMAL_PARAMETER) {
    const param = anId(parent);
    if (paramDefault(param) >= 0) return false;
    const func = paramFuncOf(param);
    return func >= 0 && shouldHugFunctionParameters(func, false, f);
  }
  if (t === AN_TS_THIS_PARAMETER) {
    const func = paramFuncOf(anId(parent));
    return func >= 0 && anTag(funcAsAstNodes(func)) === AN_FUNCTION && shouldHugFunctionParameters(func, false, f);
  }
  return false;
}

/**
 * `({⏎ a⏎}: {⏎ /* comment *&#47;⏎}) => {}`: for Prettier a type with nothing but block comments in it is no group of its own where it is hugged.
 * `ty`: -1 for an object literal.
 */
function breaksWithPattern(ty: number, spanEnd: number, f: Formatter): boolean {
  const cx = cxOf(f);
  if (f.options.flavor === FLAVOR_OXFMT || cx.isQuiet) return false;
  const cm = cx.comments;
  const n = cm.commentsBeforeEndOf(spanEnd);
  if (n === 0) return false;
  const from = cm.from;
  for (let i = 0; i < n; i++) if (cm.isLine((from + i) | 0)) return false;
  return ty >= 0 && objectLikeTsTypeLiteralShouldHug(ty, f);
}

/** `kind`: 0 an object literal (`h`: the Expr; the list is its properties), 1 a type literal (`h`: the TypeNode; the list is its members). */
function writeObjectLike(kind: number, h: number, listStart: number, listLen: number, f: Formatter): void {
  if (kind === 0) exprSpan(h);
  else typeSpan(h);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  f.token(LBRACE);
  if (listLen > 0) {
    const first = listAt(listStart, 0);
    if (kind === 0) propSpan(first);
    else memberSpan(first);
    const firstMemberStart = SP$.s0 | 0;
    // An object that has a line break after its `{` in the source stays broken.
    const src = cxOf(f).src;
    const shouldExpand =
      f.options.expand === EXPAND_AUTO &&
      (f.options.flavor === FLAVOR_OXFMT ? src.containsNewline(start, firstMemberStart) : src.hasNewlineInRange(start, firstMemberStart));
    const hug = kind === 1 && objectLikeTsTypeLiteralShouldHug(h, f);
    if (!hug) f.startGroupExpand(shouldExpand);
    f.startSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
    if (kind === 0) {
      const separator = trailingSeparator(FTC_ES5, f.options);
      for (let i = 0; i < listLen; i++) {
        const p = listAt(listStart, i);
        if (i > 0) {
          propSpan(p);
          joinNodesSeparator(f, JOIN_SOFT_LINE, SP$.s0 | 0, SP$.s1 | 0);
        }
        fmtObjectMember(p, f);
        writeSeparatorAfter(f, COMMA, i === listLen - 1, separator, 0);
      }
    } else {
      writeTsSignatures(listStart, listLen, f);
    }
    f.endSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
    if (!hug) f.endGroup();
  } else if (breaksWithPattern(kind === 1 ? h : -1, end, f)) {
    f.startSoftBlockIndent();
    formatDanglingComments(start, end, DANGLING_NONE, f);
    f.endSoftBlockIndent();
  } else {
    formatDanglingComments(start, end, DANGLING_SOFT, f);
  }
  f.token(RBRACE);
}

/** `ObjectLike::ObjectExpression(e, props).fmt(f)` */
export function writeObjectLikeExpression(e: number, propsStart: number, propsLen: number, f: Formatter): void {
  writeObjectLike(0, e, propsStart, propsLen, f);
}

/** `ObjectLike::TSTypeLiteral(ty, members).fmt(f)` */
export function writeObjectLikeTsTypeLiteral(ty: number, membersStart: number, membersLen: number, f: Formatter): void {
  writeObjectLike(1, ty, membersStart, membersLen, f);
}
