// Port of vendor/bun/src/format/js/utils/object.rs: the names of properties and members. Prettier's `print/key.js`.
//
// `owner`: a Node: the member, the property, the pattern property or the enum member whose key it is (`nodeOfMember(m)`, ..). `parent`: an `AstNodes`: what
// it is the name of.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { Formatter } from "../../ir/formatter.ts";
import { E_SOURCE_TEXT } from "../../ir/element.ts";
import { twValue } from "../../ir/element.ts";
import { LBRACKET, RBRACKET } from "../../ir/tokens.ts";
import { HTML_ROOT_NONE, HTML_ROOT_PROGRAM, QUOTE_PROPS_AS_NEEDED, QUOTE_PROPS_CONSISTENT, QUOTE_PROPS_PRESERVE, FLAVOR_OXFMT, quoteStyleAsByte } from "../../options.ts";
import {
  EXPR_OBJECT,
  FLAG_ABSTRACT,
  KEY,
  KEY_COMPUTED,
  KEY_COMPUTED_NUMBER,
  KEY_COMPUTED_STRING,
  KEY_EXPR,
  KEY_IDENT,
  KEY_NAME,
  KEY_NUMBER,
  KEY_PRIVATE,
  KEY_STRING,
  N_EXPR,
  N_PAT,
  PAT_OBJECT,
  SP,
  exprObjectPropsLen,
  exprObjectPropsStart,
  exprTag,
  fileHasBom,
  fileIsFlow,
  fileIsJavascript,
  hir,
  keyInnerSpan,
  keyLoad,
  keySpan,
  listAt,
  memberModifiersLen,
  memberModifiersStart,
  modifierFlagOf,
  nameBuf,
  nameEqualsBytes,
  nameLen,
  nameStart,
  nodeId,
  nodeKind,
  nodeOfPatProp,
  nodeOfProp,
  patObjectPropsLen,
  patObjectPropsStart,
  patPropParent,
  patTag,
  propParent,
} from "../../../lint/ast/index.ts";
import { goesToFlow } from "../../../lint/linter/syntax/mod.ts";
import {
  AN_ACCESSOR_PROPERTY,
  AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY,
  AN_BINDING_PROPERTY,
  AN_METHOD_DEFINITION,
  AN_OBJECT_PROPERTY,
  AN_PROPERTY_DEFINITION,
  AN_TS_ENUM_MEMBER,
  AN_TS_METHOD_SIGNATURE,
  AN_TS_PROPERTY_SIGNATURE,
  anId,
  anTag,
  mkAn,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import {
  PK_PARENT,
  enterScope,
  fmtExpr,
  leaveScope,
  writeTrailingCommentsIn,
} from "../format.ts";
import { formatLeadingComments } from "../trivia.ts";
import { CLEAN, cleanStringLiteralText, isCanonicalSimpleNumber, isNameWithoutQuotes, isSimpleNumber, STRING_LITERAL_PARENT_KIND_EXPRESSION } from "./string.ts";
import { numBuf, trimmedNumber } from "./number.ts";
import { writeSuppressedNode } from "./suppressed.ts";

/** What `printedKey` made: `KR[0]`: 0 the source `[KR[1], KR[2])`, 1 `KB`, 2 `CLEAN`. */
const KR = new Int32Array(4);
const KB = new ByteBuf(64);
const KB2 = new ByteBuf(64);
/** The content of a string that `unquoted` found, in `UQ`. */
const UQ = new Int32Array(2);

function setSource(a: number, b: number): void {
  KR[0] = 0;
  KR[1] = a;
  KR[2] = b;
}

/** `text` in the quotes of the options. It has no quotes in it. */
function setQuoted(text: Uint8Array, a: number, b: number, f: Formatter): void {
  const quote = quoteStyleAsByte(f.options.quoteStyle);
  const KB$ = KB;
  KB$.reset();
  KB$.push(quote);
  KB$.append(text, a, b);
  KB$.push(quote);
  KR[0] = 1;
}

/** `text[a, b)` with `\n` for `\r\n` and for `\r`: what Prettier is given. */
function setWithNormalizedNewlines(text: Uint8Array, a: number, b: number): void {
  let hasCr = false;
  for (let i = a; i < b; i++) {
    if ((text[i] | 0) === 13) {
      hasCr = true;
      break;
    }
  }
  if (!hasCr) {
    setSource(a, b);
    return;
  }
  const KB$ = KB;
  KB$.reset();
  let i = a;
  while (i < b) {
    const c = text[i] | 0;
    if (c === 13) {
      KB$.push(10);
      i = i + (i + 1 < b && (text[i + 1] | 0) === 10 ? 2 : 1);
    } else {
      KB$.push(c);
      i = i + 1;
    }
  }
  KR[0] = 1;
}

/** Whether Prettier's `parser` is `babel` and the like, not one of those for an expression in HTML or for JSX in MDX, which it does not name where it takes a number out of its quotes. */
function isParserForPrograms(f: Formatter): boolean {
  const root = f.options.inHtml.root;
  return (root === HTML_ROOT_NONE || root === HTML_ROOT_PROGRAM) && !f.options.isMdxJsx;
}

function isGoesToFlow(f: Formatter): boolean {
  const off = fileHasBom() ? 3 : 0;
  const hir$ = hir;
  const len = hir$.sourceLen | 0;
  return goesToFlow(off === 0 ? hir$.text : hir$.text.subarray(off), len - off, f.options.filepath);
}

/**
 * Prettier's `isKeySafeToUnquote`. `string`: `f.source[start, end)`, a string literal that is the name of `parent` (-1: of nothing in particular).
 * Returns whether it can be unquoted; the content is `UQ[0] .. UQ[1]`.
 */
function unquoted(start: number, end: number, parent: number, f: Formatter): boolean {
  if (end - start < 2) return false;
  const text = f.source;
  const cs = start + 1;
  const ce = end - 1;
  UQ[0] = cs;
  UQ[1] = ce;
  const isJavascript = fileIsJavascript();
  const pt = parent >= 0 ? anTag(parent) : -1;
  if (pt === AN_TS_METHOD_SIGNATURE && ce - cs === 3 && (text[cs] | 0) === 110 && (text[cs + 1] | 0) === 101 && (text[cs + 2] | 0) === 119) {
    return false;
  }
  if (pt === AN_PROPERTY_DEFINITION && !isJavascript) {
    // With `strictPropertyInitialization`, TypeScript treats a property with a quoted name differently.
    const member = anId(parent);
    const s = memberModifiersStart(member);
    const n = memberModifiersLen(member);
    let isAbstract = false;
    for (let i = 0; i < n; i++) {
      if (modifierFlagOf(listAt(s, i)) === FLAG_ABSTRACT) {
        isAbstract = true;
        break;
      }
    }
    if (!isAbstract) return false;
  }
  // In TypeScript, `1` and `"1"` are different types.
  if (isNameWithoutQuotes(text, cs, ce, f.options.flavor)) return true;
  return (
    isJavascript &&
    isParserForPrograms(f) &&
    isSimpleNumber(text, cs, ce) &&
    isCanonicalSimpleNumber(text, cs, ce) &&
    !fileIsFlow() &&
    (f.options.flavor === FLAVOR_OXFMT || !isGoesToFlow(f))
  );
}

/**
 * Whether `key`, the name of `parent`, is a string that cannot do without its quotes. With `quoteProps: "consistent"`, the names next to it are quoted then.
 */
export function keyRequiresQuotes(owner: number, parent: number, f: Formatter): boolean {
  return requiresQuotes(owner, parent, f);
}

/** `keyRequiresQuotes` without what only holds for the names of some kinds of members. */
export function shouldPreserveQuote(owner: number, f: Formatter): boolean {
  return requiresQuotes(owner, -1, f);
}

function requiresQuotes(owner: number, parent: number, f: Formatter): boolean {
  if (keyLoad(owner) !== KEY_STRING) return false;
  if (!keySpan(owner)) return false;
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  if (!unquoted(start, end, parent, f)) return true;
  // With `quoteProps: "consistent"`, `{ "1": a, b: c }` is `{ 1: a, b: c }` for Prettier and `{ "1": a, "b": c }` for oxfmt.
  return f.options.flavor === FLAVOR_OXFMT && !isNameWithoutQuotes(f.source, UQ[0] | 0, UQ[1] | 0, f.options.flavor);
}

/**
 * Prettier's `hasSiblingsRequireQuoted`. `parent`: what has the name.
 *
 * Objects, classes, interfaces and enums, which can be large, have put the answer in the context. For patterns, this looks at all the names.
 */
function siblingsRequireQuotes(parent: number, f: Formatter): boolean {
  switch (anTag(parent)) {
    case AN_OBJECT_PROPERTY:
    case AN_TS_PROPERTY_SIGNATURE:
    case AN_TS_METHOD_SIGNATURE:
    case AN_METHOD_DEFINITION:
    case AN_PROPERTY_DEFINITION:
    case AN_ACCESSOR_PROPERTY:
    case AN_TS_ENUM_MEMBER:
      return cxOf(f).isQuoteNeeded();
    case AN_BINDING_PROPERTY: {
      const owner = patPropParent(anId(parent));
      if (nodeKind(owner) !== N_PAT) return false;
      const pat = nodeId(owner);
      if (patTag(pat) !== PAT_OBJECT) return false;
      const s = patObjectPropsStart(pat);
      const n = patObjectPropsLen(pat);
      for (let i = 0; i < n; i++) {
        const it = listAt(s, i);
        if (requiresQuotes(nodeOfPatProp(it), mkAn(AN_BINDING_PROPERTY, it), f)) return true;
      }
      return false;
    }
    case AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY: {
      const owner = propParent(anId(parent));
      if (nodeKind(owner) !== N_EXPR) return false;
      const object = nodeId(owner);
      if (exprTag(object) !== EXPR_OBJECT) return false;
      const s = exprObjectPropsStart(object);
      const n = exprObjectPropsLen(object);
      for (let i = 0; i < n; i++) {
        if (requiresQuotes(nodeOfProp(listAt(s, i)), parent, f)) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** The part of Prettier's `shouldQuoteKey` that is the same for all the names of an object. */
function shouldQuoteKeys(parent: number, f: Formatter): boolean {
  return f.options.quoteProperties === QUOTE_PROPS_CONSISTENT && siblingsRequireQuotes(parent, f);
}

/** The part of Prettier's `shouldUnquoteKey` that is the same for all the names of an object. */
function shouldUnquoteKeys(parent: number, f: Formatter): boolean {
  const qp = f.options.quoteProperties;
  if (qp === QUOTE_PROPS_AS_NEEDED) return true;
  if (qp === QUOTE_PROPS_PRESERVE) return false;
  return !siblingsRequireQuotes(parent, f);
}

/** The string literal `f.source[start, end)` written with the quotes of the options, into `KR`. */
function setStringLiteral(start: number, end: number, f: Formatter): void {
  if (!cleanStringLiteralText(start, end, false, STRING_LITERAL_PARENT_KIND_EXPRESSION, f)) setSource(start, end);
  else KR[0] = 2;
}

/** The number `numBuf()[0, n)` that `trimmedNumber` made, into `KB`; or the source. */
function setTrimmedNumber(text: Uint8Array, start: number, end: number): void {
  const n = trimmedNumber(text, start, end);
  if (n < 0) {
    setSource(start, end);
    return;
  }
  const KB$ = KB;
  KB$.reset();
  KB$.append(numBuf(), 0, n);
  KR[0] = 1;
}

/**
 * What is written for the key (of kind `kind`) at `f.source[start, end)`, which is not an expression in brackets, into `KR` (`KB`, `CLEAN`).
 * `owner`'s `KEY` slots are those of the key.
 */
function printedKey(kind: number, name: number, start: number, end: number, parent: number, f: Formatter): void {
  const text = f.source;
  // TODO(port): tailwind (`sorted_string_literal`, `sorted_template_text`): the option is refused by the driver.
  const KB$ = KB;
  const KB2$ = KB2;
  switch (kind) {
    case KEY_IDENT:
      if (shouldQuoteKeys(parent, f)) {
        const s = nameStart(name);
        setQuoted(nameBuf(name), s, s + nameLen(name), f);
      } else setSource(start, end);
      return;
    case KEY_PRIVATE:
      setSource(start, end);
      return;
    case KEY_STRING:
      if (unquoted(start, end, parent, f) && shouldUnquoteKeys(parent, f)) setSource(UQ[0] | 0, UQ[1] | 0);
      else setStringLiteral(start, end, f);
      return;
    case KEY_COMPUTED_STRING:
      if ((text[start] | 0) === 96) setWithNormalizedNewlines(text, start, end);
      else setStringLiteral(start, end, f);
      return;
    case KEY_NUMBER:
    case KEY_COMPUTED_NUMBER: {
      if (end > start && (text[end - 1] | 0) === 110) {
        let hasUpper = false;
        for (let i = start; i < end; i++) {
          const c = text[i] | 0;
          if (c >= 65 && c <= 90) {
            hasUpper = true;
            break;
          }
        }
        if (!hasUpper) {
          setSource(start, end);
          return;
        }
        KB$.reset();
        for (let i = start; i < end; i++) {
          const c = text[i] | 0;
          KB$.push(c >= 65 && c <= 90 ? c + 32 : c);
        }
        KR[0] = 1;
        return;
      }
      setTrimmedNumber(text, start, end);
      if (kind === KEY_COMPUTED_NUMBER) return;
      // Prettier's `isKeySafeToQuote`: not in TypeScript, where it changes the type, and only if the number is written the way it is converted to a string.
      if (!cxOf(f).hasTreeOfBabel) return;
      const printed = KR[0] === 0 ? text : KB$.data;
      const ps = KR[0] === 0 ? KR[1] | 0 : 0;
      const pe = KR[0] === 0 ? KR[2] | 0 : KB$.len;
      if (isSimpleNumber(printed, ps, pe) && nameEqualsBytes(name, printed, ps, pe - ps) && shouldQuoteKeys(parent, f)) {
        // `setQuoted` resets `KB`, which can be where `printed` is: copy it first.
        KB2$.reset();
        KB2$.append(printed, ps, pe);
        setQuoted(KB2$.data, 0, KB2$.len, f);
      }
      return;
    }
    default:
      setSource(start, end);
  }
}

/** Writes the text `KR` says, which is the key at `(start, end)`. */
function writePrinted(isName: boolean, start: number, end: number, f: Formatter): void {
  const where = KR[0] | 0;
  const KB$ = KB;
  const CLEAN$ = CLEAN;
  if (where === 0) {
    if (isName) f.sourceText(start, end);
    else f.textSource(KR[1] | 0, KR[2] | 0);
  } else if (where === 1) f.textBytes(KB$.data, 0, KB$.len);
  else f.textBytes(CLEAN$.data, 0, CLEAN$.len);
}

/** The number of columns that `KR` takes. With a line break in it, it is not one string to Prettier, which asks for the width of nothing else. */
function printedWidth(f: Formatter): number {
  const where = KR[0] | 0;
  const KB$ = KB;
  const CLEAN$ = CLEAN;
  const buf = where === 0 ? f.source : where === 1 ? KB$.data : CLEAN$.data;
  const a = where === 0 ? KR[1] | 0 : 0;
  const b = where === 0 ? KR[2] | 0 : where === 1 ? KB$.len : CLEAN$.len;
  for (let i = a; i < b; i++) if ((buf[i] | 0) === 10) return Number.MAX_SAFE_INTEGER;
  return f.stringWidth(buf, a, b);
}

/**
 * Writes the key of `owner`, which is not an expression in brackets. `parent`: what it is the name of. Returns the number of columns that it takes.
 */
function writeKey(owner: number, parent: number, f: Formatter): number {
  const kind = keyLoad(owner);
  if (kind < 0) return 0;
  const name = KEY.s1 | 0;
  if (!keyInnerSpan(owner)) return 0;
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  const cx = cxOf(f);
  const isName = kind === KEY_IDENT || kind === KEY_PRIVATE;
  if (isName && cx.isQuiet && f.options.quoteProperties !== QUOTE_PROPS_CONSISTENT) {
    f.sourceText(start, end);
    const last = f.len() - 1;
    return last >= 0 && (f.tagAt(last) | 0) === E_SOURCE_TEXT ? twValue(f.st.c[last] | 0) : 0;
  }
  printedKey(kind, name, start, end, parent, f);
  const width = printedWidth(f);
  // format_node(span, parent, f, ..)
  if (cx.isQuiet) {
    writePrinted(isName, start, end, f);
    return width;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    writePrinted(isName, start, end, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_PARENT, parent, f);
  return width;
}

/** `FormatKey::new(key, parent).fmt(f)`: Prettier's `printKey`, without the brackets of a computed key, with the comments around it. Quotes are added and removed as `quoteProps` says. */
export function fmtKey(owner: number, parent: number, f: Formatter): void {
  const kind = keyLoad(owner);
  if (kind === KEY_COMPUTED) {
    fmtExpr(KEY.s2 | 0, f);
    return;
  }
  if (kind < 0) return;
  writeKey(owner, parent, f);
}

/** `format_computed_or_property_key(key, parent, f)`: Prettier's `printKey`: `[a]` or the key. */
export function formatComputedOrPropertyKey(owner: number, parent: number, f: Formatter): void {
  const kind = keyLoad(owner);
  if (kind < 0) return;
  if (kind === KEY_COMPUTED || kind === KEY_COMPUTED_STRING || kind === KEY_COMPUTED_NUMBER) {
    f.token(LBRACKET);
    fmtKey(owner, parent, f);
    f.token(RBRACKET);
  } else fmtKey(owner, parent, f);
}

/**
 * `write_member_name(key, parent, f)`: writes the key (which is not computed) and returns the number of columns it takes (`Number.MAX_SAFE_INTEGER` for a
 * text with a line break).
 */
export function writeMemberName(owner: number, parent: number, f: Formatter): number {
  return writeKey(owner, parent, f);
}
