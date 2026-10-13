// Differential check of the spans that src/lint/ast computes from the text, against the positions TypeScript's own parser gives for the same
// nodes (`typescript` from node_modules; node only):
//
//   node tools/ast-xcheck-ts.ts [--limit N] [--only substr] [-v]
//
// For every file of bench/vscode that the sema parser accepts, the HIR is walked (not the TS tree) and each node that has a TS counterpart at the
// same position is compared: function parentheses / parameter lists / bodies / type-parameter angle brackets, class and interface bodies, template
// quasis, module specifiers, parenthesized types, keys, JSX opening/closing tags, enum and module bodies, statement semicolons.
import * as fs from "node:fs";
import ts from "typescript";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { names } from "../src/sema/parser/parser/mod.ts";
import * as A from "../src/lint/ast/index.ts";

const { hir, SP } = A;

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) if (a[i] === name) return a[i + 1];
  return dflt;
}
const verbose = process.argv.includes("-v");

const total = new Map<string, number>();
const bad = new Map<string, number>();
const examples = new Map<string, string[]>();
function check(name: string, ok: boolean, what: () => string): void {
  total.set(name, (total.get(name) ?? 0) + 1);
  if (!ok) {
    bad.set(name, (bad.get(name) ?? 0) + 1);
    const ex = examples.get(name) ?? [];
    if (ex.length < 5) {
      ex.push(what());
      examples.set(name, ex);
    }
  }
}

function sp(): string {
  return "[" + SP[0] + "," + SP[1] + ")";
}

