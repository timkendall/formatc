// Port of vendor/bun/src/format/html/angular/microsyntax.rs: the value of `*directive`, and the parameters of a block: `parseTemplateBindings`
// of `@angular/compiler`, and `transformTemplateBindings` of `angular-estree-parser`.
import { bytesToString } from "../../../base/bytes.ts";
import { startsWithWhiteSpace, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../../text.ts";
import { K_IDENTIFIER, K_KEYWORD, K_STRING } from "./lexer.ts";
import { AngularParser, FAILED, NgExpression } from "./parser.ts";

// A node in the `body` of an `NGMicrosyntax`.
/** `NGMicrosyntaxKey` */
export const PART_KEY: number = 0;
/** `NGMicrosyntaxExpression` */
export const PART_EXPRESSION: number = 1;
/** `NGMicrosyntaxKeyedExpression` */
export const PART_KEYED_EXPRESSION: number = 2;
/** `NGMicrosyntaxLet` */
export const PART_LET: number = 3;
/** `NGMicrosyntaxAs` */
export const PART_AS: number = 4;

export class Part {
  kind: number = PART_KEY;
  /** The name: the `name` of an `NGMicrosyntaxKey`. */
  key: string = "";
  expression: NgExpression | null = null;
  alias: string | null = null;
  /** Of a `Let`. */
  value: string | null = null;
}

/** `TemplateBindingIdentifier` */
class Identifier {
  source: string;
  /** `span.start` */
  start: number;
  constructor(source: string, start: number) {
    this.source = source;
    this.start = start;
  }
}

/** `TemplateBinding` */
class Binding {
  isExpression: boolean = true;
  /** `sourceSpan.end` (of an `ExpressionBinding`) or `sourceSpan.start` (of a `VariableBinding`). */
  pos: number = 0;
  key: Identifier = new Identifier("", 0);
  expressionValue: NgExpression | null = null;
  variableValue: Identifier | null = null;
}

/** `name.charAt(0).toUpperCase() + name.substring(1)`, or the same with `toLowerCase`. */
function withFirstInCase(name: string, isUpper: boolean): string {
  if (name.length === 0) return "";
  const cp = name.codePointAt(0) as number;
  const len = cp > 0xffff ? 2 : 1;
  // Half of a surrogate pair has no other case.
  if (len > 1 || cp === 0xfffd) return name;
  const first = name.slice(0, 1);
  return (isUpper ? first.toUpperCase() : first.toLowerCase()) + name.slice(1);
}

/** What the string at `token` stands for. */
function stringValue(ps: AngularParser, token: number): string {
  const s = ps.ts(token);
  const e = ps.te(token);
  if (e - s < 2) throw FAILED;
  const input = ps.input;
  let out = "";
  let at = s + 1;
  const end = e - 1;
  let plainStart = at;
  while (at < end) {
    if ((input[at] | 0) !== 92) {
      at = at + 1;
      continue;
    }
    out += bytesToString(input, plainStart, at);
    if (at + 1 >= end) throw FAILED;
    const escaped = input[at + 1] | 0;
    at = at + 2;
    switch (escaped) {
      case 110: out += "\n"; break;
      case 102: out += "\f"; break;
      case 114: out += "\r"; break;
      case 116: out += "\t"; break;
      case 118: out += "\v"; break;
      case 117: {
        if (at + 4 > end) throw FAILED;
        const hex = bytesToString(input, at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw FAILED;
        const cp = parseInt(hex, 16);
        // Half of a surrogate pair is nothing that can be written.
        if (cp >= 0xd800 && cp <= 0xdfff) throw FAILED;
        out += String.fromCodePoint(cp);
        at = at + 4;
        break;
      }
      default:
        // A character that is not ASCII is copied whole by the next plain run.
        if (escaped >= 0x80) at = at - 1;
        else out += String.fromCharCode(escaped);
        break;
    }
    plainStart = at;
  }
  out += bytesToString(input, plainStart, end);
  return out;
}

function expectTemplateBindingKey(ps: AngularParser): Identifier {
  let source = "";
  const start = ps.inputIndex();
  for (;;) {
    const token = ps.index;
    const k = ps.nextKind();
    if (k === K_IDENTIFIER || k === K_KEYWORD) source += ps.textOf(token);
    else if (k === K_STRING) source += stringValue(ps, token);
    else throw FAILED;
    ps.advance();
    if (!ps.consumeOptionalOperator("-")) return new Identifier(source, start);
    source += "-";
  }
}

function consumeStatementTerminator(ps: AngularParser): void {
  if (!ps.consumeOptionalCharacter(59)) ps.consumeOptionalCharacter(44);
}

function parseAsBinding(ps: AngularParser, value: Identifier): Binding | null {
  if (!ps.isKeyword("as")) return null;
  ps.advance();
  const key = expectTemplateBindingKey(ps);
  consumeStatementTerminator(ps);
  const b = new Binding();
  b.isExpression = false;
  b.pos = value.start;
  b.key = key;
  b.variableValue = value;
  return b;
}

function parseLetBinding(ps: AngularParser): Binding | null {
  if (!ps.isKeyword("let")) return null;
  const start = ps.inputIndex();
  ps.advance();
  const key = expectTemplateBindingKey(ps);
  let value: Identifier | null = null;
  if (ps.consumeOptionalOperator("=")) value = expectTemplateBindingKey(ps);
  consumeStatementTerminator(ps);
  const b = new Binding();
  b.isExpression = false;
  b.pos = start;
  b.key = key;
  b.variableValue = value;
  return b;
}

function parseDirectiveKeywordBindings(ps: AngularParser, key: Identifier, bindings: Binding[]): void {
  ps.consumeOptionalCharacter(58);
  // `getDirectiveBoundTarget`
  let value: NgExpression | null = null;
  if (!(ps.isAtEnd() || ps.isKeyword("as") || ps.isKeyword("let"))) {
    const firstToken = ps.index;
    const operand = ps.parsePipe();
    value = ps.finish(firstToken, operand, false);
  }
  let end = ps.inputIndex();
  const asBinding = parseAsBinding(ps, key);
  if (asBinding === null) {
    consumeStatementTerminator(ps);
    end = ps.inputIndex();
  }
  const b = new Binding();
  b.isExpression = true;
  b.pos = end;
  b.key = key;
  b.expressionValue = value;
  bindings.push(b);
  if (asBinding !== null) bindings.push(asBinding);
}

function parseTemplateBindings(ps: AngularParser): Binding[] {
  const bindings: Binding[] = [];
  parseDirectiveKeywordBindings(ps, new Identifier("", 0), bindings);
  while (!ps.isAtEnd()) {
    const letBinding = parseLetBinding(ps);
    if (letBinding !== null) {
      bindings.push(letBinding);
    } else {
      const key = expectTemplateBindingKey(ps);
      const asBinding = parseAsBinding(ps, key);
      if (asBinding !== null) {
        bindings.push(asBinding);
      } else {
        key.source = withFirstInCase(key.source, true);
        parseDirectiveKeywordBindings(ps, key, bindings);
      }
    }
    consumeStatementTerminator(ps);
  }
  return bindings;
}

/** The `body` of the `NGMicrosyntax` that `angular-estree-parser` makes of the text. null: Angular reports an error. */
export function parseMicrosyntax(ps: AngularParser): Part[] | null {
  try {
    return parseMicrosyntaxInner(ps);
  } catch (e) {
    if (e === FAILED) return null;
    throw e;
  }
}

function parseMicrosyntaxInner(ps: AngularParser): Part[] {
  const all = parseTemplateBindings(ps);
  let first = 0;
  if (all.length > 0 && all[0].isExpression) {
    const end = all[0].pos;
    const input = ps.input;
    if (trimJsWhitespaceStart(input, 0, end) >= end) first = 1;
  }
  const body: Part[] = [];
  // The `key.source` of the binding before, if that is an `ExpressionBinding`.
  let lastExpressionKey: string | null = null;
  for (let i = first; i < all.length; i++) {
    const index = i - first;
    const binding = all[i];
    if (binding.isExpression) {
      const name = withFirstInCase(binding.key.source, false);
      const part = new Part();
      if (binding.expressionValue === null) {
        part.kind = PART_KEY;
        part.key = name;
      } else if (index === 0) {
        part.kind = PART_EXPRESSION;
        part.expression = binding.expressionValue;
      } else {
        part.kind = PART_KEYED_EXPRESSION;
        part.key = name;
        part.expression = binding.expressionValue;
      }
      body.push(part);
      lastExpressionKey = binding.key.source;
    } else {
      const value = binding.variableValue;
      const isAlias = lastExpressionKey !== null && value !== null && lastExpressionKey === value.source;
      lastExpressionKey = null;
      if (isAlias) {
        const last = body.length > 0 ? body[body.length - 1] : null;
        if (last !== null && (last.kind === PART_EXPRESSION || last.kind === PART_KEYED_EXPRESSION)) {
          last.alias = binding.key.source;
          continue;
        }
        throw FAILED;
      }
      // `/^let\s$/.test(text.slice(start, start + 4))`
      const input = ps.input;
      const start = binding.pos;
      const isLet =
        start + 3 <= input.length &&
        (input[start] | 0) === 108 &&
        (input[start + 1] | 0) === 101 &&
        (input[start + 2] | 0) === 116 &&
        startsWithWhiteSpace(input, start + 3, input.length);
      const part = new Part();
      if (isLet) {
        part.kind = PART_LET;
        part.key = binding.key.source;
        part.value = value === null ? null : value.source;
      } else {
        if (value === null) throw FAILED;
        part.kind = PART_AS;
        part.key = value.source.length === 0 ? "$implicit" : value.source;
        part.alias = binding.key.source;
      }
      body.push(part);
    }
  }
  return body;
}

void trimJsWhitespaceEnd;
