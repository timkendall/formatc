// Port of vendor/bun/src/format/html/vue.rs: Prettier's `language-html/embed/vue-*.js`: the attributes of Vue.
import { ByteBuf } from "../../base/bytebuf.ts";
import { InHtml, HTML_ROOT_JS_EXPRESSION, HTML_ROOT_PROGRAM, HTML_ROOT_VUE_EVENT_BINDING, HTML_ROOT_VUE_EXPRESSION } from "../options.ts";
import { token } from "../ir/element.ts";
import { jsWhitespaceLen, startsWithWhiteSpace, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  A_STRIDE,
  AF_NAME_E,
  AF_NAME_S,
  AF_NS_E,
  AF_NS_S,
  K_ELEMENT,
  attribute,
  attrValueIs,
  aGet,
  firstChild,
  kindOf,
  nextOf,
  nodeIsFullName,
  AF_HAS_VAL,
} from "./ast.ts";
import { eqLit } from "./data.ts";
import { Printer } from "./pstate.ts";
import { TK_SP } from "./printer.ts";
import { beginAttributeValue, endAttributeValue } from "./embed.ts";
import { isVueSfcBlock, isVueScriptTag } from "./utilities.ts";
import {
  BINDING_FOR_LEFT,
  BINDING_PARAMETERS,
  BINDING_TYPE_PARAMETERS,
  HUG_ALWAYS,
  HUG_EXPRESSION,
  SYN_BABEL,
  SYN_BABEL_TS,
  writeBinding,
  writeExpression,
  writeProgramInAttribute,
} from "./js.ts";

/** `isVueSfcWithTypescriptScript` */
export function isVueSfcWithTypescriptScript(p: Printer): boolean {
  if (p.hasTypescriptScript >= 0) return p.hasTypescriptScript === 1;
  const t = p.t;
  let result = false;
  for (let child = firstChild(t, t.root); child >= 0; child = nextOf(t, child)) {
    if (isVueScriptTag(t, child, p.o)) {
      const a = attribute(t, child, "lang");
      if (a >= 0 && (attrValueIs(t, a, "ts") || attrValueIs(t, a, "typescript"))) {
        result = true;
        break;
      }
    }
  }
  p.hasTypescriptScript = result ? 1 : 0;
  return result;
}

/** oxfmt's `hasTsxScriptBlock`: whether a `<script>` anywhere in the file says `lang="tsx"`. */
export function hasTsxScript(p: Printer): boolean {
  if (p.hasTsxScript >= 0) return p.hasTsxScript === 1;
  const t = p.t;
  let result = false;
  for (let id = 0; id < t.count; id++) {
    if (kindOf(t, id) === K_ELEMENT && nodeIsFullName(t, id, "script")) {
      const a = attribute(t, id, "lang");
      if (a >= 0 && attrValueIs(t, a, "tsx")) {
        result = true;
        break;
      }
    }
  }
  p.hasTsxScript = result ? 1 : 0;
  return result;
}

/** `v-for="left operator right"`: the parts are ranges of the value; `left` is `l0..l2`, the operator `opS`, the right `rS..rE`. */
class VFor {
  /** The alias and the iterators: three ranges. */
  l: Int32Array = new Int32Array(6);
  opS: number = 0;
  rS: number = 0;
  rE: number = 0;
}
const vfor = new VFor();

