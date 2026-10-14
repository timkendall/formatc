// Port of vendor/bun/src/format/js/sort_imports/oxfmt/run.rs: sorting a run of imports while it is written.
//
// Whoever writes a list of statements (`fmtStatements` of print/program.ts) tells the run what it is about to write:
//
//     const imports = importRunBegin(f);                                  // let mut imports = ImportRun::new(f);
//     ...
//     if (imports) importRunBeforeStatement(statement, f);                // imports.before_statement(statement, f)  (before the comments before it)
//     if (imports) importRunBeforeSeparator(next, isPlain, f);            // imports.before_separator(next, is_plain, f)  (before the line break between two statements)
//     if (imports) importRunFinish(f);                                    // imports.finish(f)  (after the last statement)
//
// There is one run per thread: a list of statements inside a statement that is no import begins its own, and by then the one of the
// list around it has nothing open (a run is open only while imports are written, and an import has no statements in it).
import { Formatter } from "../../../ir/formatter.ts";
import { E_LINE, E_SKIP, LM_EMPTY, LM_HARD } from "../../../ir/element.ts";
import {
  SP,
  STMT_IMPORT,
  importClauseSpan,
  importDefault,
  importIsSideEffect,
  importNamespaceSpan,
  importSpecSpanOf,
  stmtImportImport,
  stmtSpan,
  stmtTag,
} from "../../../../lint/ast/index.ts";
import { cxOf } from "../../context.ts";
import { formatLeadingCommentsRange } from "../../trivia.ts";
import { sortImportsOf, HOW_NATIVE, HOW_OXFMT } from "../how.ts";
import { containsAscii, isBlankBefore, trimAsciiEnd, bytesString } from "../util.ts";
import { OxfmtOptions } from "./options.ts";
import { LINE_COMMENT, LINE_EMPTY, LINE_IMPORT, Line, OP_EMPTY, OP_HARD, Written, plan, state, transform } from "./sorter.ts";

/** `ImportRun::new`: whether imports are sorted this way, and nothing here does anything if not. */
export function importRunBegin(f: Formatter): boolean {
  const handle = f.options.sortImports;
  const state$ = state;
  if (handle < 0) {
    state$.options = null;
    return false;
  }
  const how = sortImportsOf(handle);
  if (how !== null && (how.how === HOW_OXFMT || how.how === HOW_NATIVE) && how.oxfmt !== null) {
    state$.options = how.oxfmt;
    state$.slot = -1;
    state$.isNextSortable = -1;
    state$.lines = [];
    state$.imports = [];
    state$.lineStart = 0;
    return true;
  }
  state$.options = null;
  return false;
}

/** An import that is written as it is in the source ends a run. */
function isSortable(statement: number, f: Formatter): boolean {
  if (stmtTag(statement) !== STMT_IMPORT) return false;
  stmtSpan(statement);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const cm = cxOf(f).comments;
  return !cm.isSuppressed(start) && !cm.hasTrailingSuppressionComment(end);
}

/**
 * To be called before the line break between the previous statement and `next` is written. `isPlain`: all comments between the two are
 * written with `next`.
 */
export function importRunBeforeSeparator(next: number, isPlain: boolean, f: Formatter): void {
  if (state.options === null) return;
  endStatement(isPlain ? next : -1, f);
}

/** To be called before `statement` and the comments before it are written. */
export function importRunBeforeStatement(statement: number, f: Formatter): void {
  if (state.options === null) return;
  startStatement(statement, f);
}

/** To be called after the last statement. */
export function importRunFinish(f: Formatter): void {
  if (state.options === null) return;
  endStatement(-1, f);
}

function endStatement(next: number, f: Formatter): void {
  const isNextSortable = next >= 0 && isSortable(next, f);
  const state$ = state;
  state$.isNextSortable = isNextSortable ? 1 : 0;
  const slot = state$.slot;
  if (slot < 0) return;
  state$.lines.push(new Line(LINE_IMPORT, state$.lineStart, f.len() > state$.lineStart ? f.len() : state$.lineStart, state$.imports.length > 0 ? state$.imports.length - 1 : 0));
  if (isNextSortable) return;
  state$.slot = -1;
  const run = f.endCapture(slot);
  const options = state$.options as OxfmtOptions;
  const plan$ = plan;
  if (state$.imports.length >= 2) {
    plan$.ops.len = 0;
    transform(state$.lines, state$.imports, options, plan$);
    const ops = plan$.ops;
    for (let i = 0; i < ops.len; i = i + 3) {
      const kind = ops.data[i] | 0;
      if (kind === OP_HARD) f.hardLineBreak();
      else if (kind === OP_EMPTY) f.emptyLine();
      else copyRange(ops.data[i + 1] | 0, ops.data[i + 2] | 0, f);
    }
  } else {
    f.writeInterned(run);
  }
  state$.lines = [];
  state$.imports = [];
}