function scriptKindOf(p: string): ts.ScriptKind {
  if (p.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (p.endsWith(".ts") || p.endsWith(".mts") || p.endsWith(".cts")) return ts.ScriptKind.TS;
  if (p.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function isFunctionLike(n: ts.Node): n is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isMethodSignature(n) || ts.isCallSignatureDeclaration(n) ||
    ts.isConstructSignatureDeclaration(n) || ts.isFunctionTypeNode(n) || ts.isConstructorTypeNode(n)
  );
}

function checkFile(path: string, src: Uint8Array, len: number, sf: ts.SourceFile): void {
  const text = hir.text;
  // maps from the TS side, by position
  const fnByOpen = new Map<number, ts.SignatureDeclaration>();
  const fnByArrow = new Map<number, ts.ArrowFunction>();
  const classByStart = new Map<number, ts.ClassLikeDeclaration>();
  const ifaceByStart = new Map<number, ts.InterfaceDeclaration>();
  const enumByStart = new Map<number, ts.EnumDeclaration>();
  const moduleByStart = new Map<number, ts.ModuleDeclaration>();
  const stmtByStart = new Map<number, ts.Node>();
  const templateByStart = new Map<number, ts.TemplateExpression>();
  const parenTypes = new Set<string>();
  const nameByStart = new Map<number, ts.PropertyName>();
  const jsxByStart = new Map<number, ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment>();
  const paramByStart = new Map<number, ts.ParameterDeclaration>();
  const varDeclByStart = new Map<number, ts.VariableDeclaration>();
  const memberSpans = new Set<string>();
  const propSpans = new Set<string>();
  const typeParamSpans = new Set<string>();
  const caseSpans = new Set<string>();
  const specSpans = new Set<string>();
  const enumMemberSpans = new Set<string>();
  const stmtSpans = new Set<string>();
  const spanKey = (n: ts.Node): string => n.getStart(sf) + ":" + n.end;
  const allSpans = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (n.kind !== ts.SyntaxKind.SyntaxList) allSpans.add(spanKey(n));
    if (ts.isParameter(n)) paramByStart.set(n.getStart(sf), n);
    if (ts.isVariableDeclaration(n)) varDeclByStart.set(n.getStart(sf), n);
    if (
      ts.isPropertyDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) || ts.isIndexSignatureDeclaration(n) || ts.isClassStaticBlockDeclaration(n) || ts.isPropertySignature(n) ||
      ts.isMethodSignature(n) || ts.isCallSignatureDeclaration(n) || ts.isConstructSignatureDeclaration(n)
    ) {
      memberSpans.add(spanKey(n));
    }
    if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isSpreadAssignment(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) propSpans.add(spanKey(n));
    if (ts.isTypeParameterDeclaration(n)) typeParamSpans.add(spanKey(n));
    if (ts.isCaseClause(n) || ts.isDefaultClause(n)) caseSpans.add(spanKey(n));
    if (ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) specSpans.add(spanKey(n));
    if (ts.isEnumMember(n)) enumMemberSpans.add(spanKey(n));
    if (
      ts.isVariableStatement(n) || ts.isExpressionStatement(n) || ts.isIfStatement(n) || ts.isDoStatement(n) || ts.isWhileStatement(n) || ts.isForStatement(n) ||
      ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isContinueStatement(n) || ts.isBreakStatement(n) || ts.isReturnStatement(n) || ts.isWithStatement(n) ||
      ts.isSwitchStatement(n) || ts.isLabeledStatement(n) || ts.isThrowStatement(n) || ts.isTryStatement(n) || ts.isDebuggerStatement(n) || ts.isFunctionDeclaration(n) ||
      ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n) ||
      ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isExportDeclaration(n) || ts.isExportAssignment(n) || ts.isNamespaceExportDeclaration(n) ||
      ts.isEmptyStatement(n) || ts.isBlock(n) || ts.isVariableDeclarationList(n)
    ) {
      stmtSpans.add(spanKey(n));
    }
    if (isFunctionLike(n)) {
      if (ts.isArrowFunction(n)) fnByArrow.set(n.equalsGreaterThanToken.getStart(sf), n);
      else if (n.parameters.length >= 0) fnByOpen.set(n.parameters.pos - 1, n);
    }
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) classByStart.set(n.getStart(sf), n);
    if (ts.isInterfaceDeclaration(n)) ifaceByStart.set(n.getStart(sf), n);
    if (ts.isEnumDeclaration(n)) enumByStart.set(n.getStart(sf), n);
    if (ts.isModuleDeclaration(n)) moduleByStart.set(n.getStart(sf), n);
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportEqualsDeclaration(n)) stmtByStart.set(n.getStart(sf), n);
    if (ts.isTemplateExpression(n)) templateByStart.set(n.getStart(sf), n);
    if (ts.isParenthesizedTypeNode(n) && !(n.parent && ts.isParenthesizedTypeNode(n.parent))) parenTypes.add(n.getStart(sf) + ":" + n.end);
    if (
      (ts.isPropertyDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) ||
        ts.isPropertySignature(n) || ts.isMethodSignature(n) || ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) ||
        ts.isEnumMember(n)) && n.name
    ) {
      nameByStart.set(n.name.getStart(sf), n.name as ts.PropertyName);
    }
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) jsxByStart.set(n.getStart(sf), n);
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // functions
  for (let f = 0; f < hir.nFns; f++) {
    const kind = hir.fnKind[f] | 0;
    const anchor = hir.fnAnchor[f] | 0;
    let node: ts.SignatureDeclaration | undefined;
    if (kind === A.FN_ARROW) node = fnByArrow.get(anchor);
    else if (kind !== A.FN_STATIC_BLOCK) node = fnByOpen.get(anchor);
    if (node === undefined) continue;
    const params = node.parameters;
    const parenthesized = text[params.pos - 1] === 40 && text[params.end] === 41;
    if (kind !== A.FN_ARROW) {
      check("fn.openParen", A.funcOpenParen(f) === params.pos - 1, () => path + " fn " + f + " open " + A.funcOpenParen(f) + " ts " + (params.pos - 1));
    }
    if (kind !== A.FN_ARROW || parenthesized) {
      const children = node.getChildren(sf);
      let closeTok: ts.Node | undefined;
      for (const c of children) {
        if (c.kind === ts.SyntaxKind.CloseParenToken || (ts.isIndexSignatureDeclaration(node) && c.kind === ts.SyntaxKind.CloseBracketToken)) {
          closeTok = c;
          break;
        }
      }
      if (closeTok !== undefined) {
        const tsClose = closeTok.getStart(sf);
        const close = A.funcCloseParen(f);
        check("fn.closeParen", close === tsClose, () => path + " fn " + f + " close " + close + " ts " + tsClose);
        if (A.funcParamsSpan(f)) {
          check("fn.paramsSpan", SP[0] === params.pos - 1 && SP[1] === tsClose + 1, () => path + " fn " + f + " params " + sp() + " ts [" + (params.pos - 1) + "," + (tsClose + 1) + ")");
        }
      }
    }
    const tps = node.typeParameters;
    if (tps !== undefined && tps.length > 0) {
      const gt = node.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.GreaterThanToken);
      const tsEnd = gt !== undefined ? gt.end : tps.end + 1;
      const ok = A.typeParamListAngleBrackets(A.funcTypeParamsStart(f), A.funcTypeParamsLen(f)) && SP[0] === tps.pos - 1 && SP[1] === tsEnd;
      check("typeParams.angle", ok, () => path + " fn " + f + " " + sp() + " ts [" + (tps.pos - 1) + "," + tsEnd + ")");
      check("fn.startOfParams", A.funcStartOfParams(f) === tps.pos - 1, () => path + " fn " + f + " " + A.funcStartOfParams(f) + " ts " + (tps.pos - 1));
    }
    const body = (node as ts.FunctionLikeDeclaration).body;
    if (body !== undefined && ts.isBlock(body) && kind !== A.FN_ARROW) {
      const ok = A.funcBodySpan(f) && SP[0] === body.getStart(sf) && SP[1] === body.end;
      check("fn.bodySpan", ok, () => path + " fn " + f + " " + (A.funcBodySpan(f) ? sp() : "none") + " ts [" + body.getStart(sf) + "," + body.end + ")");
    }
    // the return type annotation: `: T` / `=> T`
    const ret = node.type;
    if (ret !== undefined && !ts.isTypePredicateNode(ret)) {
      const t = A.funcReturnType(f);
      if (t >= 0) {
        A.typeAnnotationSpan(t);
        // TS has the colon in ret.pos - 1 or earlier whitespace; compare the end only and that the start is a `:` or `=>`
        const isArrow = text[SP[0] + 1] === 62 && text[SP[0]] === 61;
        check("fn.returnAnnotation", SP[1] >= ret.end && (text[SP[0]] === 58 || isArrow), () => path + " fn " + f + " " + sp() + " ts end " + ret.end);
      }
    }
  }

  // classes
  for (let c = 0; c < hir.nClasses; c++) {
    const node = classByStart.get(hir.classStart[c] | 0);
    if (node === undefined) continue;
    A.classBodySpan(c);
    check("class.bodySpan", SP[0] === node.members.pos - 1 && SP[1] === node.end, () => path + " class " + c + " " + sp() + " ts [" + (node.members.pos - 1) + "," + node.end + ")");
    A.classKeywordSpan(c);
    check("class.keyword", Buffer.from(text.subarray(SP[0], SP[1])).toString() === "class", () => path + " class " + c + " kw " + sp());
    if (node.typeParameters !== undefined && node.typeParameters.length > 0) {
      const ok = A.typeParamListAngleBrackets(A.classTypeParamsStart(c), A.classTypeParamsLen(c)) && SP[0] === node.typeParameters.pos - 1 && SP[1] === node.typeParameters.end + 1;
      check("typeParams.angle", ok, () => path + " class " + c + " " + sp());
    }
  }
  // interfaces
  for (let i = 0; i < hir.nInterfaces; i++) {
    const s = hir.interfaceStmt[i] | 0;
    const node = ifaceByStart.get(A.stmtStart(s));
    if (node === undefined) continue;
    A.interfaceBodySpan(i);
    check("interface.bodySpan", SP[0] === node.members.pos - 1 && SP[1] === node.end, () => path + " interface " + i + " " + sp() + " ts [" + (node.members.pos - 1) + "," + node.end + ")");
  }
  // enums
  for (let e = 0; e < hir.nEnums; e++) {
    const s = hir.enumStmt[e] | 0;
    const node = enumByStart.get(A.stmtStart(s));
    if (node === undefined) continue;
    A.enumBodySpan(e);
    check("enum.bodySpan", SP[0] === node.members.pos - 1 && SP[1] === node.end, () => path + " enum " + e + " " + sp() + " ts [" + (node.members.pos - 1) + "," + node.end + ")");
  }
  // modules: only the outermost `namespace A.B { }` has a body in TS at the innermost
  for (let m = 0; m < hir.nModules; m++) {
    if (A.moduleOutermost(m) !== m) continue;
    const s = hir.moduleStmt[m] | 0;
    const node = moduleByStart.get(A.stmtStart(s));
    if (node === undefined) continue;
    let body: ts.ModuleBody | ts.JSDocNamespaceDeclaration | undefined = node.body;
    while (body !== undefined && ts.isModuleDeclaration(body)) body = body.body;
    if (body === undefined) continue;
    if (!A.moduleBodySpan(m)) {
      check("module.bodySpan", false, () => path + " module " + m + " none");
      continue;
    }
    check("module.bodySpan", SP[0] === body.getStart(sf) && SP[1] === body.end, () => path + " module " + m + " " + sp() + " ts [" + body!.getStart(sf) + "," + body!.end + ")");
  }
  // module specifiers
  for (let s = 0; s < hir.nStmts; s++) {
    const t = hir.stmtTag[s] | 0;
    if (t !== A.STMT_IMPORT && t !== A.STMT_EXPORT_NAMED && t !== A.STMT_EXPORT_STAR && t !== A.STMT_IMPORT_EQUALS) continue;
    const node = stmtByStart.get(A.stmtStart(s));
    if (node === undefined) continue;
    let spec: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) spec = node.moduleReference.expression;
    if (spec === undefined) {
      check("stmt.moduleSpecifier.none", !A.stmtModuleSpecifierSpan(s), () => path + " stmt " + s + " has one, TS has none");
      continue;
    }
    const ok = A.stmtModuleSpecifierSpan(s) && SP[0] === spec.getStart(sf) && SP[1] === spec.end;
    check("stmt.moduleSpecifier", ok, () => path + " stmt " + s + " " + (A.stmtModuleSpecifierSpan(s) ? sp() : "none") + " ts [" + spec!.getStart(sf) + "," + spec!.end + ")");
    // `;`
    if (t !== A.STMT_IMPORT_EQUALS) {
      const hasSemi = text[node.end - 1] === 59;
      check("stmt.semicolon", A.stmtSemicolon(s) === hasSemi, () => path + " stmt " + s + " " + A.stmtSemicolon(s) + " ts " + hasSemi);
    }
  }
  // templates
  for (let e = 0; e < hir.nExprs; e++) {
    if (A.exprTag(e) !== A.EXPR_TEMPLATE || A.exprTemplateExprsLen(e) === 0) continue;
    const node = templateByStart.get(A.exprStart(e));
    if (node === undefined) continue;
    const pieces: ts.Node[] = [node.head];
    for (const sp2 of node.templateSpans) pieces.push(sp2.literal);
    check("template.quasiCount", A.exprTemplateQuasiCount(e) === pieces.length, () => path + " e " + e);
    for (let i = 0; i < pieces.length && i < A.exprTemplateQuasiCount(e); i++) {
      A.exprTemplateQuasiSpan(e, i);
      check("template.quasiSpan", SP[0] === pieces[i].getStart(sf) && SP[1] === pieces[i].end, () => path + " e " + e + " quasi " + i + " " + sp() + " ts [" + pieces[i].getStart(sf) + "," + pieces[i].end + ")");
    }
  }
  // parenthesized types: every outermost ParenthesizedType of TS is the outer span of one type, and every outer span that differs from the span is one
  const mine = new Set<string>();
  for (let t = 0; t < hir.nTypes; t++) {
    if (!A.typeIsParenthesized(t)) continue;
    A.typeOuterSpan(t);
    mine.add(SP[0] + ":" + SP[1]);
  }
  for (const k of parenTypes) check("type.parenthesized.ts->mine", mine.has(k), () => path + " ts paren type " + k + " not found among " + [...mine].slice(0, 5).join(","));
  for (const k of mine) check("type.parenthesized.mine->ts", parenTypes.has(k), () => path + " my paren type " + k + " not in TS");
  // keys
  for (let m = 0; m < hir.nMembers; m++) {
    const k = A.nodeOfMember(m);
    if (A.keyKind(k) < 0) continue;
    const name = nameByStart.get(A.keyStart(k));
    if (name === undefined) continue;
    A.keySpan(k);
    check("key.span", SP[0] === name.getStart(sf) && SP[1] === name.end, () => path + " member " + m + " " + sp() + " ts [" + name.getStart(sf) + "," + name.end + ")");
    A.keyInnerSpan(k);
    const inner = ts.isComputedPropertyName(name) ? name.expression : name;
    check("key.innerSpan", SP[0] === inner.getStart(sf) && SP[1] === inner.end, () => path + " member " + m + " inner " + sp() + " ts [" + inner.getStart(sf) + "," + inner.end + ")");
  }
  for (let p = 0; p < hir.nProps; p++) {
    const k = A.nodeOfProp(p);
    if (A.keyKind(k) < 0 || A.propIsJsxAttribute(p)) continue;
    const name = nameByStart.get(A.keyStart(k));
    if (name === undefined) continue;
    A.keySpan(k);
    check("key.span.prop", SP[0] === name.getStart(sf) && SP[1] === name.end, () => path + " prop " + p + " " + sp() + " ts [" + name.getStart(sf) + "," + name.end + ")");
  }
  for (let m = 0; m < hir.nEnumMembers; m++) {
    const k = A.nodeOfEnumMember(m);
    const name = nameByStart.get(hir.enumMemberPos[m] | 0);
    if (name === undefined) continue;
    A.keySpan(k);
    check("key.span.enum", SP[0] === name.getStart(sf) && SP[1] === name.end, () => path + " enum member " + m + " " + sp() + " ts [" + name.getStart(sf) + "," + name.end + ")");
  }
  // jsx
  for (let e = 0; e < hir.nExprs; e++) {
    if ((hir.exprTag[e] | 0) !== A.EXPR_JSX) continue;
    const node = jsxByStart.get(A.exprStart(e));
    if (node === undefined) continue;
    A.jsxOpeningSpan(e);
    if (ts.isJsxElement(node)) {
      check("jsx.opening", SP[0] === node.openingElement.getStart(sf) && SP[1] === node.openingElement.end, () => path + " jsx " + e + " " + sp() + " ts [" + node.openingElement.getStart(sf) + "," + node.openingElement.end + ")");
      const closing = A.jsxClosingSpan(e);
      check("jsx.closing", closing && SP[0] === node.closingElement.getStart(sf) && SP[1] === node.closingElement.end, () => path + " jsx " + e + " closing " + (closing ? sp() : "none") + " ts [" + node.closingElement.getStart(sf) + "," + node.closingElement.end + ")");
    } else if (ts.isJsxSelfClosingElement(node)) {
      check("jsx.selfClosing", SP[0] === node.getStart(sf) && SP[1] === node.end && !A.jsxClosingSpan(e), () => path + " jsx " + e + " " + sp());
    } else {
      check("jsx.fragment.opening", SP[0] === node.openingFragment.getStart(sf) && SP[1] === node.openingFragment.end, () => path + " jsx " + e + " " + sp());
    }
  }
  // parameters, variable declarations, members, properties, type parameters, cases, specifiers, enum members, statements
  for (let p = 0; p < hir.nParams; p++) {
    A.paramSpan(p);
    const node = paramByStart.get(SP[0]);
    if (node === undefined) continue;
    check("param.span", SP[1] === node.end, () => path + " param " + p + " " + sp() + " ts end " + node.end);
    A.paramBindingSpan(p);
    const nameEnd = node.questionToken !== undefined ? node.questionToken.end : node.name.end;
    const tsEnd = node.type !== undefined ? node.type.end : nameEnd;
    // typescript-estree: the binding with `?` and the annotation (a parenthesized type: its parentheses are part of the annotation)
    check("param.bindingSpan", SP[1] >= tsEnd && SP[1] - tsEnd <= 3, () => path + " param " + p + " binding " + sp() + " ts end " + tsEnd);
  }
  for (let d = 0; d < hir.nVarDecls; d++) {
    A.varDeclSpan(d);
    const node = varDeclByStart.get(SP[0]);
    if (node === undefined) continue;
    check("varDecl.span", SP[1] === node.end, () => path + " varDecl " + d + " " + sp() + " ts end " + node.end);
  }
  for (let m = 0; m < hir.nMembers; m++) {
    A.memberSpan(m);
    check("member.span", memberSpans.has(SP[0] + ":" + SP[1]), () => path + " member " + m + " " + sp() + " not a TS member span");
  }
  for (let q = 0; q < hir.nProps; q++) {
    if (A.propIsJsxAttribute(q) || A.propIsImportAttribute(q)) continue;
    A.propSpan(q);
    check("prop.span", propSpans.has(SP[0] + ":" + SP[1]), () => path + " prop " + q + " " + sp() + " not a TS property span");
  }
  for (let q = 0; q < hir.nTypeParams; q++) {
    A.typeParamSpan(q);
    // an `infer U` / mapped `K in T` parameter is not a TypeParameterDeclaration with these bounds in every case: only compare those TS has
    if (typeParamSpans.has(SP[0] + ":" + SP[1])) check("typeParam.span", true, () => "");
    else check("typeParam.span", typeParamSpans.size === 0 ? true : [...typeParamSpans].some((k) => k.startsWith(SP[0] + ":")) === false, () => path + " type param " + q + " " + sp());
  }
  for (let c = 0; c < hir.nCases; c++) {
    A.caseSpan(c);
    check("case.span", caseSpans.has(SP[0] + ":" + SP[1]), () => path + " case " + c + " " + sp());
  }
  for (let q = 0; q < hir.nImportSpecs; q++) {
    A.importSpecSpan(q);
    check("importSpec.span", specSpans.has(SP[0] + ":" + SP[1]), () => path + " import spec " + q + " " + sp());
  }
  for (let q = 0; q < hir.nExportSpecs; q++) {
    A.exportSpecSpan(q);
    check("exportSpec.span", specSpans.has(SP[0] + ":" + SP[1]), () => path + " export spec " + q + " " + sp());
  }
  for (let q = 0; q < hir.nEnumMembers; q++) {
    A.enumMemberSpan(q);
    check("enumMember.span", enumMemberSpans.has(SP[0] + ":" + SP[1]), () => path + " enum member " + q + " " + sp());
  }
  for (let q = 0; q < hir.nStmts; q++) {
    const t = hir.stmtTag[q] | 0;
    if (A.stmtIsWrapper(q) || (t === A.STMT_EXPR && A.stmtIsWith(q))) continue;
    if (t === A.STMT_BLOCK && A.stmtIsWith(q)) continue;
    A.stmtSpan(q);
    check("stmt.span", stmtSpans.has(SP[0] + ":" + SP[1]), () => path + " stmt " + q + " tag " + t + " " + sp() + " " + JSON.stringify(Buffer.from(text.subarray(SP[0], Math.min(SP[1], SP[0] + 30))).toString()));
  }
  // expressions, types and patterns: each span is the span of some node of the TS tree
  for (let e = 0; e < hir.nExprs; e++) {
    if ((hir.exprTag[e] | 0) === A.EXPR_MISSING) continue;
    // the function of a method / accessor starts at its parameters: ESTree's FunctionExpression, TS has no such node
    if ((hir.exprTag[e] | 0) === A.EXPR_FN) {
      const k = hir.fnKind[hir.exprA[e] | 0] | 0;
      if (k === A.FN_METHOD || k === A.FN_GETTER || k === A.FN_SETTER) continue;
    }
    if (A.isImportAttributesObject(e)) continue; // `with { .. }`: not a node
    if (A.exprIsJsxText(e)) continue; // TS's JsxText starts after the white space; the HIR text is as written
    if ((hir.exprTag[e] | 0) === A.EXPR_SPREAD && A.exprJsxContainerSpan(e)) continue; // `{...e}` child: TS has a JsxExpression
    A.exprSpan(e);
    check("expr.span", allSpans.has(SP[0] + ":" + SP[1]), () => path + " expr " + e + " tag " + A.exprTag(e) + " " + sp() + " " + JSON.stringify(Buffer.from(text.subarray(SP[0], Math.min(SP[1], SP[0] + 30))).toString()));
    A.exprOuterSpan(e);
    check("expr.outerSpan", allSpans.has(SP[0] + ":" + SP[1]) || A.exprIsParenthesized(e), () => path + " expr " + e + " outer " + sp());
  }
  for (let t = 0; t < hir.nTypes; t++) {
    if ((hir.typeTag[t] | 0) === A.TYPE_ERROR) continue;
    A.typeSpan(t);
    check("type.span", allSpans.has(SP[0] + ":" + SP[1]), () => path + " type " + t + " tag " + A.typeTag(t) + " " + sp() + " " + JSON.stringify(Buffer.from(text.subarray(SP[0], Math.min(SP[1], SP[0] + 30))).toString()));
  }
  for (let q = 0; q < hir.nPats; q++) {
    if ((hir.patTag[q] | 0) === A.PAT_MISSING) continue;
    A.patSpan(q);
    check("pat.span", allSpans.has(SP[0] + ":" + SP[1]), () => path + " pat " + q + " " + sp());
  }
  // tokens: the leaves of the TS tree. `fileEndOfTokenBefore(start)` is the end of the leaf before; `skipTrivia(end)` is the start of the next;
  // `skipTriviaBack(start)` is the end of the leaf before (not reliable in the presence of regexes and templates: counted apart);
  // `tokenLen` is the length of the token for the kinds that the scanner of Rust gets right without context.
  const leaves: ts.Node[] = [];
  const collect = (n: ts.Node): void => {
    const kids = n.getChildren(sf);
    if (kids.length === 0) {
      if (n.kind !== ts.SyntaxKind.EndOfFileToken && n.end > n.getStart(sf)) leaves.push(n);
      return;
    }
    for (const k of kids) {
      if (k.kind >= ts.SyntaxKind.FirstJSDocNode && k.kind <= ts.SyntaxKind.LastJSDocNode) continue;
      collect(k);
    }
  };
  collect(sf);
  let prevEnd = 0;
  let prevKind: ts.SyntaxKind = ts.SyntaxKind.Unknown;
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const start = leaf.getStart(sf);
    const jsx = leaf.kind === ts.SyntaxKind.JsxText || prevKind === ts.SyntaxKind.JsxText;
    const tmpl = leaf.kind >= ts.SyntaxKind.FirstTemplateToken && leaf.kind <= ts.SyntaxKind.LastTemplateToken;
    const tmplPrev = prevKind >= ts.SyntaxKind.FirstTemplateToken && prevKind <= ts.SyntaxKind.LastTemplateToken;
    if (!jsx && i > 0) {
      check("token.endOfTokenBefore", A.fileEndOfTokenBefore(start) === prevEnd, () => path + " at " + start + " got " + A.fileEndOfTokenBefore(start) + " ts " + prevEnd);
      const back = A.skipTriviaBack(hir.text, hir.sourceLen, start);
      if (!tmpl && !tmplPrev && leaf.kind !== ts.SyntaxKind.RegularExpressionLiteral) {
        check("token.skipTriviaBack", back === prevEnd, () => path + " at " + start + " got " + back + " ts " + prevEnd);
      }
      const fwd = A.skipTrivia(hir.text, hir.sourceLen, prevEnd);
      check("token.skipTrivia", fwd === start, () => path + " from " + prevEnd + " got " + fwd + " ts " + start);
    }
    const k = leaf.kind;
    const plain =
      k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.NumericLiteral || k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.PrivateIdentifier ||
      (k >= ts.SyntaxKind.FirstKeyword && k <= ts.SyntaxKind.LastKeyword);
    if (plain && !jsx) {
      check("token.len", A.tokenLen(hir.text, hir.sourceLen, start) === leaf.end - start, () => path + " at " + start + " got " + A.tokenLen(hir.text, hir.sourceLen, start) + " ts " + (leaf.end - start) + " " + ts.SyntaxKind[k]);
    }
    prevEnd = leaf.end;
    prevKind = leaf.kind;
  }
  void src;
  void len;
}

