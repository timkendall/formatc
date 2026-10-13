// Hand-checked values of the handle layer on small inputs. Runs under node and compiled:
//   node tools/ast-unit.ts        scriptc build tools/ast-unit.ts -o /tmp/ast-unit && /tmp/ast-unit
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { names } from "../src/sema/parser/parser/mod.ts";
import * as A from "../src/lint/ast/index.ts";
import { Bytes, I32Vec } from "../src/sema/vec.ts";

const hir = A.hir;
const SP = A.SP;
let fails = 0;
let checks = 0;

function eq(name: string, got: string, want: string): void {
  checks++;
  if (got !== want) {
    fails++;
    console.log("FAIL", name, "got", got, "want", want);
  }
}
function eqn(name: string, got: number, want: number): void {
  eq(name, String(got), String(want));
}

function parse(text: string, path: string): void {
  const b = Buffer.from(text, "utf8");
  const src = new Uint8Array(b.length + 16);
  src.set(b);
  const r = parseFile(src, b.length, path, false);
  if (r !== 0) {
    console.log("REFUSED", text);
    fails++;
    return;
  }
  A.fileBegin(names, path.endsWith(".ts") || path.endsWith(".tsx"), true);
}

function slice(s: number, e: number): string {
  return Buffer.from(hir.text.subarray(s, e)).toString("utf8");
}
function spanText(): string {
  return slice(SP[0], SP[1]);
}
function atomText(a: number): string {
  return a < 0 ? "-" : names.atomString(a);
}
/** The first expression with the tag `tag` whose text is `text`. */
function findExpr(tag: number, text: string): number {
  for (let e = 0; e < hir.nExprs; e++) {
    if (A.exprTag(e) !== tag) continue;
    A.exprSpan(e);
    if (spanText() === text) return e;
  }
  return -1;
}

