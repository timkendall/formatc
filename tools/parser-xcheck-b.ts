// Structural cross-check of the parser's statements, declarations, modules, types and JSX against TypeScript's own parser: for each
// file, the multiset of (start, end) of the nodes of one class in the HIR and the one of the corresponding TypeScript nodes.
//   node tools/parser-xcheck-b.ts [--limit N] [--skip N] [--show K] [--root bench/vscode] [files..]
// Classes: stmt (loc.pos, loc.end of statements), type, member, enumMember, importSpec, exportSpec, varDecl, typeParam, case,
// jsx (elements, fragments), jsxAttr, jsxExpr.
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { lx } from "../src/sema/parser/parser/mod.ts";
import { refusalName } from "../src/sema/parser/lib.ts";
import { hir } from "../src/sema/hir.ts";
import * as H from "../src/sema/hir.ts";

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) if (a[i] === name) return a[i + 1];
  return dflt;
}
const files: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--js") continue;
  if (a.startsWith("--")) {
    i++;
    continue;
  }
  files.push(a);
}
const limit = parseInt(arg("--limit", "300"), 10);
const skip = parseInt(arg("--skip", "0"), 10);
const show = parseInt(arg("--show", "3"), 10);
const root = arg("--root", "bench/vscode");
const JS = process.argv.includes("--js");

function* walk(d: string): Generator<string> {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if ((JS ? /\.(js|jsx|mjs|cjs)$/ : /\.(ts|tsx|mts|cts)$/).test(e.name) && !e.name.endsWith(".d.ts")) yield p;
  }
}

type Key = string;
const CLASSES = ["stmt", "type", "member", "enumMember", "importSpec", "exportSpec", "varDecl", "typeParam", "case", "jsx", "jsxAttr", "jsxExpr"];


