// The token-loop driver shared by lex-vscode.ts, lex-xcheck.ts and lex-refusals.ts: makes the decisions a parser would make
// (regex vs division, template continuation, JSX) with simple heuristics.
import { Lexer } from "../src/sema/parser/lexer.ts";
import { Names } from "../src/sema/parser/names.ts";
import { refusalName } from "../src/sema/parser/lib.ts";
import {
  T_BIG_INT, T_CLOSE_BRACE, T_CLOSE_BRACKET, T_CLOSE_PAREN, T_COUNT, T_EOF, T_GREATER_THAN, T_IDENTIFIER, T_JSX_TEXT,
  T_LESS_THAN, T_LESS_THAN_SLASH, T_NO_SUBSTITUTION_TEMPLATE, T_NUMBER, T_OPEN_BRACE, T_PRIVATE_IDENTIFIER, T_REGEX, T_SLASH,
  T_SLASH_EQUALS, T_STRING, T_TEMPLATE_HEAD, T_TEMPLATE_MIDDLE, T_TEMPLATE_TAIL, T_THIS, T_SUPER, T_NULL, T_TRUE, T_FALSE,
  T_PLUS_PLUS, T_MINUS_MINUS, T_EXCLAMATION, T_DOT, T_QUESTION_DOT, T_DOT_DOT_DOT, T_EQUALS_GREATER_THAN, T_OPEN_PAREN, T_COMMA, T_SEMICOLON, T_COLON,
  T_EQUALS, T_QUESTION, T_OPEN_BRACKET, T_BREAK, T_WITH, T_ABSTRACT, T_OF, T_AWAIT, T_YIELD, T_RETURN, T_TYPE_OF, T_VOID, T_DELETE, T_CASE, T_IN, T_INSTANCE_OF, T_NEW, T_ELSE, T_DO, T_THROW,
  isAssignmentOperator, isIdentifierOrKeyword,
} from "../src/sema/parser/token.ts";
import { I32Vec } from "../src/sema/vec.ts";

// ───────────────────────── the driver ─────────────────────────

/** 1 if a `/` after this token starts a regular expression. */
const REGEX_OK = new Uint8Array(T_COUNT);
for (let t = 0; t < T_COUNT; t++) {
  let ok = true;
  if (t === T_CLOSE_PAREN || t === T_CLOSE_BRACKET || t === T_NUMBER || t === T_BIG_INT || t === T_STRING || t === T_REGEX) ok = false;
  else if (t === T_NO_SUBSTITUTION_TEMPLATE || t === T_TEMPLATE_TAIL || t === T_PRIVATE_IDENTIFIER || t === T_JSX_TEXT) ok = false;
  else if (t === T_IDENTIFIER || t === T_THIS || t === T_SUPER || t === T_NULL || t === T_TRUE || t === T_FALSE) ok = false;
  else if (t === T_PLUS_PLUS || t === T_MINUS_MINUS) ok = false;
  else if (t >= T_ABSTRACT && t !== T_OF && t !== T_AWAIT && t !== T_YIELD) ok = false; // contextual keywords are names
  REGEX_OK[t] = ok ? 1 : 0;
}
// `}` of a block, `>` of a type argument list: both are rare before a division; treat as expression starts like tsc's heuristics do not.
REGEX_OK[T_CLOSE_BRACE] = 1;
REGEX_OK[T_GREATER_THAN] = 0;
// reserved words that end an expression
REGEX_OK[T_THIS] = 0;

export class Driver {
  lx: Lexer;
  names: Names;
  tpl: I32Vec;
  jsxDepth: number = 0;
  tokens: number = 0;
  /** When recording: rows (kind class, start, end) */
  rec: I32Vec | null = null;
  constructor() {
    this.names = new Names();
    this.lx = new Lexer(this.names);
    this.tpl = new I32Vec(64);
  }

  /** Debug: check the atom of every name / plain string token against the source bytes. */
  verify: boolean = false;
  badAtoms: number = 0;

  record(): void {
    const rec = this.rec;
    if (rec !== null) rec.push3(this.lx.token, this.lx.start, this.lx.end);
    if (this.verify) this.checkAtom();
  }

