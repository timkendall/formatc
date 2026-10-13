// Port of vendor/bun/src/sema/parser/parser/pattern.rs: binding patterns. See mod.ts for the conventions.
import {
  DK_GRAMMAR,
  NK_IDENTIFIER,
  NK_STRING_LITERAL,
  NONE,
  PK_NAME,
  PK_NONE,
  PK_PRIVATE,
  RARE_ODD_PRIVATE_NAME,
  hir,
  pushPatArray,
  pushPatIdent,
  pushPatMissing,
  pushPatObject,
} from "../../hir.ts";
import { ATOM_NONE } from "../../atom.ts";
import {
  T_BIG_INT,
  T_CLOSE_BRACE,
  T_CLOSE_BRACKET,
  T_COLON,
  T_COMMA,
  T_DOT_DOT_DOT,
  T_OPEN_BRACE,
  T_OPEN_BRACKET,
} from "../token.ts";
import {
  CTX_TYPE,
  LK_ARRAY_BINDING_ELEMENTS,
  LK_OBJECT_BINDING_ELEMENTS,
  disallowInIfBracketsEndIt,
  eat,
  enterContext,
  enterDepth,
  enterList,
  expect,
  flag,
  isBindingIdentifier,
  isInList,
  leaveDepth,
  leaveList,
  lx,
  missingIdentifier,
  names,
  next,
  nextAfterName,
  noteIdentifier,
  p,
  peek,
  s,
  takeList,
} from "./mod.ts";
import { isAtElement, goesOnWithoutComma } from "./recover.ts";
import { propertyName } from "./expr.ts";
import { optionalInitializer } from "./stmt.ts";
import { A_empty } from "../../atom.ts";

/** `parseIdentifierOrPattern` */
export function identifierOrPattern(): number {
  const t = lx.token | 0;
  if (t === T_OPEN_BRACKET) return arrayBindingPattern();
  if (t === T_OPEN_BRACE) return objectBindingPattern();
  return bindingIdentifier();
}

/** `parseBindingIdentifier` */
export function bindingIdentifier(): number {
  if (!isBindingIdentifier()) return missingBindingIdentifier(0);
  const name = lx.atom | 0;
  noteIdentifier(name, lx.start);
  const pat = pushPatIdent(lx.start, lx.end, name);
  nextAfterName();
  return pat;
}

/** `parseBindingIdentifierWithDiagnostic`, at a token that is none. Without recovery: NONE. */
export function missingBindingIdentifier(codeOfPrivateName: number): number {
  const full = lx.fullStart | 0;
  const end = lx.end | 0;
  const name = missingIdentifier(0, codeOfPrivateName);
  const pos_ = p.outPos | 0;
  if (name === ATOM_NONE) return NONE;
  if (name === A_empty) return pushPatIdent(full, full, name);
  return pushPatIdent(pos_, end, name);
}

/** `parseArrayBindingPattern` */
function arrayBindingPattern(): number {
  if (!enterDepth()) return NONE;
  const r = arrayBindingPatternBody();
  leaveDepth();
  return r;
}

function arrayBindingPatternBody(): number {
  const start = lx.start | 0;
  next();
  const saved = enterContext(0, disallowInIfBracketsEndIt());
  const base = s.patElems.len;
  const lists = enterList(LK_ARRAY_BINDING_ELEMENTS);
  while (isInList(T_CLOSE_BRACKET) && isAtElement(LK_ARRAY_BINDING_ELEMENTS)) {
    const element = lx.fullStart | 0;
    // `parseArrayBindingElement`
    if (lx.token === T_COMMA) {
      // `finishNode(NewOmittedExpression(), nodePos())`
      const comma = lx.start | 0;
      const full = lx.fullStart | 0;
      const pat = pushPatMissing(comma, full);
      s.patElems.push(hir.pushPatElem(pat, NONE, 0, comma, full));
    } else {
      const elStart = lx.start | 0;
      const isRest = eat(T_DOT_DOT_DOT);
      const pat = identifierOrPattern();
      const def = optionalInitializer();
      s.patElems.push(hir.pushPatElem(pat, def, isRest ? 1 : 0, elStart, lx.fullStart));
      // `checkGrammarBindingElement`
      if (isRest && lx.token === T_COMMA && peek() === T_CLOSE_BRACKET) flag(DK_GRAMMAR, 1013, lx.start, lx.end);
    }
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_ARRAY_BINDING_ELEMENTS, element)) break;
  }
  leaveList(lists);
  p.context = saved;
  expect(T_CLOSE_BRACKET);
  const elements = takeList(s.patElems, base);
  return pushPatArray(start, lx.fullStart, elements, p.outLen);
}

/** `parseObjectBindingPattern` */
function objectBindingPattern(): number {
  if (!enterDepth()) return NONE;
  const r = objectBindingPatternBody();
  leaveDepth();
  return r;
}