const STMT_NAMES = ["EmptyStatement", "DebuggerStatement", "ExpressionStatement", "VariableStatement", "FunctionDeclaration", "ClassDeclaration", "InterfaceDeclaration", "TypeAliasDeclaration", "EnumDeclaration", "ModuleDeclaration", "ReturnStatement", "IfStatement", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoStatement", "Block", "SwitchStatement", "TryStatement", "ThrowStatement", "BreakStatement", "ContinueStatement", "LabeledStatement", "ImportDeclaration", "ImportEqualsDeclaration", "ExportDeclaration", "ExportDeclaration", "ExportAssignment", "ExportAssignment", "NamespaceExportDeclaration"];
const KW_FROM_TS: Record<string, number> = { AnyKeyword: 0, UnknownKeyword: 1, NeverKeyword: 2, VoidKeyword: 3, UndefinedKeyword: 4, StringKeyword: 6, NumberKeyword: 7, BooleanKeyword: 8, BigIntKeyword: 9, SymbolKeyword: 10, ObjectKeyword: 11, ThisType: 12, IntrinsicKeyword: 13 };
const TYPE_LABELS = ["error", "heritage", "kw", "ref", "str", "num", "big", "bool", "tpl", "arr", "tuple", "union", "inter", "fn", "obj", "cond", "infer", "mapped", "idx", "keyof", "readonly", "uniquesym", "unique", "jsdoc", "typeof", "import", "pred"];
const MEMBER_LABELS = ["prop", "method", "getter", "setter", "ctor", "call", "construct", "index", "static"];

function tsTypeLabel(n: ts.TypeNode): string {
  const k = ts.SyntaxKind[n.kind];
  if (k in KW_FROM_TS) return "kw" + KW_FROM_TS[k];
  if (ts.isLiteralTypeNode(n)) {
    const l = n.literal;
    switch (l.kind) {
      case ts.SyntaxKind.NullKeyword: return "kw5";
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword: return "bool";
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: return "str";
      case ts.SyntaxKind.NumericLiteral: return "num";
      case ts.SyntaxKind.BigIntLiteral: return "big";
      case ts.SyntaxKind.PrefixUnaryExpression: return ts.isBigIntLiteral((l as ts.PrefixUnaryExpression).operand) ? "big" : "num";
    }
    return "lit?";
  }
  if (ts.isTypeReferenceNode(n)) return "ref";
  if (ts.isExpressionWithTypeArguments(n)) return isEntityName(n.expression) ? "ref" : "heritage";
  if (ts.isTemplateLiteralTypeNode(n)) return "tpl";
  if (ts.isArrayTypeNode(n)) return "arr";
  if (ts.isTupleTypeNode(n)) return "tuple";
  if (ts.isUnionTypeNode(n)) return "union";
  if (ts.isIntersectionTypeNode(n)) return "inter";
  if (ts.isFunctionTypeNode(n) || ts.isConstructorTypeNode(n)) return "fn";
  if (ts.isTypeLiteralNode(n)) return "obj";
  if (ts.isConditionalTypeNode(n)) return "cond";
  if (ts.isInferTypeNode(n)) return "infer";
  if (ts.isMappedTypeNode(n)) return "mapped";
  if (ts.isIndexedAccessTypeNode(n)) return "idx";
  if (ts.isTypeOperatorNode(n)) {
    if (n.operator === ts.SyntaxKind.KeyOfKeyword) return "keyof";
    if (n.operator === ts.SyntaxKind.ReadonlyKeyword) return "readonly";
    return n.type.kind === ts.SyntaxKind.SymbolKeyword ? "uniquesym" : "unique";
  }
  if (ts.isTypeQueryNode(n)) return "typeof";
  if (ts.isImportTypeNode(n)) return "import";
  if (ts.isTypePredicateNode(n)) return "pred";
  return "?" + k;
}

function isEntityName(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return true;
  if (ts.isPropertyAccessExpression(e)) return isEntityName(e.expression);
  return false;
}

function tsStmtLabel(n: ts.Node): string {
  if (ts.isVariableStatement(n)) return "VariableStatement";
  if (ts.isExpressionStatement(n)) return "ExpressionStatement";
  if (ts.isEmptyStatement(n)) return "EmptyStatement";
  if (ts.isDebuggerStatement(n)) return "DebuggerStatement";
  if (ts.isFunctionDeclaration(n)) return "FunctionDeclaration";
  if (ts.isClassDeclaration(n)) return "ClassDeclaration";
  if (ts.isInterfaceDeclaration(n)) return "InterfaceDeclaration";
  if (ts.isTypeAliasDeclaration(n)) return "TypeAliasDeclaration";
  if (ts.isEnumDeclaration(n)) return "EnumDeclaration";
  if (ts.isModuleDeclaration(n)) return "ModuleDeclaration";
  if (ts.isReturnStatement(n)) return "ReturnStatement";
  if (ts.isIfStatement(n)) return "IfStatement";
  if (ts.isForStatement(n)) return "ForStatement";
  if (ts.isForInStatement(n)) return "ForInStatement";
  if (ts.isForOfStatement(n)) return "ForOfStatement";
  if (ts.isWhileStatement(n)) return "WhileStatement";
  if (ts.isDoStatement(n)) return "DoStatement";
  if (ts.isBlock(n)) return "Block";
  if (ts.isSwitchStatement(n)) return "SwitchStatement";
  if (ts.isTryStatement(n)) return "TryStatement";
  if (ts.isThrowStatement(n)) return "ThrowStatement";
  if (ts.isBreakStatement(n)) return "BreakStatement";
  if (ts.isContinueStatement(n)) return "ContinueStatement";
  if (ts.isLabeledStatement(n)) return "LabeledStatement";
  if (ts.isImportDeclaration(n)) return "ImportDeclaration";
  if (ts.isImportEqualsDeclaration(n)) return "ImportEqualsDeclaration";
  if (ts.isExportDeclaration(n)) return "ExportDeclaration";
  if (ts.isExportAssignment(n)) return "ExportAssignment";
  if (ts.isNamespaceExportDeclaration(n)) return "NamespaceExportDeclaration";
  return "?";
}

function tsMemberLabel(n: ts.Node): string {
  if (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) return "prop";
  if (ts.isMethodSignature(n) || ts.isMethodDeclaration(n)) return "method";
  if (ts.isGetAccessorDeclaration(n)) return "getter";
  if (ts.isSetAccessorDeclaration(n)) return "setter";
  if (ts.isConstructorDeclaration(n)) return "ctor";
  if (ts.isCallSignatureDeclaration(n)) return "call";
  if (ts.isConstructSignatureDeclaration(n)) return "construct";
  if (ts.isIndexSignatureDeclaration(n)) return "index";
  if (ts.isClassStaticBlockDeclaration(n)) return "static";
  return "?" + ts.SyntaxKind[n.kind];
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isClassStaticBlockDeclaration(n)
  );
}

