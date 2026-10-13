// Port of vendor/bun/src/format/js/utils/format_node_without_trailing_comments.rs.
import { Formatter } from "../../ir/formatter.ts";
import { SP } from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import { nodeSpanOf, writeNode } from "../format.ts";
import { formatLeadingComments } from "../trivia.ts";
import { writeSuppressedNode } from "./suppressed.ts";

/**
 * `FormatNodeWithoutTrailingComments(&x)`: writes a node and leaves the comments after it to the caller. `(wk, h)`: the node, see
 * `WK_*` in format.ts.
 */
export function fmtNodeWithoutTrailingComments(wk: number, h: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    writeNode(wk, h, f);
    return;
  }
  nodeSpanOf(wk, h);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const cm = cx.comments;
  if (cm.hasTrailingSuppressionComment(end)) {
    formatLeadingComments(start, end, f);
    writeSuppressedNode(start, end, f);
    return;
  }
  // The comments after the node are hidden while it is written.
  const previousLimit = cm.limitCommentsUpTo(end);
  writeNode(wk, h, f);
  cm.restoreViewLimit(previousLimit);
}