  checkAtom(): void {
    const lx = this.lx;
    const t = lx.token;
    let from = lx.start;
    let to = lx.end;
    if (t === T_STRING) {
      from = (from + 1) | 0;
      to = (to - 1) | 0;
      // only strings without escapes: the atom is the bytes between the quotes
      for (let i = from; i < to; i++) if ((lx.src[i] | 0) === 92) return;
    } else if (!(t >= T_IDENTIFIER)) {
      return;
    } else if (t === T_PRIVATE_IDENTIFIER) {
      // atom is "#name" in source
    }
    // names with escapes or non-ascii are decoded: only compare ASCII names
    for (let i = from; i < to; i++) if ((lx.src[i] | 0) >= 0x80 || (lx.src[i] | 0) === 92) return;
    const a = lx.atom;
    const n = lx.names;
    let ok = a >= 0 && n.textLen(a) === to - from;
    if (ok) {
      const buf = n.textBuf(a);
      const off = n.textStart(a);
      for (let i = 0; i < to - from; i++) {
        if ((buf[off + i] | 0) !== (lx.src[from + i] | 0)) {
          ok = false;
          break;
        }
      }
    }
    if (ok && t >= T_IDENTIFIER && t !== T_PRIVATE_IDENTIFIER && t !== T_STRING) {
      // the token kind is a function of the text
      const kw = n.atomToken(a);
      if (kw !== t && t !== T_IDENTIFIER) ok = false; // scanJsxIdentifier turns keywords into identifiers
    }
    if (!ok) {
      this.badAtoms = (this.badAtoms + 1) | 0;
    }
  }

  /** Lexes `src[0, len)` to EOF. Returns the number of tokens; refusal in `lx.refusal`. */
  run(src: Uint8Array, len: number, isJsx: boolean): number {
    const lx = this.lx;
    lx.begin(src, len);
    lx.configure(0, isJsx, false, false, false);
    this.tpl.reset();
    this.tokens = 0;
    lx.next();
    this.lexExpr(isJsx, 0);
    return this.tokens;
  }

  /**
   * Runs the token loop. At depth > 0 (inside `{ ... }` of a JSX expression container) returns at the matching `}`.
   * Returns when EOF is reached (or a refusal).
   */
  lexExpr(isJsx: boolean, nested: number): void {
    const lx = this.lx;
    const tpl = this.tpl;
    const recording = this.rec !== null;
    let prev = T_EOF;
    let prevIsPostfix = false;
    let braceDepth = 0;
    let count = 0;
    const base = tpl.len;
    while (true) {
      let tok = lx.token;
      if (tok === T_EOF) break;
      if (tok === T_SLASH || tok === T_SLASH_EQUALS) {
        if ((REGEX_OK[prev] | 0) !== 0 && !(prev === T_EXCLAMATION && prevIsPostfix)) {
          lx.rescanSlash();
          tok = lx.token;
        }
      } else if (tok === T_CLOSE_BRACE) {
        if (tpl.len > base && (tpl.last() | 0) === braceDepth) {
          lx.rescanTemplateContinuation();
          tok = lx.token;
          if (tok === T_TEMPLATE_TAIL) tpl.pop();
        } else if (nested > 0 && braceDepth === 0) {
          // the `}` of the JSX expression container
          this.tokens = (this.tokens + count + 1) | 0;
          this.record();
          return;
        } else {
          braceDepth = (braceDepth - 1) | 0;
        }
      } else if (tok === T_OPEN_BRACE) {
        braceDepth = (braceDepth + 1) | 0;
      } else if (tok === T_TEMPLATE_HEAD) {
        tpl.push(braceDepth);
      } else if (tok === T_LESS_THAN && isJsx && (REGEX_OK[prev] | 0) !== 0 && prev !== T_CLOSE_BRACE) {
        // `<` where an expression starts: a JSX element (or fragment)
        this.tokens = (this.tokens + count) | 0;
        count = 0;
        if (this.jsxElement()) {
          lx.next(); // jsxElement leaves the lexer on the last token of the element
          prev = T_CLOSE_PAREN; // an expression has ended
          continue;
        }
      }
      count = ((count | 0) + 1) | 0;
      if (recording) this.record();
      // `x!` (non-null assertion) is postfix when an expression has just ended
      prevIsPostfix = tok === T_EXCLAMATION && (REGEX_OK[prev] | 0) === 0;
      prev = tok;
      lx.next();
    }
    // EOF counts as a token
    this.tokens = (this.tokens + count + 1) | 0;
    this.record();
  }