function main(): void {
  const root = "bench/vscode";
  const listPath = "/tmp/vscode-files.txt";
  const limit = parseInt(arg("--limit", "0"), 10);
  const only = arg("--only", "");
  const lines = fs.readFileSync(listPath, "utf8").split("\n");
  let files = 0;
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i];
    if (p.length === 0 || (only !== "" && p.indexOf(only) < 0)) continue;
    if (!(p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mts") || p.endsWith(".mjs"))) continue;
    const b = fs.readFileSync(root + "/" + p);
    const src = new Uint8Array(b.length + 16);
    src.set(b);
    let r = parseFile(src, b.length, p, false);
    let isScript = false;
    if (r !== 0 && !p.endsWith(".mjs") && !p.endsWith(".mts")) {
      r = parseFile(src, b.length, p, true);
      isScript = true;
    }
    if (r !== 0) {
      skipped++;
      continue;
    }
    const isTs = p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".mts");
    A.fileBegin(names, isTs, !isScript);
    // TS positions are UTF-16 code units: give TS a copy of the text in which every non-ASCII character is as many `x` as it has UTF-8 bytes (a BOM:
    // spaces), so that positions are bytes. Names, strings and comments stay what they are; exotic white space does not (rare: shows as a mismatch).
    let tsText = "";
    {
      const parts: string[] = [];
      let k = 0;
      while (k < b.length) {
        const c = b[k];
        if (c < 0x80) {
          let e = k + 1;
          while (e < b.length && b[e] < 0x80) e++;
          parts.push(b.toString("latin1", k, e));
          k = e;
        } else {
          const n = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
          const isBom = c === 0xef && b[k + 1] === 0xbb && b[k + 2] === 0xbf;
          parts.push((isBom ? " " : "x").repeat(n));
          k += n;
        }
      }
      tsText = parts.join("");
    }
    const sf = ts.createSourceFile(p, tsText, ts.ScriptTarget.ES2022, true, scriptKindOf(p));
    files++;
    checkFile(p, src, b.length, sf);
    if (limit > 0 && files >= limit) break;
  }
  console.log("files compared", files, "skipped (refused or non-ASCII)", skipped);
  for (const [k, v] of [...total].sort()) {
    const b = bad.get(k) ?? 0;
    console.log((b === 0 ? "ok   " : "BAD  ") + k.padEnd(32), String(v).padStart(8), "mismatches", b);
  }
  let sum = 0;
  for (const v of total.values()) sum += v;
  console.log("total comparisons", sum);
  for (const [k, ex] of examples) {
    console.log("--", k);
    for (const e of ex) console.log("   ", e);
  }
  if (verbose) console.log("done");
}

main();