function tsNodes(sf: ts.SourceFile, cls: string, out: Map<Key, string>, counts: Map<Key, number>): void {
  const add = (n: ts.Node, pos: number, end: number, label: string, norm: string = ""): void => {
    const k = `${pos},${end},${norm}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    out.set(k, label + " " + JSON.stringify(sf.text.slice(Math.max(pos, 0), Math.min(end, pos + 40))));
    void n;
  };
  const visit = (n: ts.Node): void => {
    switch (cls) {
      case "stmt":
        if (
          ts.isVariableStatement(n) || ts.isExpressionStatement(n) || ts.isIfStatement(n) || ts.isDoStatement(n) || ts.isWhileStatement(n) ||
          ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isContinueStatement(n) || ts.isBreakStatement(n) ||
          ts.isReturnStatement(n) || ts.isWithStatement(n) || ts.isSwitchStatement(n) || ts.isLabeledStatement(n) || ts.isThrowStatement(n) ||
          ts.isTryStatement(n) || ts.isDebuggerStatement(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) ||
          ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n) || ts.isImportDeclaration(n) ||
          ts.isImportEqualsDeclaration(n) || ts.isExportDeclaration(n) || ts.isExportAssignment(n) || ts.isNamespaceExportDeclaration(n) ||
          ts.isEmptyStatement(n) ||
          (ts.isBlock(n) && !(n.parent && isFunctionLike(n.parent)))
        ) {
          // With: HIR makes a block of the object and the body. A catch's block is a statement in both.
          if (ts.isWithStatement(n)) break;
          add(n, n.pos, n.end, tsStmtLabel(n), tsStmtLabel(n));
        }
        break;
      case "type":
        if (ts.isTypeNode(n) && !ts.isParenthesizedTypeNode(n) && !ts.isNamedTupleMember(n) && !ts.isOptionalTypeNode(n) && !ts.isRestTypeNode(n)) {
          if (ts.isExpressionWithTypeArguments(n) && n.parent && ts.isHeritageClause(n.parent) && n.parent.token === ts.SyntaxKind.ExtendsKeyword && !ts.isInterfaceDeclaration(n.parent.parent)) break;
          if (ts.isConstTypeReference(n)) break;
          if (n.kind === ts.SyntaxKind.SymbolKeyword && n.parent && ts.isTypeOperatorNode(n.parent) && n.parent.operator === ts.SyntaxKind.UniqueKeyword) break;
          if (n.kind === ts.SyntaxKind.ThisType && n.parent && ts.isTypePredicateNode(n.parent) && n.parent.parameterName === n) break;
          if (ts.isExpressionWithTypeArguments(n) && !(n.parent && ts.isHeritageClause(n.parent))) break;
          if (ts.isTemplateLiteralTypeSpan(n as ts.Node)) break;
          if (ts.isLiteralTypeNode(n) && n.parent && ts.isImportTypeNode(n.parent) && n.parent.argument === n) break;
          add(n, n.getStart(sf), n.end, ts.SyntaxKind[n.kind], tsTypeLabel(n));
        }
        break;
      case "member":
        if (ts.isTypeElement(n) || ts.isClassElement(n)) {
          if (ts.isSemicolonClassElement(n)) break;
          if (n.parent && ts.isObjectLiteralExpression(n.parent)) break;
          add(n, n.pos, n.end, ts.SyntaxKind[n.kind], tsMemberLabel(n));
        }
        break;
      case "enumMember":
        if (ts.isEnumMember(n)) add(n, n.pos, n.end, "EnumMember");
        break;
      case "importSpec":
        if (ts.isImportSpecifier(n)) add(n, n.getStart(sf), n.end, "ImportSpecifier");
        break;
      case "exportSpec":
        if (ts.isExportSpecifier(n)) add(n, n.getStart(sf), n.end, "ExportSpecifier");
        break;
      case "varDecl":
        if (ts.isVariableDeclaration(n)) add(n, n.pos, n.end, "VariableDeclaration");
        break;
      case "typeParam":
        if (ts.isTypeParameterDeclaration(n)) add(n, n.getStart(sf), n.end, "TypeParameter");
        break;
      case "case":
        if (ts.isCaseClause(n) || ts.isDefaultClause(n)) add(n, n.getStart(sf), n.end, ts.SyntaxKind[n.kind]);
        break;
      case "jsx":
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
          // A JsxSelfClosingElement is not a child of a JsxElement's opening: the opening element is a separate node.
          add(n, n.getStart(sf), n.end, ts.SyntaxKind[n.kind]);
        }
        break;
      case "jsxAttr":
        if (ts.isJsxAttribute(n) || ts.isJsxSpreadAttribute(n)) add(n, n.getStart(sf), n.end, ts.SyntaxKind[n.kind]);
        break;
      case "jsxExpr":
        if (ts.isJsxExpression(n)) add(n, n.getStart(sf), n.end, "JsxExpression");
        break;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function hirNodes(cls: string, out: Map<Key, string>, counts: Map<Key, number>, text: string): void {
  const add = (pos: number, end: number, label: string, norm: string = ""): void => {
    const k = `${pos},${end},${norm}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    out.set(k, label + " " + JSON.stringify(text.slice(Math.max(pos, 0), Math.min(end, pos + 40))));
  };
  switch (cls) {
    case "stmt": {
      // for-init / for-in left are Var statements in HIR but declaration lists in TS.
      const skipSet = new Set<number>();
      for (let s = 0; s < hir.nStmts; s++) {
        const t = hir.stmtTag[s];
        if (t === H.STMT_FOR) skipSet.add(hir.stmtA[s]);
        else if (t === H.STMT_FOR_IN || t === H.STMT_FOR_OF) skipSet.add(hir.stmtA[s]);
      }
      for (let s = 0; s < hir.nStmts; s++) {
        if (skipSet.has(s)) continue;
        add(hir.stmtLocPos[s], hir.stmtLocEnd[s], "stmt#" + hir.stmtTag[s], STMT_NAMES[hir.stmtTag[s]]);
      }
      break;
    }
    case "type":
      for (let t = 0; t < hir.nTypes; t++) add(hir.typePos[t], hir.typeEnd[t], "type#" + hir.typeTag[t], hir.typeTag[t] === H.TYPE_KEYWORD ? "kw" + hir.typeA[t] : TYPE_LABELS[hir.typeTag[t]]);
      break;
    case "member":
      for (let m = 0; m < hir.nMembers; m++) add(hir.memberLocPos[m], hir.memberLocEnd[m], "member#" + hir.memberKind[m], MEMBER_LABELS[hir.memberKind[m]]);
      break;
    case "enumMember":
      for (let m = 0; m < hir.nEnumMembers; m++) add(hir.enumMemberLocPos[m], hir.enumMemberLocEnd[m], "enumMember");
      break;
    case "importSpec":
      for (let m = 0; m < hir.nImportSpecs; m++) add(hir.importSpecStart[m], hir.importSpecEnd[m], "importSpec");
      break;
    case "exportSpec":
      for (let m = 0; m < hir.nExportSpecs; m++) add(hir.exportSpecStart[m], hir.exportSpecEnd[m], "exportSpec");
      break;
    case "varDecl":
      for (let m = 0; m < hir.nVarDecls; m++) add(hir.varDeclLocPos[m], hir.varDeclLocEnd[m], "varDecl");
      break;
    case "typeParam":
      for (let m = 0; m < hir.nTypeParams; m++) add(hir.typeParamStart[m], hir.typeParamEnd[m], "typeParam");
      break;
    case "case":
      for (let m = 0; m < hir.nCases; m++) add(hir.casePos[m], hir.caseEnd[m], "case");
      break;
    case "jsx":
      for (let e = 0; e < hir.nExprs; e++) if (hir.exprTag[e] === H.EXPR_JSX) add(hir.exprPos[e], hir.exprEnd[e], "jsx");
      break;
    case "jsxAttr":
      for (let m = 0; m < hir.nProps; m++) if (hir.propNameKind[m] === H.NK_JSX) add(hir.propStart[m], hir.propEnd[m], "jsxAttr");
      break;
    case "jsxExpr":
      for (let m = 0; m < hir.nJsxExpressions; m++) add(hir.jsxExpressionStart[m], hir.jsxExpressionEnd[m], "jsxExpr");
      break;
  }
}

