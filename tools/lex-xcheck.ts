// Cross-checks the token boundaries of the sema lexer against TypeScript's own scanner (node_modules/typescript) on the
// vscode corpus. Both are driven with the same decisions (regex vs division by the previous token, template continuation).
//
//   node tools/lex-xcheck.ts [--limit N] [--stride K] [--tsx] [--verbose]
//
// Only runs under node (it needs the typescript package). Files our lexer refuses are skipped (and counted).
import * as fs from "node:fs";
import ts from "typescript";
import { Driver } from "./lexdriver.ts";
import { I32Vec } from "../src/sema/vec.ts";
import { T_EOF } from "../src/sema/parser/token.ts";

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) if (a[i] === name) return a[i + 1];
  return dflt;
}
const limit = parseInt(arg("--limit", "0"), 10);
const stride = parseInt(arg("--stride", "1"), 10);
const verbose = process.argv.includes("--verbose");
const withTsx = process.argv.includes("--tsx");

const K = ts.SyntaxKind;
const LAST_CONTEXTUAL: number = (K as unknown as Record<string, number>).DeferKeyword ?? K.OfKeyword;
/** TS: whether a `/` after a token of this kind starts a regex (mirrors tools/lexdriver.ts REGEX_OK). */
function tsRegexOk(k: number): boolean {
  switch (k) {
    case K.Identifier: case K.PrivateIdentifier: case K.NumericLiteral: case K.BigIntLiteral: case K.StringLiteral:
    case K.RegularExpressionLiteral: case K.NoSubstitutionTemplateLiteral: case K.TemplateTail: case K.CloseParenToken:
    case K.CloseBracketToken: case K.ThisKeyword: case K.SuperKeyword: case K.NullKeyword: case K.TrueKeyword:
    case K.FalseKeyword: case K.PlusPlusToken: case K.MinusMinusToken: case K.GreaterThanToken:
      return false;
  }
  if (k >= K.AbstractKeyword && k <= LAST_CONTEXTUAL) return k === K.OfKeyword || k === K.AwaitKeyword;
  return true;
}

/** Tokens of TypeScript's scanner as rows (start, end, kind-class) with UTF-16 positions. */
function tsTokens(text: string, out: I32Vec): void {
  const sc = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tpl: number[] = [];
  let prev: number = K.EndOfFileToken;
  let prevPostfix = false;
  let braceDepth = 0;
  while (true) {
    let k = sc.scan();
    if (k === K.EndOfFileToken) break;
    if (k === K.SlashToken || k === K.SlashEqualsToken) {
      if ((prev === K.EndOfFileToken || tsRegexOk(prev)) && !(prev === K.ExclamationToken && prevPostfix)) k = sc.reScanSlashToken();
    } else if (k === K.CloseBraceToken) {
      if (tpl.length > 0 && tpl[tpl.length - 1] === braceDepth) {
        k = sc.reScanTemplateToken(false);
        if (k === K.TemplateTail) tpl.pop();
      } else braceDepth--;
    } else if (k === K.OpenBraceToken) braceDepth++;
    else if (k === K.TemplateHead) tpl.push(braceDepth);
    out.push3(sc.getTokenStart(), sc.getTokenEnd(), k);
    prevPostfix = k === K.ExclamationToken && prev !== K.EndOfFileToken && !tsRegexOk(prev);
    prev = k;
  }
}