function objectBindingPatternBody(): number {
  const start = lx.start | 0;
  next();
  const saved = enterContext(0, disallowInIfBracketsEndIt());
  const base = s.patProps.len;
  const lists = enterList(LK_OBJECT_BINDING_ELEMENTS);
  while (isInList(T_CLOSE_BRACE) && isAtElement(LK_OBJECT_BINDING_ELEMENTS)) {
    const element = lx.fullStart | 0;
    // `parseObjectBindingElement`
    const pos_ = lx.start | 0;
    let property: number;
    if (!eat(T_DOT_DOT_DOT)) {
      property = objectBindingElement(pos_);
    } else if (p.recovers) {
      property = restBindingElement(pos_);
    } else {
      const keyPos = lx.start | 0;
      const value = bindingIdentifier();
      property = hir.pushPatProp(PK_NONE, NONE, NK_IDENTIFIER, value, NONE, 1, pos_, keyPos, lx.fullStart);
    }
    s.patProps.push(property);
    if (!eat(T_COMMA)) {
      if (goesOnWithoutComma(LK_OBJECT_BINDING_ELEMENTS, element)) continue;
      break;
    }
    if ((hir.patPropIsRest[property] | 0) !== 0 && lx.token === T_CLOSE_BRACE) {
      const end = lx.fullStart | 0;
      flag(DK_GRAMMAR, 1013, end - 1, end);
    }
  }
  leaveList(lists);
  p.context = saved;
  expect(T_CLOSE_BRACE);
  const properties = takeList(s.patProps, base);
  return pushPatObject(start, lx.fullStart, properties, p.outLen);
}

/** The same after `...`, where `checkGrammarBindingElement` reports a property name and an initializer. */
function restBindingElement(pos_: number): number {
  const isIdentifier = isBindingIdentifier();
  const property = objectBindingElement(pos_);
  hir.patPropIsRest[property] = 1;
  // `...a`: the identifier is the binding, and there is no property name.
  const value = hir.patPropValue[property] | 0;
  if (isIdentifier && value >= 0 && (hir.patPos[value] | 0) === (hir.patPropKeyPos[property] | 0)) {
    hir.patPropKeyKind[property] = PK_NONE;
    hir.patPropKeyVal[property] = NONE;
  }
  return property;
}

/** `parseObjectBindingElement`, after its `...` if it has one. `pos_`: its first token. Returns the row. */
function objectBindingElement(pos_: number): number {
  const isIdent = isBindingIdentifier();
  const isBigint = lx.token === T_BIG_INT;
  const bigintStart = lx.start | 0;
  const bigintEnd = lx.end | 0;
  const nameEnd = lx.end | 0;
  propertyName();
  let keyKind = p.keyKind | 0;
  let keyVal = p.keyVal | 0;
  let nameKind = p.nameKind | 0;
  const keyPos = p.namePos | 0;
  if (keyKind === PK_PRIVATE) hir.rareSyntax = hir.rareSyntax | RARE_ODD_PRIVATE_NAME;
  // In a type nothing asks whether the name is in quotes.
  if (nameKind === NK_STRING_LITERAL && (p.context & CTX_TYPE) !== 0) nameKind = NK_IDENTIFIER;
  // `name.Text()` ends with the `n`.
  if (isBigint) {
    keyKind = PK_NAME;
    keyVal = names.atomOfString(bigintTokenValue(bigintStart, bigintEnd));
  }
  let value: number;
  if (isIdent && lx.token !== T_COLON) {
    if (keyKind === PK_NAME) {
      noteIdentifier(keyVal, keyPos);
      value = pushPatIdent(keyPos, nameEnd, keyVal);
    } else {
      value = NONE;
    }
  } else {
    expect(T_COLON);
    value = identifierOrPattern();
  }
  const def = optionalInitializer_();
  return hir.pushPatProp(keyKind, keyVal, nameKind, value, def, 0, pos_, keyPos, lx.fullStart);
}

function optionalInitializer_(): number {
  return optionalInitializer();
}

/** `bun_sema::json::bigint_token_value`: `tokenValue` of the bigint literal `src[start, end)`. */
export function bigintTokenValue(start: number, end: number): string {
  let value = "";
  const src = lx.src;
  for (let i = start; i < end; i++) {
    const c = src[i] | 0;
    if (c === 95) continue;
    value += String.fromCharCode(c >= 65 && c <= 90 ? c + 32 : c);
  }
  // `Scan`: for a radix prefix without digits, the digit is 0.
  if (value.length === 3 && value.charCodeAt(0) === 48 && (value[1] === "x" || value[1] === "b" || value[1] === "o") && value[2] === "n") {
    value = value.slice(0, 2) + "0n";
  }
  const c1 = value.length > 1 ? value[1] : "";
  if (c1 !== "b" && c1 !== "o") return value;
  // `parse_pseudo_big_int`: a binary or octal literal as decimal digits.
  return BigInt(value.slice(0, value.length - 1)).toString() + "n";
}