/** Writes a copy of the elements `[start, end)` of the pool: what is written there, but for the content of captures, which stays where it is. */
function copyRange(start: number, end: number, f: Formatter): void {
  const st = f.st;
  let i = start;
  while (i < end) {
    const t = st.tag[i] | 0;
    if (t === E_SKIP) {
      i = i + 1 + (st.a[i] | 0);
      continue;
    }
    f.copyElement(i);
    i = i + 1;
  }
}

function startStatement(statement: number, f: Formatter): void {
  let sortable = false;
  const state$ = state;
  if (state$.isNextSortable >= 0) {
    sortable = state$.isNextSortable === 1;
    state$.isNextSortable = -1;
  } else {
    sortable = isSortable(statement, f);
  }
  if (!sortable) return;
  const imp = stmtImportImport(statement);
  const st = f.st;
  if (state$.slot < 0) {
    state$.slot = f.startCapture();
  } else {
    const last = f.len() - 1;
    if (last >= 0 && (st.tag[last] | 0) === E_LINE && (st.a[last] | 0) === LM_EMPTY) state$.lines.push(new Line(LINE_EMPTY, 0, 0, 0));
  }
  state$.imports.push(newWritten(statement, imp, f));
  state$.lineStart = f.len();

  // One line at a time. What is left for the statement to write is its own line.
  const cx = cxOf(f);
  const cm = cx.comments;
  stmtSpan(statement);
  const statementStart = SP[0] | 0;
  cm.commentsBefore(statementStart);
  let i = cm.from;
  const to = cm.to;
  const text = cx.src.text;
  while (i < to) {
    // Comments without anything between them belong together.
    let end = cm.spanEnd[i] | 0;
    let count = 1;
    while (i + count < to && end === (cm.spanStart[i + count] | 0)) {
      end = cm.spanEnd[i + count] | 0;
      count = count + 1;
    }
    const nowFrom = i;
    const nowTo = i + count;
    i = nowTo;
    formatLeadingCommentsRange(nowFrom, nowTo, f);
    // oxc does not see the line break after a block comment that the file starts with.
    const lastNow = nowTo - 1;
    const startsFile = cm.isBlock(lastNow) && isBlankBefore(text, cm.spanStart[lastNow] | 0);
    let last = f.len() - 1;
    if (last >= 0 && (st.tag[last] | 0) === E_LINE && (st.a[last] | 0) === LM_HARD && startsFile) continue;
    last = f.len() - 1;
    if (last >= 0 && (st.tag[last] | 0) === E_LINE && ((st.a[last] | 0) === LM_HARD || (st.a[last] | 0) === LM_EMPTY)) {
      const mode = st.a[last] | 0;
      state$.lines.push(new Line(LINE_COMMENT, state$.lineStart, last > state$.lineStart ? last : state$.lineStart, 0));
      if (mode === LM_EMPTY) state$.lines.push(new Line(LINE_EMPTY, 0, 0, 0));
      state$.lineStart = f.len();
    }
  }
}

/** `Written::new` */
function newWritten(statement: number, imp: number, f: Formatter): Written {
  const cx = cxOf(f);
  const cm = cx.comments;
  const text = cx.src.text;
  let sourceStart = 0;
  let sourceEnd = 0;
  if (importSpecSpanOf(imp)) {
    sourceStart = SP[0] | 0;
    sourceEnd = SP[1] | 0;
  }
  let source = bytesString(text, sourceStart, sourceEnd);
  let hasCommentForDefault = false;
  if (cm.hasCommentBefore(sourceStart)) {
    stmtSpan(statement);
    const keywordEnd = ((SP[0] | 0) + 6) | 0;
    // Without a `from`, everything is after it.
    let isAfterFrom = importIsSideEffect(imp);
    let position = keywordEnd;
    if (!isAfterFrom) {
      importClauseSpan(imp);
      position = SP[1] | 0;
    }
    cm.commentsIn(position, sourceStart);
    const from = cm.from;
    const to = cm.to;
    let found = -1;
    for (let k = from; k < to; k++) {
      const cStart = cm.spanStart[k] | 0;
      if (containsAscii(text, position, cStart, "from")) isAfterFrom = true;
      position = cm.spanEnd[k] | 0;
      if (isAfterFrom) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      const cStart = cm.spanStart[found] | 0;
      const cEnd = cm.spanEnd[found] | 0;
      let nl = -1;
      for (let k = cStart; k < cEnd; k++) {
        if ((text[k] | 0) === 10) {
          nl = k;
          break;
        }
      }
      source = nl >= 0 ? bytesString(text, cStart, trimAsciiEnd(text, cStart, nl)) : bytesString(text, cStart, cEnd);
    }
    if (importNamespaceSpan(imp) && importDefault(imp) < 0) {
      const star = SP[0] | 0;
      cm.commentsIn(keywordEnd, star);
      hasCommentForDefault = cm.to > cm.from;
    }
  }
  return new Written(statement, imp, source, hasCommentForDefault);
}