  /** At a `<` that opens a JSX element. Scans the element and leaves the lexer at the token after it. Returns false if it was not one. */
  jsxElement(): boolean {
    const lx = this.lx;
    this.tokens = (this.tokens + 1) | 0;
    this.record(); // `<`
    lx.next();
    // tag name (or fragment)
    if (lx.token === T_GREATER_THAN) {
      // fragment: `<>`
      return this.jsxChildren(true);
    }
    if (isIdentifierOrKeyword(lx.token)) {
      lx.scanJsxIdentifier();
      this.tokens = (this.tokens + 1) | 0;
      this.record();
      lx.next();
      // member / namespace names: a.b.c, a:b
      while (lx.token === T_DOT || lx.token === T_COLON) {
        this.tokens = (this.tokens + 1) | 0;
        this.record();
        lx.next();
        if (isIdentifierOrKeyword(lx.token)) {
          lx.scanJsxIdentifier();
          this.tokens = (this.tokens + 1) | 0;
          this.record();
          lx.next();
        }
      }
    }
    // type arguments `<T>` are not handled (rare in tsx files)
    // attributes
    while (true) {
      const t = lx.token;
      if (t === T_EOF) return true;
      if (t === T_SLASH) {
        this.tokens = (this.tokens + 1) | 0;
        this.record();
        lx.next();
        if (lx.token === T_GREATER_THAN) {
          this.tokens = (this.tokens + 1) | 0;
          this.record();
          return true;
        }
        continue;
      }
      if (t === T_GREATER_THAN) {
        // children follow; do NOT advance with next(): nextJsxChild scans from the end of this token
        this.tokens = (this.tokens + 1) | 0;
        this.record();
        return this.jsxChildren(false);
      }
      if (t === T_OPEN_BRACE) {
        // `{...spread}` attribute
        this.tokens = (this.tokens + 1) | 0;
        this.record();
        lx.next();
        this.lexExpr(true, 1);
        lx.next();
        continue;
      }
      if (isIdentifierOrKeyword(t)) {
        lx.scanJsxIdentifier();
        this.tokens = (this.tokens + 1) | 0;
        this.record();
        lx.next();
        while (lx.token === T_COLON) {
          this.tokens = (this.tokens + 1) | 0;
          this.record();
          lx.next();
          if (isIdentifierOrKeyword(lx.token)) {
            lx.scanJsxIdentifier();
            this.tokens = (this.tokens + 1) | 0;
            this.record();
            lx.next();
          }
        }
        if (lx.token === T_EQUALS) {
          this.tokens = (this.tokens + 1) | 0;
          this.record();
          lx.scanJsxAttributeValue();
          if (lx.token === T_OPEN_BRACE) {
            this.tokens = (this.tokens + 1) | 0;
            this.record();
            lx.next();
            this.lexExpr(true, 1);
            lx.next();
          } else {
            this.tokens = (this.tokens + 1) | 0;
            this.record();
            lx.next();
          }
        }
        continue;
      }
      // anything else: give up on the element
      return true;
    }
  }

  /** After the `>` of an opening element/fragment (the current token): children until the matching closing tag. */
  jsxChildren(isFragmentStart: boolean): boolean {
    const lx = this.lx;
    if (isFragmentStart) {
      this.tokens = (this.tokens + 1) | 0;
      this.record(); // the `>` of `<>`
    }
    while (true) {
      lx.nextJsxChild();
      const t = lx.token;
      if (t === T_EOF) return true;
      if (t === T_JSX_TEXT) {
        this.tokens = (this.tokens + 1) | 0;
        this.record();
        continue;
      }
      if (t === T_OPEN_BRACE) {
        this.tokens = (this.tokens + 1) | 0;
        this.record();
        lx.next();
        this.lexExpr(true, 1);
        continue;
      }
      if (t === T_LESS_THAN) {
        // nested element: `jsxElement` records `<` itself, so undo nothing: it starts at the current `<`
        this.jsxElement();
        // after the nested element the lexer sits at the token after it; for children we need to continue from the end of the
        // element, which is the end of the last token consumed
        continue;
      }
      if (t === T_LESS_THAN_SLASH) {
        // closing tag: `</` name `>`
        this.tokens = (this.tokens + 1) | 0;
        this.record();
        lx.next();
        while (lx.token !== T_GREATER_THAN && lx.token !== T_EOF) {
          if (isIdentifierOrKeyword(lx.token)) lx.scanJsxIdentifier();
          this.tokens = (this.tokens + 1) | 0;
          this.record();
          lx.next();
        }
        if (lx.token === T_GREATER_THAN) {
          this.tokens = (this.tokens + 1) | 0;
          this.record();
        }
        return true;
      }
      return true;
    }
  }
}