/** `parseVueVForDirective` of `b[vs, ve)`. */
function parseVueVForDirective(b: Uint8Array, vs: number, ve: number): boolean {
  // `/(.*?)\s+(in|of)\s+(.*)/s`
  let at = vs;
  let aliasE = 0;
  let opS = 0;
  let rightS = 0;
  for (;;) {
    if (at >= ve) return false;
    let blank = at;
    for (;;) {
      const n = jsWhitespaceLen(b, blank, ve);
      if (n === 0) break;
      blank = blank + n;
    }
    const blankLen = blank - at;
    const c0 = blank < ve ? b[blank] | 0 : 0;
    const c1 = blank + 1 < ve ? b[blank + 1] | 0 : 0;
    if (((c0 === 105 && c1 === 110) || (c0 === 111 && c1 === 102)) && blankLen > 0 && startsWithWhiteSpace(b, blank + 2, ve)) {
      aliasE = at;
      opS = blank;
      rightS = blank + 2;
      break;
    }
    // From anywhere else in the white space, the same follows it.
    at = at + (blankLen > 1 ? blankLen : 1);
  }
  const rs = trimJsWhitespaceStart(b, rightS, ve);
  const re = trimJsWhitespaceEnd(b, rs, ve);
  if (rs >= re) return false;
  // `.replaceAll(/^\(|\)$/g, "")`
  let as = trimJsWhitespaceStart(b, vs, aliasE);
  let ae = trimJsWhitespaceEnd(b, as, aliasE);
  if (as < ae && (b[as] | 0) === 40) as = as + 1;
  if (as < ae && (b[ae - 1] | 0) === 41) ae = ae - 1;
  // `/,([^,\]}]*)(?:,([^,\]}]*))?$/`: the first of the last two commas that no bracket follows.
  let last = -1;
  let first = -1;
  for (let i = ae - 1; i >= as; i--) {
    const c = b[i] | 0;
    if (c === 93 || c === 125) break;
    if (c === 44) {
      if (last < 0) last = i;
      else if (first < 0) {
        first = i;
        break;
      }
    }
  }
  const vfor$ = vfor;
  const l = vfor$.l;
  const set = (k: number, s: number, e: number): void => {
    l[2 * k] = s;
    l[2 * k + 1] = e;
  };
  const trimSet = (k: number, s: number, e: number): void => {
    const ts = trimJsWhitespaceStart(b, s, e);
    set(k, ts, trimJsWhitespaceEnd(b, ts, e));
  };
  if (last < 0) {
    set(0, as, ae);
    set(1, 0, 0);
    set(2, 0, 0);
  } else if (first < 0) {
    set(0, as, last);
    trimSet(1, last + 1, ae);
    set(2, 0, 0);
  } else {
    set(0, as, first);
    trimSet(1, first + 1, last);
    trimSet(2, last + 1, ae);
  }
  const isEmpty = (k: number): boolean => l[2 * k] === l[2 * k + 1];
  for (let index = 0; index < 3; index++) {
    if (isEmpty(index)) {
      let isMissing = index === 0;
      if (!isMissing) {
        for (let k = index + 1; k < 3; k++) {
          if (!isEmpty(k)) isMissing = true;
        }
      }
      if (isMissing) return false;
    }
  }
  vfor$.opS = opS;
  vfor$.rS = rs;
  vfor$.rE = re;
  return true;
}

/** `printVueVForDirective` */
function printVueVForDirective(p: Printer, b: Uint8Array, vs: number, ve: number, isTypescript: boolean, inHtml: InHtml): boolean {
  if (!parseVueVForDirective(b, vs, ve)) return false;
  const vfor$ = vfor;
  const l = vfor$.l;
  const opS = vfor$.opS;
  const rS = vfor$.rS;
  const rE = vfor$.rE;
  const left = new ByteBuf(64);
  let any = false;
  for (let k = 0; k < 3; k++) {
    if (l[2 * k] === l[2 * k + 1]) continue;
    if (any) left.push(44);
    any = true;
    left.append(b, l[2 * k], l[2 * k + 1]);
  }
  const w = p.w;
  w.startGroup();
  const isWritten = writeBinding(p, left.data, 0, left.len, isTypescript, inHtml, BINDING_FOR_LEFT, p.o.scriptFlavor);
  w.endGroup();
  w.token(TK_SP);
  w.text(b, opS, opS + 2);
  w.token(TK_SP);
  return isWritten && writeExpression(p, b, rS, rE, isTypescript, inHtml, HUG_ALWAYS);
}

