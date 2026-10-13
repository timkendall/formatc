// Port of vendor/bun/src/format/html/angular_print.rs: Prettier's `language-html/print/angular-*.js`.
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import { token } from "../ir/element.ts";
import {
  F_END_E,
  F_END_S,
  HAS_END_SPAN,
  HAS_LEADING_SPACES,
  HAS_TRAILING_SPACES,
  K_ANGULAR_CONTROL_FLOW_BLOCK,
  K_TEXT,
  firstChild,
  has,
  hasChildren,
  kindOf,
  nGet,
  nameEnd,
  nameStart,
  nextOf,
  parametersOf,
  prevOf,
  valEnd,
  valStart,
  HTree,
} from "./ast.ts";
import { eqLit } from "./data.ts";
import { Printer, TG_LET_INITIALIZER, TG_NODE, cursorMarksBegin, cursorMarksEnd } from "./pstate.ts";
import { builtClosingTagEnd, builtOpeningTagStart, formatsEmbedded, printChildren, printNode } from "./printer.ts";
import { hasPrettierIgnore, trimAsciiEnd, trimAsciiStart } from "./utilities.ts";
import { embedAngularControlFlowBlockParameters, embedAngularLetDeclarationInitializer } from "./angular.ts";

const TK_CLOSE_SPACE = token("} ");
const TK_AT = token("@");
const TK_OPEN_PAREN_SPACE = token(" (");
const TK_OPEN_PAREN = token("(");
const TK_CLOSE_PAREN = token(")");
const TK_SEMI = token(";");
const TK_OPEN_BRACE_SPACE = token(" {");
const TK_CLOSE_BRACE = token("}");
const TK_LET = token("@let ");
const TK_EQ_SPACE = token(" =");
const TK_COMMA_SPACE = token(", ");
const TK_COMMA = token(",");

/** `ANGULAR_CONTROL_FLOW_BLOCK_SETTINGS.get(name)?.has(next)` */
function canFollow(b: Uint8Array, ns: number, ne: number, xs: number, xe: number): boolean {
  if (eqLit(b, ns, ne, "if") || eqLit(b, ns, ne, "else if")) return eqLit(b, xs, xe, "else if") || eqLit(b, xs, xe, "else");
  if (eqLit(b, ns, ne, "for")) return eqLit(b, xs, xe, "empty");
  if (eqLit(b, ns, ne, "defer") || eqLit(b, ns, ne, "placeholder") || eqLit(b, ns, ne, "error") || eqLit(b, ns, ne, "loading")) {
    return eqLit(b, xs, xe, "placeholder") || eqLit(b, xs, xe, "error") || eqLit(b, xs, xe, "loading");
  }
  if (eqLit(b, ns, ne, "boundary")) return eqLit(b, xs, xe, "error");
  return false;
}

/** `shouldCloseBlock` */
function shouldCloseBlock(t: HTree, id: number): boolean {
  const next = nextOf(t, id);
  if (next >= 0 && kindOf(t, next) === K_ANGULAR_CONTROL_FLOW_BLOCK) {
    return !canFollow(t.pool.data, nameStart(t, id), nameEnd(t, id), nameStart(t, next), nameEnd(t, next));
  }
  return true;
}

export function printAngularControlFlowBlock(p: Printer, id: number): void {
  const t = p.t;
  const w = p.w;
  const b = t.pool.data;
  const isDefaultNever = eqLit(b, nameStart(t, id), nameEnd(t, id), "default never");
  if (!isDefaultNever) w.startGroupWith(true, 0);
  // `isPreviousBlockUnClosed`
  const previous = prevOf(t, id);
  if (previous >= 0 && kindOf(t, previous) === K_ANGULAR_CONTROL_FLOW_BLOCK && !hasPrettierIgnore(t, previous) && !shouldCloseBlock(t, previous)) {
    w.token(TK_CLOSE_SPACE);
  }
  w.token(TK_AT);
  w.text(b, nameStart(t, id), nameEnd(t, id));
  const parameters = parametersOf(t, id);
  if (parameters >= 0) {
    w.token(isDefaultNever ? TK_OPEN_PAREN : TK_OPEN_PAREN_SPACE);
    w.startGroup();
    p.ancestors = p.ancestors + 1;
    const after = cursorMarksBegin(p, TG_NODE, parameters, 0);
    printAngularControlFlowBlockParametersOrEmbed(p, id, parameters);
    cursorMarksEnd(p, after);
    p.ancestors = p.ancestors - 1;
    w.endGroup();
    w.token(TK_CLOSE_PAREN);
  }
  if (isDefaultNever) {
    w.token(TK_SEMI);
    return;
  }
  // `isSwitchFallthroughCase`
  const ns = nameStart(t, id);
  const ne = nameEnd(t, id);
  const isFallthrough =
    (eqLit(b, ns, ne, "case") || eqLit(b, ns, ne, "default")) && has(t, id, HAS_END_SPAN) && nGet(t, id, F_END_S) === nGet(t, id, F_END_E);
  if (!isFallthrough) {
    w.token(TK_OPEN_BRACE_SPACE);
    const shouldPrintCloseBracket = shouldCloseBlock(t, id);
    if (hasChildren(t, id)) {
      w.startIndent();
      w.hardline();
      printChildren(p, id);
      w.endIndent();
      if (shouldPrintCloseBracket) {
        w.hardline();
        w.token(TK_CLOSE_BRACE);
      }
    } else if (shouldPrintCloseBracket) {
      w.token(TK_CLOSE_BRACE);
    }
  }
  w.endGroup();
}

