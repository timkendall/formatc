// Port of vendor/bun/src/format/js/utils/member_chain/groups.rs.
import { Formatter } from "../../../ir/formatter.ts";
import { I32Vec } from "../../../../base/i32vec.ts";
import { SP, exprEnd, exprSpan, hir, skipTrivia } from "../../../../lint/ast/index.ts";
import { cxOf } from "../../context.ts";
import { isNextLineEmpty } from "../../print/program.ts";
import { CM_CALL_MIDDLE, cmExpr, cmKind, fmtChainMember } from "./chain_member.ts";

/** Prettier's `shouldInsertEmptyLineAfter`: whether the line after `e`, or after the `)` behind it, is empty. */
export function shouldInsertEmptyLineAfter(e: number, f: Formatter): boolean {
  const end = exprEnd(e);
  const src = cxOf(f).src;
  const hir$ = hir;
  const next = skipTrivia(hir$.text, hir$.sourceLen | 0, end);
  if (next < (hir$.sourceLen | 0) && src.byteAt(next) === 41) return isNextLineEmpty(src, next + 1);
  return isNextLineEmpty(src, end);
}

/** The links `members[start .. end)` of a group (`members` is read at `base`). */
export function fmtMemberChainGroup(members: I32Vec, base: number, start: number, end: number, f: Formatter): void {
  for (let i = start; i < end; i++) {
    const m = members.data[(base + i) | 0] | 0;
    fmtChainMember(m, f);
    // Prettier writes a line break after a call that an empty line follows, which makes an empty line at the end of a group. It is there
    // in the middle of a group as well.
    if (cmKind(m) === CM_CALL_MIDDLE && i + 1 < end && shouldInsertEmptyLineAfter(cmExpr(m), f)) f.hardLineBreak();
  }
}