function startsWithLit(fn: ByteBuf, lit: string): boolean {
  if (fn.len < lit.length) return false;
  return eqLit(fn.data, 0, lit.length, lit);
}

function inHtmlOf(root: number): InHtml {
  const i = new InHtml();
  i.root = root;
  i.isInAttribute = true;
  return i;
}

/** The printers of `embed/vue-attributes.js`. `v`: the value without the entities for quotes. Returns whether the attribute has been written. */
export function embedVueAttribute(p: Printer, element: number, a: number, vb: Uint8Array, vs: number, ve: number): boolean {
  const t = p.t;
  const ab = a * A_STRIDE;
  // `attr.full_name()`
  const name = new ByteBuf(32);
  const ns = t.a[ab + AF_NS_S] | 0;
  const ne = t.a[ab + AF_NS_E] | 0;
  if (ne > ns) {
    name.append(t.pool.data, ns, ne);
    name.push(58);
  }
  name.append(t.pool.data, t.a[ab + AF_NAME_S] | 0, t.a[ab + AF_NAME_E] | 0);
  const isTypescript = isVueSfcWithTypescriptScript(p);
  const flavor = p.o.scriptFlavor;
  const expression = inHtmlOf(HTML_ROOT_JS_EXPRESSION);
  const fn = name.data;
  const fl = name.len;
  if (eqLit(fn, 0, fl, "v-for")) {
    beginAttributeValue(p);
    return endAttributeValue(p, a, printVueVForDirective(p, vb, vs, ve, isTypescript, expression));
  }
  if (eqLit(fn, 0, fl, "generic") && isVueScriptTag(t, element, p.o)) {
    beginAttributeValue(p);
    return endAttributeValue(p, a, writeBinding(p, vb, vs, ve, true, inHtmlOf(HTML_ROOT_PROGRAM), BINDING_TYPE_PARAMETERS, flavor));
  }
  // `isVueSlotAttribute`, `isVueSfcBindingsAttribute`
  let isBindings =
    (fl > 0 && (fn[0] | 0) === 35) || eqLit(fn, 0, fl, "slot-scope") || eqLit(fn, 0, fl, "v-slot") || startsWithLit(name, "v-slot:");
  if (!isBindings && isVueSfcBlock(t, element, p.o)) {
    isBindings = (nodeIsFullName(t, element, "script") && eqLit(fn, 0, fl, "setup")) || (nodeIsFullName(t, element, "style") && eqLit(fn, 0, fl, "vars"));
  }
  if (isBindings) {
    beginAttributeValue(p);
    return endAttributeValue(p, a, writeBinding(p, vb, vs, ve, isTypescript, inHtmlOf(HTML_ROOT_PROGRAM), BINDING_PARAMETERS, flavor));
  }
  if ((fl > 0 && (fn[0] | 0) === 64) || startsWithLit(name, "v-on:")) {
    // `printVueVOnDirective`
    beginAttributeValue(p);
    if (endAttributeValue(p, a, writeExpression(p, vb, vs, ve, isTypescript, expression, HUG_EXPRESSION))) return true;
    beginAttributeValue(p);
    return endAttributeValue(
      p,
      a,
      writeProgramInAttribute(p, vb, vs, ve, isTypescript ? SYN_BABEL_TS : SYN_BABEL, inHtmlOf(HTML_ROOT_VUE_EVENT_BINDING), HUG_EXPRESSION),
    );
  }
  let root: number;
  const c0 = fl > 0 ? fn[0] | 0 : 0;
  if (c0 === 58 || c0 === 46 || startsWithLit(name, "v-bind:")) root = HTML_ROOT_VUE_EXPRESSION;
  else if (startsWithLit(name, "v-")) root = HTML_ROOT_JS_EXPRESSION;
  else return false;
  beginAttributeValue(p);
  return endAttributeValue(p, a, writeExpression(p, vb, vs, ve, isTypescript, inHtmlOf(root), HUG_EXPRESSION));
}

void token;
void AF_HAS_VAL;
void aGet;