function printAngularControlFlowBlockParametersOrEmbed(p: Printer, block: number, parameters: number): void {
  if (formatsEmbedded(p) && embedAngularControlFlowBlockParameters(p, block, parameters)) return;
  printAngularControlFlowBlockParameters(p, parameters);
}

export function printAngularControlFlowBlockParameters(p: Printer, id: number): void {
  const t = p.t;
  const w = p.w;
  const b = t.pool.data;
  w.startIndent();
  w.softline();
  let index = 0;
  for (let parameter = firstChild(t, id); parameter >= 0; parameter = nextOf(t, parameter)) {
    if (index > 0) {
      w.token(TK_SEMI);
      w.line();
    }
    index = index + 1;
    // One string to Prettier, with the line breaks in it.
    const s = trimAsciiStart(b, valStart(t, parameter), valEnd(t, parameter));
    const e = trimAsciiEnd(b, s, valEnd(t, parameter));
    const after = cursorMarksBegin(p, TG_NODE, parameter, 0);
    w.string(b, s, e);
    cursorMarksEnd(p, after);
  }
  w.endIndent();
  w.softline();
}

export function printAngularLetDeclaration(p: Printer, id: number): void {
  const t = p.t;
  const w = p.w;
  const b = t.pool.data;
  w.startGroup();
  w.token(TK_LET);
  w.startGroup();
  w.text(b, nameStart(t, id), nameEnd(t, id));
  w.token(TK_EQ_SPACE);
  w.startGroup();
  w.startIndent();
  w.line();
  const after = cursorMarksBegin(p, TG_LET_INITIALIZER, id, 0);
  if (!(formatsEmbedded(p) && embedAngularLetDeclarationInitializer(p, id))) {
    w.string(t.pool.data, valStart(t, id), valEnd(t, id));
  }
  cursorMarksEnd(p, after);
  w.endIndent();
  w.endGroup();
  w.endGroup();
  w.token(TK_SEMI);
  w.endGroup();
}

export function printAngularIcuExpression(p: Printer, id: number): void {
  const t = p.t;
  const w = p.w;
  const b = t.pool.data;
  builtOpeningTagStart(p, id);
  const groupId = w.newGroupId();
  w.startGroupWith(false, groupId);
  const vs = trimJsWhitespaceStart(b, valStart(t, id), valEnd(t, id));
  w.string(b, vs, trimJsWhitespaceEnd(b, vs, valEnd(t, id)));
  w.token(TK_COMMA_SPACE);
  w.string(b, nameStart(t, id), nameEnd(t, id));
  if (hasChildren(t, id)) {
    w.token(TK_COMMA);
    w.startIndent();
    w.line();
    p.ancestors = p.ancestors + 1;
    let index = 0;
    for (let c = firstChild(t, id); c >= 0; c = nextOf(t, c)) {
      if (index > 0) w.line();
      index = index + 1;
      const after = cursorMarksBegin(p, TG_NODE, c, 0);
      printAngularIcuCase(p, c);
      cursorMarksEnd(p, after);
    }
    p.ancestors = p.ancestors - 1;
    w.endIndent();
  }
  w.softline();
  w.endGroup();
  w.noteLineAtEndOfGroup(groupId);
  builtClosingTagEnd(p, id);
}

export function printAngularIcuCase(p: Printer, id: number): void {
  const t = p.t;
  const w = p.w;
  w.string(t.pool.data, valStart(t, id), valEnd(t, id));
  w.token(TK_OPEN_BRACE_SPACE);
  w.startGroup();
  w.startIndent();
  w.softline();
  p.ancestors = p.ancestors + 1;
  for (let child = firstChild(t, id); child >= 0; child = nextOf(t, child)) {
    const isText = kindOf(t, child) === K_TEXT;
    const leading = has(t, child, HAS_LEADING_SPACES);
    const trailing = has(t, child, HAS_TRAILING_SPACES);
    if (isText && leading) w.line();
    printNode(p, child);
    if (isText && trailing && nextOf(t, child) >= 0) w.line();
  }
  p.ancestors = p.ancestors - 1;
  w.endIndent();
  w.softline();
  w.endGroup();
  w.token(TK_CLOSE_BRACE);
}