function main(): void {
  // ───── expressions: spans, parentheses, operators
  parse("const x = (a + b) * c, y = ((d));\nx++; a += 1; !a; typeof b;", "a.ts");
  let e = findExpr(A.EXPR_BINARY, "a + b");
  A.exprOuterSpan(e);
  eq("outer of (a + b)", spanText(), "(a + b)");
  eqn("paren count", A.exprParenCount(e), 1);
  eq("is parenthesized", String(A.exprIsParenthesized(e)), "true");
  A.exprOperatorSpan(e);
  eq("operator of a + b", spanText(), "+");
  e = findExpr(A.EXPR_IDENT, "d");
  A.exprOuterSpan(e);
  eq("outer of ((d))", spanText(), "((d))");
  eqn("paren count 2", A.exprParenCount(e), 2);
  e = findExpr(A.EXPR_UNARY, "x++");
  A.exprOperatorSpan(e);
  eq("operator of x++", spanText(), "++");
  e = findExpr(A.EXPR_ASSIGN, "a += 1");
  A.exprOperatorSpan(e);
  eq("operator of a += 1", spanText(), "+=");
  eq("assign op text", A.assignOpText(A.exprAssignOpOf(e)), "+=");
  eq("assign op text &&=", A.assignOpText(A.BIN_AND + 1), "&&=");
  eq("assign op text ??=", A.assignOpText(A.BIN_NULLISH + 1), "??=");
  eq("assign op text =", A.assignOpText(0), "=");
  e = findExpr(A.EXPR_UNARY, "typeof b");
  A.exprOperatorSpan(e);
  eq("operator of typeof", spanText(), "typeof");

  // ───── optional chains
  parse("a?.b.c(); (a?.b).c; a?.[0]!; x.y.z;", "a.ts");
  e = findExpr(A.EXPR_CALL, "a?.b.c()");
  eq("chain root of a?.b.c()", String(A.exprIsChainRoot(e)), "true");
  eq("in optional chain", String(A.exprIsInOptionalChain(e)), "true");
  e = findExpr(A.EXPR_DOT, "a?.b.c");
  eq("a?.b.c is not the root", String(A.exprIsChainRoot(e)), "false");
  e = findExpr(A.EXPR_DOT, "a?.b");
  eq("a?.b (first, inside the call) is in the chain", String(A.exprIsInOptionalChain(e)), "true");
  eq("is optional", String(A.exprIsOptional(e)), "true");
  e = findExpr(A.EXPR_DOT, "x.y.z");
  eq("x.y.z not in a chain", String(A.exprIsInOptionalChain(e)), "false");
  e = findExpr(A.EXPR_NON_NULL, "a?.[0]!");
  eq("a?.[0]! chain root", String(A.exprIsChainRoot(e)), "true");
  eqn("non null count", A.exprNonNullCount(e), 1);

  // ───── templates
  parse("const t = `a${b}c${d}e`; const u = `plain`; tag`x\\u{zz}${y}`;", "a.ts");
  e = findExpr(A.EXPR_TEMPLATE, "`a${b}c${d}e`");
  eqn("quasi count", A.exprTemplateQuasiCount(e), 3);
  A.exprTemplateQuasiSpan(e, 0);
  eq("quasi 0", spanText(), "`a${");
  A.exprTemplateQuasiSpan(e, 1);
  eq("quasi 1", spanText(), "}c${");
  A.exprTemplateQuasiSpan(e, 2);
  eq("quasi 2", spanText(), "}e`");
  A.exprTemplateRawSpan(e, 1);
  eq("raw 1", spanText(), "c");
  eq("cooked 1", atomText(A.exprTemplateCooked(e, 1)), "c");
  e = findExpr(A.EXPR_TEMPLATE, "`plain`");
  eqn("plain template: exprs", A.exprTemplateExprsLen(e), 0);
  eq("plain template: static", atomText(A.exprTemplateAsStatic(e)), "plain");
  eq("plain template is a template (not a string)", String(A.exprAsString(e)), "-1");
  e = findExpr(A.EXPR_TEMPLATE, "`x\\u{zz}${y}`");
  eq("invalid escape: cooked is none", String(A.exprTemplateCooked(e, 0)), "-1");

  // ───── regex, numbers, strings
  parse("const r = /a[/]b/gi; const n = 0x10; const s = 'it\\'s'; const q = \"q\";", "a.ts");
  e = findExpr(A.EXPR_REGEX, "/a[/]b/gi");
  A.exprRegexPatternSpan(e);
  eq("regex pattern", spanText(), "a[/]b");
  A.exprRegexFlagsSpan(e);
  eq("regex flags", spanText(), "gi");
  e = findExpr(A.EXPR_NUMBER, "0x10");
  eqn("number value", A.exprNumberValue(e), 16);
  e = findExpr(A.EXPR_STRING, "'it\\'s'");
  eq("string value", atomText(A.exprStringValue(e)), "it's");

  // ───── JSX
  parse("const j = <a.b x=\"1&amp;2\" {...p}>\n  text &lt; {v}\n  <c-d/>\n</a.b>;\nconst f = <>hi</>;", "a.tsx");
  e = findExpr(A.EXPR_JSX, "<a.b x=\"1&amp;2\" {...p}>\n  text &lt; {v}\n  <c-d/>\n</a.b>");
  A.jsxOpeningSpan(e);
  eq("jsx opening", spanText(), "<a.b x=\"1&amp;2\" {...p}>");
  eq("jsx closing", String(A.jsxClosingSpan(e)), "true");
  eq("jsx closing text", spanText(), "</a.b>");
  eqn("jsx attrs", A.jsxAttrsLen(e), 2);
  const attr0 = A.listAt(A.jsxAttrsStart(e), 0);
  eq("jsx attribute", String(A.propIsJsxAttribute(attr0)), "true");
  const val = A.propValue(attr0);
  eq("jsx attribute string", String(A.exprIsJsxAttributeString(val)), "true");
  eq("jsx attribute value decoded", atomText(A.exprStringValue(val)), "1&2");
  const kids = new I32Vec(16);
  A.jsxChildrenWithWhitespace(e, kids);
  const rows: string[] = [];
  for (let i = 0; i < kids.len; i += 3) {
    const k = kids.data[i] | 0;
    if (k === A.JC_EXPR) rows.push("E:" + A.exprTag(kids.data[i + 1] | 0));
    else rows.push("W:" + JSON.stringify(slice(kids.data[i + 1] | 0, kids.data[i + 2] | 0)));
  }
  eq("jsx children with whitespace", rows.join(" "), "E:" + A.EXPR_STRING + " E:" + A.EXPR_IDENT + " W:\"\\n  \" E:" + A.EXPR_JSX + " W:\"\\n\"");
  const text0 = A.listAt(A.jsxChildrenStart(e), 0);
  eq("jsx text", String(A.exprIsJsxText(text0)), "true");
  const bytes = new Bytes(16);
  eq("jsx text value", String(A.exprJsxTextValue(text0, bytes)), "true");
  eq("jsx text value text", slice(0, 0) + Buffer.from(bytes.data.subarray(0, bytes.len)).toString(), "\n  text < ");
  e = findExpr(A.EXPR_DOT, "a.b");
  eq("jsx tag name (a.b)", String(A.exprIsJsxTagName(e)), "true");
  e = findExpr(A.EXPR_JSX, "<>hi</>");
  eq("fragment", String(A.jsxIsFragment(e)), "true");

  // ───── statements: directives, wrappers, semicolons, export spans
  parse("'use strict';\n\"other\";\nfunction f() { 'use asm'; x; }\nfor (a of b) ;\nexport default class {}\nexport const q = 1;", "a.ts");
  let s = A.listAt(hir.bodyStart, 0);
  eq("directive", String(A.stmtDirectiveSpan(s)), "true");
  eq("directive text", spanText(), "use strict");
  s = A.listAt(hir.bodyStart, 1);
  eq("second directive", String(A.stmtDirectiveSpan(s)), "true");
  eq("second directive text", spanText(), "other");
  s = A.listAt(hir.bodyStart, 2);
  eq("f is not a directive", String(A.stmtDirectiveSpan(s)), "false");
  eq("semicolon of a function declaration", String(A.stmtSemicolon(s)), "false");
  s = A.listAt(hir.bodyStart, 4);
  eq("export default class", String(A.stmtIsDefaultExport(s)), "true");
  eq("export span", String(A.stmtExportSpan(s)), "true");
  eq("export span text", spanText(), "export default class {}");
  A.stmtSpanWithoutExport(s);
  eq("span without export", spanText(), "class {}");
  s = A.listAt(hir.bodyStart, 5);
  A.stmtSpanWithoutExport(s);
  eq("span without export 2", spanText(), "const q = 1;");
  eq("semicolon of a declaration", String(A.stmtSemicolon(s)), "true");
  s = A.listAt(hir.bodyStart, 3);
  const head = A.stmtForOfLeft(s);
  eq("for-of head wrapper", String(A.stmtIsWrapper(head)), "true");
  eq("for-of head parent is the for", String(A.nodeParent(A.nodeOfExpr(A.stmtAsExpr(head))) === A.nodeOfStmt(s)), "true");

  // ───── patterns and params
  parse("function g(this: Foo, a?: number, { b, c: [d = 1] }: T = {}, ...r: R[]): void {}", "a.ts");
  const f = 0;
  eq("this param", String(A.funcThisParam(f) >= 0), "true");
  eqn("params", A.funcParamsLen(f), 3);
  const p1 = A.listAt(A.funcParamsStart(f), 1);
  A.paramBindingSpan(p1);
  eq("param binding span", spanText(), "{ b, c: [d = 1] }: T");
  A.paramSpan(p1);
  eq("param span", spanText(), "{ b, c: [d = 1] }: T = {}");
  const p0 = A.listAt(A.funcParamsStart(f), 0);
  A.paramBindingSpan(p0);
  eq("optional param binding span", spanText(), "a?: number");
  const binds = new I32Vec(8);
  A.patBindings(A.paramPat(p1), binds);
  const bn: string[] = [];
  for (let i = 0; i < binds.len; i++) bn.push(atomText(A.patIdentName(binds.data[i] | 0)));
  eq("bindings", bn.join(","), "b,d");
  A.funcParamsSpan(f);
  eq("params span", spanText(), "(this: Foo, a?: number, { b, c: [d = 1] }: T = {}, ...r: R[])");

  // ───── keys
  parse("class K { 1n = 0; 0b11 = 1; 'a b' = 2; [x + 1] = 3; static #p; }\nconst o = { 'q': 1, 2: 2, [k]: 3, m() {}, get g() { return 1 }, s, ...r };", "a.ts");
  const kinds: string[] = [];
  for (let m = 0; m < hir.nMembers; m++) {
    const k = A.nodeOfMember(m);
    const kind = A.keyKind(k);
    kinds.push(kind + ":" + (kind >= 0 && kind !== A.KEY_COMPUTED ? atomText(A.keyName(k)) : "-"));
  }
  eq("member keys", kinds.join(" "), "2:1 2:3 1:a b 6:- 3:#p");
  const pk: string[] = [];
  for (let p = 0; p < hir.nProps; p++) {
    const kind = A.keyKind(A.nodeOfProp(p));
    pk.push(String(kind));
  }
  eq("prop keys", pk.join(" "), "1 2 6 0 0 0 -1");

  // ───── imports and exports
  parse("import a, { b as c, type d } from 'm' with { type: 'json' };\nimport * as ns from \"n\";\nexport { x as y, z };\nexport * from 'o';\nimport e = require('p');", "a.ts");
  s = A.listAt(hir.bodyStart, 0);
  eq("module specifier", String(A.stmtModuleSpecifierSpan(s)), "true");
  eq("module specifier text", spanText(), "'m'");
  const row = A.stmtImportAttributes(s);
  eq("import attributes", String(row >= 0), "true");
  A.importAttributesKeywordSpan(row);
  eq("attributes keyword", spanText(), "with");
  A.importAttributesBracesSpan(row);
  eq("attributes braces", spanText(), "{ type: 'json' }");
  eqn("attribute entries", A.importAttributesEntriesLen(row), 1);
  const imp = A.stmtImportImport(s);
  eqn("named imports", A.importNamedLen(imp), 2);
  const sp1 = A.listAt(A.importNamedStart(imp), 0);
  eq("renamed", String(A.importSpecIsRenamed(sp1)), "true");
  const sp2 = A.listAt(A.importNamedStart(imp), 1);
  eq("type only", String(A.importSpecIsTypeOnly(sp2)), "true");
  s = A.listAt(hir.bodyStart, 1);
  const imp2 = A.stmtImportImport(s);
  A.importNamespaceSpan(imp2);
  eq("namespace span", spanText(), "* as ns");
  s = A.listAt(hir.bodyStart, 4);
  eq("import equals require span", String(A.importEqualsRequireSpan(A.stmtImportEqualsImportEquals(s))), "true");
  eq("import equals require text", spanText(), "require('p')");

  // ───── classes, members, parameters properties
  parse("export abstract class C<T> extends B<T> implements I { constructor(private readonly p: string, q = 1) { super(); } static async *m() {} }", "a.ts");
  A.classBodySpan(0);
  eq("class body", spanText().slice(0, 13), "{ constructor");
  const ctor = A.listAt(A.classMembersStart(0), 0);
  eq("is constructor", String(A.memberIsConstructor(ctor)), "true");
  const cf = A.memberFunc(ctor);
  const cp = A.listAt(A.funcParamsStart(cf), 0);
  eq("parameter property", String(A.paramIsParameterProperty(cp)), "true");
  A.paramSpanWithoutModifiers(cp);
  eq("param without modifiers", spanText(), "p: string");
  const m2 = A.listAt(A.classMembersStart(0), 1);
  eq("static async generator", String(A.memberIsStatic(m2)) + String(A.funcIsAsync(A.memberFunc(m2))) + String(A.funcIsGenerator(A.memberFunc(m2))), "truetruetrue");

  // ───── comments
  parse("#!/usr/bin/env node\n// first\nlet a = 1; /* two */ let b /* in */ = 2; // tail\n", "a.js");
  eqn("comments", A.commentsLen(), 5);
  eqn("shebang kind", A.commentKindAt(0), A.TK_SHEBANG);
  eqn("line kind", A.commentKindAt(1), A.TK_LINE);
  eqn("block kind", A.commentKindAt(2), A.TK_BLOCK);
  A.commentValueSpan(2);
  eq("block value", spanText(), " two ");
  const at2 = slice(0, hir.sourceLen).indexOf("let b");
  eqn("end of token before `let b`", A.fileEndOfTokenBefore(at2), slice(0, hir.sourceLen).indexOf("/* two */") - 0 === 0 ? 0 : slice(0, hir.sourceLen).indexOf("; /* two */") + 1);
  eqn("end of token before first token", A.fileEndOfTokenBefore(slice(0, hir.sourceLen).indexOf("let a")), 0);

  // ───── children, near
  parse("f(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10);", "a.ts");
  e = findExpr(A.EXPR_CALL, "f(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10)");
  const ch = new I32Vec(16);
  A.nodeChildren(A.nodeOfExpr(e), -1, ch);
  eqn("children of the call", ch.len, 12);
  ch.reset();
  const off = slice(0, hir.sourceLen).indexOf("a7") + 1;
  A.nodeChildren(A.nodeOfExpr(e), off, ch);
  eqn("children near a7", ch.len, 2);
  A.nodeSpan(ch.data[1] | 0);
  eq("child near a7", spanText(), "a7");
  eqn("list around", A.listAround(A.N_EXPR, A.callArgsStart(A.exprCallCall(e)), A.callArgsLen(A.exprCallCall(e)), off), A.listAt(A.callArgsStart(A.exprCallCall(e)), 7));

  // ───── flow-ish helpers and misc utilities
  eq("goesToFlow @flow", String(A.goesToFlow(Buffer.from("// @flow\nlet a;"), 15, "a.js")), "true");
  eq("goesToFlow @noflow", String(A.goesToFlow(Buffer.from("/* @noflow */\nlet a;"), 20, "a.js")), "true");
  eq("goesToFlow no", String(A.goesToFlow(Buffer.from("// flow\nlet a;"), 14, "a.js")), "false");
  eq("goesToFlow .js.flow", String(A.goesToFlow(Buffer.from("let a;"), 6, "a.js.flow")), "true");
  eq("goesToFlow after the code", String(A.goesToFlow(Buffer.from("let a; // @flow"), 14, "a.js")), "false");
  const u = Buffer.from("fs");
  eq("builtin fs", String(A.isBuiltinModule(u, 0, 2)), "true");
  const u2 = Buffer.from("node:test");
  eq("builtin node:test", String(A.isBuiltinModule(u2, 0, 9)), "true");
  const u3 = Buffer.from("react");
  eq("builtin react", String(A.isBuiltinModule(u3, 0, 5)), "false");
  eq("fileName", A.fileName("a/b\\c.ts"), "c.ts");
  const up = Buffer.from("AbC");
  const bb = new Bytes(8);
  A.toLowerCaseInto(up, 0, 3, bb);
  eq("lower", Buffer.from(bb.data.subarray(0, bb.len)).toString(), "abc");
  eq("endsWithIgnoreAsciiCase", String(A.endsWithIgnoreAsciiCase(Buffer.from("x.TS"), 0, 4, ".ts")), "true");

  console.log("ast-unit:", checks, "checks,", fails, "failures");
  if (fails > 0) process.exit(1);
}

main();