// ───────── TS side of the JSX driver (mirrors tools/lexdriver.ts: lexExpr / jsxElement / jsxChildren) ─────────
class TsDriver {
  sc: ts.Scanner;
  out: I32Vec;
  tpl: number[] = [];
  isJsx: boolean;
  constructor(text: string, out: I32Vec, isJsx: boolean) {
    this.sc = ts.createScanner(ts.ScriptTarget.Latest, true, isJsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
    this.out = out;
    this.isJsx = isJsx;
    this.text = text;
  }
  rec(k: number): void {
    let start = this.sc.getTokenStart();
    const end = this.sc.getTokenEnd();
    if (k === K.StringLiteral && this.inAttr) {
      // scanJsxAttributeValue does not update tokenStart (it is that of the `=`): the string starts at its opening quote
      start = this.text.lastIndexOf(this.text[end - 1], end - 2);
    }
    this.out.push3(start, end, k);
  }
  inAttr = false;
  text = "";
  run(): void {
    this.sc.scan();
    this.lexExpr(0);
  }
  lexExpr(nested: number): void {
    const sc = this.sc;
    let prev: number = K.EndOfFileToken;
    let prevPostfix = false;
    let braceDepth = 0;
    const base = this.tpl.length;
    while (true) {
      let k = sc.getToken();
      if (k === K.EndOfFileToken) break;
      if (k === K.SlashToken || k === K.SlashEqualsToken) {
        if ((prev === K.EndOfFileToken || tsRegexOk(prev)) && !(prev === K.ExclamationToken && prevPostfix)) k = sc.reScanSlashToken();
      } else if (k === K.CloseBraceToken) {
        if (this.tpl.length > base && this.tpl[this.tpl.length - 1] === braceDepth) {
          k = sc.reScanTemplateToken(false);
          if (k === K.TemplateTail) this.tpl.pop();
        } else if (nested > 0 && braceDepth === 0) {
          this.rec(k);
          return;
        } else braceDepth--;
      } else if (k === K.OpenBraceToken) braceDepth++;
      else if (k === K.TemplateHead) this.tpl.push(braceDepth);
      else if (k === K.LessThanToken && this.isJsx && (prev === K.EndOfFileToken || tsRegexOk(prev)) && prev !== K.CloseBraceToken) {
        if (this.jsxElement()) {
          sc.scan();
          prev = K.CloseParenToken;
          continue;
        }
      }
      this.rec(k);
      prevPostfix = k === K.ExclamationToken && prev !== K.EndOfFileToken && !tsRegexOk(prev);
      prev = k;
      sc.scan();
    }
    this.rec(K.EndOfFileToken);
  }
  isIdOrKw(k: number): boolean {
    return k === K.Identifier || (k >= K.FirstKeyword && k <= K.LastKeyword);
  }
  jsxElement(): boolean {
    const sc = this.sc;
    this.rec(K.LessThanToken);
    sc.scan();
    if (sc.getToken() === K.GreaterThanToken) return this.jsxChildren(true);
    if (this.isIdOrKw(sc.getToken())) {
      sc.scanJsxIdentifier();
      this.rec(K.Identifier);
      sc.scan();
      while (sc.getToken() === K.DotToken || sc.getToken() === K.ColonToken) {
        this.rec(sc.getToken());
        sc.scan();
        if (this.isIdOrKw(sc.getToken())) {
          sc.scanJsxIdentifier();
          this.rec(K.Identifier);
          sc.scan();
        }
      }
    }
    while (true) {
      const t = sc.getToken();
      if (t === K.EndOfFileToken) return true;
      if (t === K.SlashToken) {
        this.rec(t);
        sc.scan();
        if (sc.getToken() === K.GreaterThanToken) {
          this.rec(K.GreaterThanToken);
          return true;
        }
        continue;
      }
      if (t === K.GreaterThanToken) {
        this.rec(t);
        return this.jsxChildren(false);
      }
      if (t === K.OpenBraceToken) {
        this.rec(t);
        sc.scan();
        this.lexExpr(1);
        sc.scan();
        continue;
      }
      if (this.isIdOrKw(t)) {
        sc.scanJsxIdentifier();
        this.rec(K.Identifier);
        sc.scan();
        while (sc.getToken() === K.ColonToken) {
          this.rec(K.ColonToken);
          sc.scan();
          if (this.isIdOrKw(sc.getToken())) {
            sc.scanJsxIdentifier();
            this.rec(K.Identifier);
            sc.scan();
          }
        }
        if (sc.getToken() === K.EqualsToken) {
          this.rec(K.EqualsToken);
          const v = sc.scanJsxAttributeValue();
          this.inAttr = true;
          if (v === K.OpenBraceToken) {
            this.inAttr = false;
            this.rec(v);
            sc.scan();
            this.lexExpr(1);
            sc.scan();
          } else {
            this.rec(v);
            this.inAttr = false;
            sc.scan();
          }
        }
        continue;
      }
      return true;
    }
  }
  jsxChildren(isFragmentStart: boolean): boolean {
    const sc = this.sc;
    if (isFragmentStart) this.rec(K.GreaterThanToken);
    while (true) {
      // our nextJsxChild scans from the end of the last token; TS: scan something, then rescan from fullStartPos
      sc.scan();
      const t = sc.reScanJsxToken(true);
      if (t === K.EndOfFileToken) return true;
      if (t === K.JsxText || t === K.JsxTextAllWhiteSpaces) {
        if (t === K.JsxTextAllWhiteSpaces) continue;
        this.rec(t);
        continue;
      }
      if (t === K.OpenBraceToken) {
        this.rec(t);
        sc.scan();
        this.lexExpr(1);
        continue;
      }
      if (t === K.LessThanToken) {
        this.jsxElement();
        continue;
      }
      if (t === K.LessThanSlashToken) {
        this.rec(t);
        sc.scan();
        while (sc.getToken() !== K.GreaterThanToken && sc.getToken() !== K.EndOfFileToken) {
          if (this.isIdOrKw(sc.getToken())) sc.scanJsxIdentifier();
          this.rec(sc.getToken());
          sc.scan();
        }
        if (sc.getToken() === K.GreaterThanToken) this.rec(sc.getToken());
        return true;
      }
      return true;
    }
  }
}

const lines = fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n");
const d = new Driver();
d.verify = true;
const mine = new I32Vec(1 << 16);
const theirs = new I32Vec(1 << 16);
let dupAtoms = 0;
let files = 0, refused = 0, mismatches = 0, tokensCompared = 0, skippedTsx = 0;
let seen = 0;
for (const p of lines) {
  if (!(p.endsWith(".ts") || p.endsWith(".js") || p.endsWith(".mts") || p.endsWith(".mjs") || p.endsWith(".cjs") || (withTsx && p.endsWith(".tsx")))) {
    if (p.endsWith(".tsx")) skippedTsx++;
    continue;
  }
  if (seen++ % stride !== 0) continue;
  if (limit && files >= limit) break;
  const buf = fs.readFileSync("bench/vscode/" + p);
  files++;
  mine.reset();
  theirs.reset();
  d.rec = mine;
  d.run(buf, buf.length, p.endsWith("x"));
  {
    // every atom of the file has a distinct text
    const seenTexts = new Map<string, number>();
    const nm = d.names;
    for (let a = 0; a < nm.count; a++) {
      const tb = nm.textBuf(a);
      const t = Buffer.from(tb.buffer, tb.byteOffset + nm.textStart(a), nm.textLen(a)).toString("latin1");
      if (seenTexts.has(t)) { dupAtoms++; if (dupAtoms < 5) console.log("DUPLICATE ATOM", p, JSON.stringify(t), seenTexts.get(t), a); }
      else seenTexts.set(t, a);
    }
  }
  if (d.lx.refusal !== 0) { refused++; if (verbose) console.log("refused", p); continue; }
  const text = buf.toString("utf8");
  if (p.endsWith("x")) new TsDriver(text, theirs, true).run(); else tsTokens(text, theirs);
  // byte offset -> utf16 index
  let map: Int32Array | null = null;
  if (text.length !== buf.length) {
    map = new Int32Array(buf.length + 1).fill(-1);
    let b = 0;
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!;
      map[b] = i;
      b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      i += cp >= 0x10000 ? 2 : 1;
    }
    map[b] = text.length;
  }
  // our rows include the EOF row at the end
  const nm = (mine.len / 3) - 1;
  const nt = theirs.len / 3 - (p.endsWith("x") ? 1 : 0);
  let bad = -1;
  const n = Math.min(nm, nt);
  for (let i = 0; i < n; i++) {
    let s = 0, e = 0;
    s = mine.data[i * 3 + 1]; e = mine.data[i * 3 + 2];
    if (map) { s = map[s]; e = map[e]; }
    if (s !== theirs.data[i * 3] || e !== theirs.data[i * 3 + 1]) { bad = i; break; }
  }
  tokensCompared += n;
  if (bad < 0 && nm !== nt) bad = n;
  if (bad >= 0) {
    mismatches++;
    if (mismatches <= 20) {
      const s = mine.data[bad * 3 + 1], e = mine.data[bad * 3 + 2];
      const ts_ = theirs.data[bad * 3], te = theirs.data[bad * 3 + 1];
      console.log("MISMATCH", p, "token", bad, "mine", s, e, "kind", mine.data[bad * 3], "ts", ts_, te, "kind", ts.SyntaxKind[theirs.data[bad * 3 + 2]], "counts", nm, nt);
      const at = ts_ >= 0 ? ts_ : 0;
      console.log("   ", JSON.stringify(text.slice(Math.max(0, at - 40), at + 40)));
    }
  }
}
console.log({ files, refused, mismatches, tokensCompared, skippedTsx, badAtoms: d.badAtoms, dupAtoms });
void T_EOF;