const list: string[] = files.length > 0 ? files : [...walk(root)];
let checked = 0;
let refused = 0;
const stats = new Map<string, { hirOnly: number; tsOnly: number; files: number; ex: string[] }>();
for (const c of CLASSES) stats.set(c, { hirOnly: 0, tsOnly: 0, files: 0, ex: [] });

for (let fi = skip; fi < list.length && checked < limit; fi++) {
  const file = list[fi];
  const buf = fs.readFileSync(file);
  const text = buf.toString("latin1"); // one char per byte: the positions of the HIR are bytes
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, JS ? (file.endsWith("x") ? ts.ScriptKind.JSX : ts.ScriptKind.JS) : file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if ((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0) continue;
  const src = new Uint8Array(buf.length + 16);
  src.set(buf);
  const r = parseFile(src, buf.length, file, false);
  checked++;
  if (r !== 0) {
    refused++;
    console.log("REFUSED", file, refusalName(r), lx.refusedAt);
    continue;
  }
  for (const c of CLASSES) {
    const a = new Map<Key, string>();
    const ac = new Map<Key, number>();
    const b = new Map<Key, string>();
    const bc = new Map<Key, number>();
    hirNodes(c, a, ac, text);
    tsNodes(sf, c, b, bc);
    const st = stats.get(c)!;
    let diff = false;
    for (const [k, n] of ac) {
      const m = bc.get(k) ?? 0;
      if (n > m) {
        st.hirOnly += n - m;
        diff = true;
        if (st.ex.length < show) st.ex.push(`${file} HIR-only ${k} ${a.get(k)}`);
      }
    }
    for (const [k, n] of bc) {
      const m = ac.get(k) ?? 0;
      if (n > m) {
        st.tsOnly += n - m;
        diff = true;
        if (st.ex.length < show) st.ex.push(`${file} TS-only ${k} ${b.get(k)}`);
      }
    }
    if (diff) st.files++;
  }
}
console.log(`checked ${checked} files, refused ${refused}`);
for (const c of CLASSES) {
  const st = stats.get(c)!;
  console.log(`${c.padEnd(11)} hirOnly ${st.hirOnly} tsOnly ${st.tsOnly} in ${st.files} files`);
  for (const e of st.ex) console.log("    " + e);
}
