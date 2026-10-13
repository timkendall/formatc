// Field-level cross-check of the parser's statements, declarations, modules and types against TypeScript's own parser: for each
// node of a class, a signature of its fields (the ranges of its children, names, flags, counts) is built from the HIR and from
// the TypeScript tree and compared for the nodes that have the same (start, end).
//   node tools/parser-deep-b.ts [--limit N] [--skip N] [--show K] [--root bench/vscode] [--class stmt|type|member|typeParam] [files..]
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { lx, names } from "../src/sema/parser/parser/mod.ts";
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
const show = parseInt(arg("--show", "4"), 10);
const root = arg("--root", "bench/vscode");
const JS = process.argv.includes("--js");
const only = arg("--class", "");

function* walk(d: string): Generator<string> {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if ((JS ? /\.(js|jsx|mjs|cjs)$/ : /\.(ts|tsx|mts|cts)$/).test(e.name) && !e.name.endsWith(".d.ts")) yield p;
  }
}

function atomText(a: number): string {
  if (a < 0) return "";
  return Buffer.from(names.textBuf(a).subarray(names.textStart(a), names.textStart(a) + names.textLen(a))).toString("latin1");
}
function ids(start: number, len: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < len; i++) r.push(hir.ids[start + i]);
  return r;
}

// ───────────── ranges ─────────────
let SF: ts.SourceFile;
function skipParens(n: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(n) || ts.isParenthesizedTypeNode(n)) n = ts.isParenthesizedTypeNode(n) ? n.type : n.expression;
  return n;
}
function tr(n: ts.Node | undefined): string {
  if (!n) return "-";
  n = skipParens(n);
  return `${n.getStart(SF)}-${n.end}`;
}
function htr(t: number): string {
  return t < 0 ? "-" : `${hir.typePos[t]}-${hir.typeEnd[t]}`;
}
function hexpr(e: number): string {
  return e < 0 ? "-" : `${hir.exprPos[e]}-${hir.exprEnd[e]}`;
}
function hstmt(s: number): string {
  return s < 0 ? "-" : `${hir.stmtLocPos[s]}-${hir.stmtLocEnd[s]}`;
}
function tstmt(n: ts.Node | undefined): string {
  return n ? `${n.pos}-${n.end}` : "-";
}
function hpat(p: number): string {
  return p < 0 ? "-" : `${hir.patPos[p]}-${hir.patEnd[p]}`;
}

const FLAG_OF_KIND: Record<number, number> = {
  [ts.SyntaxKind.ExportKeyword]: H.FLAG_EXPORT,
  [ts.SyntaxKind.DefaultKeyword]: H.FLAG_DEFAULT,
  [ts.SyntaxKind.DeclareKeyword]: H.FLAG_AMBIENT,
  [ts.SyntaxKind.AbstractKeyword]: H.FLAG_ABSTRACT,
  [ts.SyntaxKind.AsyncKeyword]: H.FLAG_ASYNC,
  [ts.SyntaxKind.StaticKeyword]: H.FLAG_STATIC,
  [ts.SyntaxKind.ReadonlyKeyword]: H.FLAG_READONLY,
  [ts.SyntaxKind.PrivateKeyword]: H.FLAG_PRIVATE,
  [ts.SyntaxKind.ProtectedKeyword]: H.FLAG_PROTECTED,
  [ts.SyntaxKind.PublicKeyword]: H.FLAG_PUBLIC,
  [ts.SyntaxKind.OverrideKeyword]: H.FLAG_OVERRIDE,
  [ts.SyntaxKind.AccessorKeyword]: H.FLAG_ACCESSOR,
  [ts.SyntaxKind.ConstKeyword]: H.FLAG_CONST,
  [ts.SyntaxKind.InKeyword]: H.FLAG_IN,
  [ts.SyntaxKind.OutKeyword]: H.FLAG_OUT,
};
function tsMods(n: ts.Node): string {
  let flags = 0;
  let deco = 0;
  const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined;
  for (const m of mods ?? []) flags |= FLAG_OF_KIND[m.kind] ?? 0;
  if (ts.canHaveDecorators(n)) deco = ts.getDecorators(n)?.length ?? 0;
  return `m${flags}/${deco}`;
}
function hmods(start: number, len: number): string {
  let flags = 0;
  let deco = 0;
  for (let i = 0; i < len; i++) {
    const m = hir.ids[start + i];
    if (hir.modifierKind[m] === H.MODK_KEYWORD) flags |= hir.modifierValue[m];
    else deco++;
  }
  return `m${flags}/${deco}`;
}

// ───────────── statements ─────────────
function entityText(n: ts.Node): string {
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isQualifiedName(n)) return entityText(n.left) + "." + n.right.text;
  if (ts.isPropertyAccessExpression(n)) return entityText(n.expression) + "." + n.name.text;
  if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.ThisType) return "this";
  if (ts.isStringLiteral(n)) return JSON.stringify(n.text);
  return "?";
}
function hNames(start: number, len: number): string {
  const r: string[] = [];
  for (const id of ids(start, len)) r.push(atomText(hir.nameText[id]));
  return r.join(".");
}
function hTypes(start: number, len: number): string {
  return ids(start, len).map(htr).join(",");
}
function tTypes(ns: readonly ts.Node[] | undefined): string {
  return (ns ?? []).map(tr).join(",");
}

function varKind(flags: ts.NodeFlags): number {
  if ((flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing) return H.VAR_AWAIT_USING;
  if (flags & ts.NodeFlags.Using) return H.VAR_USING;
  if (flags & ts.NodeFlags.Const) return H.VAR_CONST;
  if (flags & ts.NodeFlags.Let) return H.VAR_LET;
  return H.VAR_VAR;
}
function tsDecl(d: ts.VariableDeclaration): string {
  return `${d.name.getStart(SF)}-${d.name.end}:${tr(d.type)}:${tr(d.initializer)}:${d.exclamationToken ? "!" : ""}`;
}
function hDecl(d: number): string {
  return `${hpat(hir.varDeclPat[d])}:${htr(hir.varDeclTy[d])}:${hexpr(hir.varDeclInit[d])}:${hir.varDeclFlags[d] & H.FLAG_DEFINITE ? "!" : ""}`;
}
function forInit(n: ts.Node | undefined): string {
  return n ? `${n.getStart(SF)}-${n.end}` : "-";
}
function hForInit(s: number): string {
  return s < 0 ? "-" : `${hir.stmtStart[s]}-${hir.stmtLocEnd[s]}`;
}
function propNameText(n: ts.PropertyName | ts.BindingName | undefined): string {
  if (!n) return "";
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isNumericLiteral(n)) return String(Number(n.text));
  if (ts.isComputedPropertyName(n) && (ts.isStringLiteral(n.expression) || ts.isNoSubstitutionTemplateLiteral(n.expression))) return n.expression.text;
  return "[computed]";
}

function tsStmtSig(n: ts.Node): string {
  const mods = tsMods(n);
  if (ts.isVariableStatement(n)) {
    return `${mods}|k${varKind(n.declarationList.flags)}|${n.declarationList.declarations.map(tsDecl).join(";")}`;
  }
  if (ts.isExpressionStatement(n)) return `${tr(n.expression)}`;
  if (ts.isIfStatement(n)) return `${tr(n.expression)}|${tstmt(n.thenStatement)}|${tstmt(n.elseStatement)}`;
  if (ts.isForStatement(n)) return `${forInit(n.initializer)}|${tr(n.condition)}|${tr(n.incrementor)}|${tstmt(n.statement)}`;
  if (ts.isForInStatement(n)) return `${forInit(n.initializer)}|${tr(n.expression)}|${tstmt(n.statement)}`;
  if (ts.isForOfStatement(n)) return `${forInit(n.initializer)}|${tr(n.expression)}|${tstmt(n.statement)}|${n.awaitModifier ? "await" : ""}`;
  if (ts.isWhileStatement(n)) return `${tr(n.expression)}|${tstmt(n.statement)}`;
  if (ts.isDoStatement(n)) return `${tstmt(n.statement)}|${tr(n.expression)}`;
  if (ts.isBlock(n)) return n.statements.map(tstmt).join(",");
  if (ts.isSwitchStatement(n)) return `${tr(n.expression)}|${n.caseBlock.clauses.map((c) => (ts.isCaseClause(c) ? tr(c.expression) : "default") + ":" + c.statements.length).join(";")}`;
  if (ts.isTryStatement(n)) {
    const c = n.catchClause;
    return `${tstmt(n.tryBlock)}|${c?.variableDeclaration ? `${c.variableDeclaration.pos}-${c.variableDeclaration.end}:${tsDecl(c.variableDeclaration)}` : "-"}|${tstmt(c?.block)}|${tstmt(n.finallyBlock)}`;
  }
  if (ts.isThrowStatement(n)) return tr(n.expression);
  if (ts.isReturnStatement(n)) return tr(n.expression);
  if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) return n.label?.text ?? "";
  if (ts.isLabeledStatement(n)) return `${n.label.text}|${tstmt(n.statement)}`;
  if (ts.isDebuggerStatement(n) || ts.isEmptyStatement(n)) return "";
  if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) return `${mods}|${n.name?.text ?? ""}`;
  if (ts.isInterfaceDeclaration(n)) {
    const ext = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    return `${mods}|${n.name.text}|tp${n.typeParameters?.length ?? 0}|${tTypes(ext?.types)}|m${n.members.length}`;
  }
  if (ts.isTypeAliasDeclaration(n)) return `${mods}|${n.name.text}|tp${n.typeParameters?.length ?? 0}|${tr(n.type)}`;
  if (ts.isEnumDeclaration(n)) return `${mods}|${n.name.text}|${n.members.map((m) => propNameText(m.name) + "=" + tr(m.initializer)).join(";")}`;
  if (ts.isModuleDeclaration(n)) {
    const body = n.body;
    const name = ts.isIdentifier(n.name) ? n.name.text : "str:" + (n.name as ts.StringLiteral).text;
    const nm = n.flags & ts.NodeFlags.GlobalAugmentation ? "global" : name;
    const kids = !body ? "-" : ts.isModuleBlock(body) ? body.statements.map(tstmt).join(",") : tstmt(body);
    return `${mods}|${nm}|${kids}`;
  }
  if (ts.isImportDeclaration(n)) {
    const c = n.importClause;
    const nb = c?.namedBindings;
    const specs = nb && ts.isNamedImports(nb) ? nb.elements.map((e) => `${e.propertyName?.text ?? e.name.text}/${e.name.text}/${e.isTypeOnly ? "t" : ""}`).join(";") : "";
    const ns = nb && ts.isNamespaceImport(nb) ? nb.name.text : "";
    return `${mods}|${(n.moduleSpecifier as ts.StringLiteral).text}|${c?.isTypeOnly ? "type" : ""}|${c?.name?.text ?? ""}|${ns}|${nb && ts.isNamedImports(nb) ? "named" : ""}|${specs}`;
  }
  if (ts.isImportEqualsDeclaration(n)) {
    const r = n.moduleReference;
    const target = ts.isExternalModuleReference(r) ? "require:" + ((r.expression as ts.StringLiteral).text ?? "?") : entityText(r);
    return `${mods}|${n.name.text}|${n.isTypeOnly ? "type" : ""}|${target}`;
  }
  if (ts.isExportDeclaration(n)) {
    const c = n.exportClause;
    const spec = n.moduleSpecifier ? (n.moduleSpecifier as ts.StringLiteral).text : "";
    if (!c || ts.isNamespaceExport(c)) return `${mods}|star|${spec}|${n.isTypeOnly ? "type" : ""}|${c ? c.name.text : ""}`;
    return `${mods}|named|${spec}|${n.isTypeOnly ? "type" : ""}|${c.elements.map((e) => `${e.propertyName?.text ?? e.name.text}/${e.name.text}/${e.isTypeOnly ? "t" : ""}`).join(";")}`;
  }
  if (ts.isExportAssignment(n)) return `${mods}|${tr(n.expression)}|${n.isExportEquals ? "=" : "default"}`;
  if (ts.isNamespaceExportDeclaration(n)) return n.name.text;
  return "?";
}

function hSpecs(start: number, len: number, kind: "i" | "e"): string {
  return ids(start, len)
    .map((s) => (kind === "i" ? `${atomText(hir.importSpecImported[s])}/${atomText(hir.importSpecLocal[s])}/${hir.importSpecTypeOnly[s] ? "t" : ""}` : `${atomText(hir.exportSpecLocal[s])}/${atomText(hir.exportSpecExported[s])}/${hir.exportSpecTypeOnly[s] ? "t" : ""}`))
    .join(";");
}

function hirStmtSig(s: number): string {
  const mods = hmods(hir.stmtModStart[s], hir.stmtModLen[s]);
  const a = hir.stmtA[s];
  const b = hir.stmtB[s];
  const c = hir.stmtC[s];
  const d = hir.stmtD[s];
  switch (hir.stmtTag[s]) {
    case H.STMT_VAR:
      return `${mods}|k${hir.varDeclKind[hir.ids[a]]}|${ids(a, b).map(hDecl).join(";")}`;
    case H.STMT_EXPR:
      return hexpr(a);
    case H.STMT_IF:
      return `${hexpr(a)}|${hstmt(b)}|${hstmt(c)}`;
    case H.STMT_FOR:
      return `${hForInit(a)}|${hexpr(b)}|${hexpr(c)}|${hstmt(d)}`;
    case H.STMT_FOR_IN:
      return `${hForInit(a)}|${hexpr(b)}|${hstmt(c)}`;
    case H.STMT_FOR_OF:
      return `${hForInit(a)}|${hexpr(b)}|${hstmt(c)}|${hir.stmtAux[s] ? "await" : ""}`;
    case H.STMT_WHILE:
      return `${hexpr(a)}|${hstmt(b)}`;
    case H.STMT_DO_WHILE:
      return `${hstmt(a)}|${hexpr(b)}`;
    case H.STMT_BLOCK:
      return ids(a, b).map(hstmt).join(",");
    case H.STMT_SWITCH:
      return `${hexpr(a)}|${ids(b, c).map((cs) => (hir.caseTest[cs] < 0 ? "default" : hexpr(hir.caseTest[cs])) + ":" + hir.caseBodyLen[cs]).join(";")}`;
    case H.STMT_TRY:
      return `${hstmt(a)}|${b < 0 ? "-" : `${hir.varDeclLocPos[b]}-${hir.varDeclLocEnd[b]}:${hDecl(b)}`}|${hstmt(c)}|${hstmt(d)}`;
    case H.STMT_THROW:
    case H.STMT_RETURN:
      return hexpr(a);
    case H.STMT_BREAK:
    case H.STMT_CONTINUE:
      return atomText(a);
    case H.STMT_LABELED:
      return `${atomText(a)}|${hstmt(b)}`;
    case H.STMT_DEBUGGER:
    case H.STMT_EMPTY:
      return "";
    case H.STMT_FN:
      return `${mods}|${atomText(hir.fnName[a])}`;
    case H.STMT_CLASS:
      return `${mods}|${atomText(hir.className[a])}`;
    case H.STMT_INTERFACE:
      return `${mods}|${atomText(hir.interfaceName[a])}|tp${hir.interfaceTypeParamsLen[a]}|${hTypes(hir.interfaceExtendsStart[a], hir.interfaceExtendsLen[a])}|m${hir.interfaceMembersLen[a]}`;
    case H.STMT_TYPE_ALIAS:
      return `${mods}|${atomText(hir.aliasName[a])}|tp${hir.aliasTypeParamsLen[a]}|${htr(hir.aliasTy[a])}`;
    case H.STMT_ENUM:
      return `${mods}|${atomText(hir.enumName[a])}|${ids(hir.enumMembersStart[a], hir.enumMembersLen[a])
        .map((m) => (hir.enumMemberComputedName[m] >= 0 ? "[computed]" : atomText(hir.enumMemberName[m])) + "=" + hexpr(hir.enumMemberInit[m]))
        .join(";")}`;
    case H.STMT_MODULE: {
      const nm = hir.moduleNameKind[a] === H.MODNAME_GLOBAL ? "global" : hir.moduleNameKind[a] === H.MODNAME_STRING ? "str:" + atomText(hir.moduleName[a]) : atomText(hir.moduleName[a]);
      const kids = hir.moduleHasBody[a] ? ids(hir.moduleBodyStart[a], hir.moduleBodyLen[a]).map(hstmt).join(",") : "-";
      return `${mods}|${nm}|${kids}`;
    }
    case H.STMT_IMPORT: {
      const e = a;
      return `${mods}|${atomText(hir.importSpec[e])}|${hir.importTypeOnly[e] ? "type" : ""}|${atomText(hir.importDefault[e])}|${atomText(hir.importNamespace[e])}|${hir.importHasNamedImports[e] ? "named" : ""}|${hSpecs(hir.importNamedStart[e], hir.importNamedLen[e], "i")}`;
    }
    case H.STMT_IMPORT_EQUALS: {
      const e = a;
      const target = hir.importEqualsTargetKind[e] === H.IET_REQUIRE ? "require:" + atomText(hir.importEqualsTargetA[e]) : hNames(hir.importEqualsTargetA[e], hir.importEqualsTargetB[e]);
      return `${mods}|${atomText(hir.importEqualsName[e])}|${hir.importEqualsFlags[e] & H.FLAG_TYPE_ONLY ? "type" : ""}|${target}`;
    }
    case H.STMT_EXPORT_NAMED: {
      const e = a;
      return `${mods}|named|${atomText(hir.exportSpec[e])}|${hir.exportTypeOnly[e] ? "type" : ""}|${hSpecs(hir.exportItemsStart[e], hir.exportItemsLen[e], "e")}`;
    }
    case H.STMT_EXPORT_STAR:
      return `${mods}|star|${atomText(a)}|${hir.stmtAux[s] & 1 ? "type" : ""}|${atomText(b)}`;
    case H.STMT_EXPORT_DEFAULT:
      return `${mods}|${hexpr(a)}|default`;
    case H.STMT_EXPORT_ASSIGN:
      return `${mods}|${hexpr(a)}|=`;
    case H.STMT_EXPORT_AS_NAMESPACE:
      return atomText(a);
  }
  return "?";
}

// ───────────── types ─────────────
function tsTypeSig(n: ts.TypeNode): string {
  if (ts.isTypeReferenceNode(n)) return `${entityText(n.typeName)}<${tTypes(n.typeArguments)}>`;
  if (ts.isExpressionWithTypeArguments(n)) return ts.isIdentifier(n.expression) || ts.isPropertyAccessExpression(n.expression) ? `${entityText(n.expression)}<${tTypes(n.typeArguments)}>` : `${tr(n.expression)}<${tTypes(n.typeArguments)}>`;
  if (ts.isLiteralTypeNode(n)) return ts.isStringLiteral(n.literal) || ts.isNoSubstitutionTemplateLiteral(n.literal) ? n.literal.text : "";
  if (ts.isTemplateLiteralTypeNode(n)) return `${n.head.text}|${n.templateSpans.map((s) => tr(s.type) + ":" + s.literal.text).join(";")}`;
  if (ts.isArrayTypeNode(n)) return tr(n.elementType);
  if (ts.isTupleTypeNode(n)) {
    return n.elements
      .map((e) => {
        if (ts.isNamedTupleMember(e)) return `${e.name.text}:${e.questionToken ? "?" : ""}:${e.dotDotDotToken ? "..." : ""}:${tr(e.type)}`;
        if (ts.isOptionalTypeNode(e)) return `:?::${tr(e.type)}`;
        if (ts.isRestTypeNode(e)) return `::...:${tr(e.type)}`;
        return `:::${tr(e)}`;
      })
      .join(";");
  }
  if (ts.isUnionTypeNode(n) || ts.isIntersectionTypeNode(n)) return tTypes(n.types);
  if (ts.isFunctionTypeNode(n) || ts.isConstructorTypeNode(n)) {
    const ps = n.parameters;
    const hasThis = ps.length > 0 && ts.isIdentifier(ps[0].name) && ps[0].name.text === "this";
    return `${ts.isConstructorTypeNode(n) ? "new" : "fn"}|${tsMods(n)}|tp${n.typeParameters?.length ?? 0}|p${ps.length - (hasThis ? 1 : 0)}|${hasThis ? "this" : ""}|${tr(n.type)}`;
  }
  if (ts.isTypeLiteralNode(n)) return `m${n.members.length}`;
  if (ts.isConditionalTypeNode(n)) return `${tr(n.checkType)}|${tr(n.extendsType)}|${tr(n.trueType)}|${tr(n.falseType)}`;
  if (ts.isInferTypeNode(n)) return `${n.typeParameter.name.text}|${tr(n.typeParameter.constraint)}`;
  if (ts.isMappedTypeNode(n)) {
    const mod = (t: ts.ReadonlyKeyword | ts.PlusToken | ts.MinusToken | ts.QuestionToken | undefined): string =>
      !t ? "none" : t.kind === ts.SyntaxKind.MinusToken ? "remove" : t.kind === ts.SyntaxKind.PlusToken ? "add+" : "add";
    return `${mod(n.readonlyToken)}|${mod(n.questionToken)}|${n.typeParameter.name.text}|${tr(n.typeParameter.constraint)}|${tr(n.nameType)}|${tr(n.type)}|m${n.members?.length ?? 0}`;
  }
  if (ts.isIndexedAccessTypeNode(n)) return `${tr(n.objectType)}|${tr(n.indexType)}`;
  if (ts.isTypeOperatorNode(n)) return n.operator === ts.SyntaxKind.UniqueKeyword && n.type.kind === ts.SyntaxKind.SymbolKeyword ? "" : tr(n.type);
  if (ts.isTypeQueryNode(n)) return `${entityText(n.exprName)}<${tTypes(n.typeArguments)}>`;
  if (ts.isImportTypeNode(n)) {
    const arg = n.argument;
    const spec = ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal) ? arg.literal.text : "?";
    return `${n.isTypeOf ? "typeof" : ""}|${spec}|${n.qualifier ? entityText(n.qualifier) : ""}|${tTypes(n.typeArguments)}`;
  }
  if (ts.isTypePredicateNode(n)) return `${entityText(n.parameterName as ts.Node)}|${n.assertsModifier ? "asserts" : ""}|${tr(n.type)}`;
  return "";
}

function hirTypeSig(t: number): string {
  const a = hir.typeA[t];
  const b = hir.typeB[t];
  const c = hir.typeC[t];
  const d = hir.typeD[t];
  const e = hir.typeE[t];
  const aux = hir.typeAux[t];
  switch (hir.typeTag[t]) {
    case H.TYPE_HERITAGE:
      return `${hexpr(a)}<${hTypes(b, c)}>`;
    case H.TYPE_REF:
      return `${hNames(a, b)}<${hTypes(c, d)}>`;
    case H.TYPE_STRING_LIT:
      return atomText(a);
    case H.TYPE_TEMPLATE:
      return `${atomText(hir.ids[c])}|${ids(a, b)
        .map((ty, i) => htr(ty) + ":" + atomText(hir.ids[c + i + 1]))
        .join(";")}`;
    case H.TYPE_ARRAY:
      return htr(a);
    case H.TYPE_TUPLE:
      return ids(a, b)
        .map((el) => `${atomText(hir.tupleElemName[el])}:${hir.tupleElemOptional[el] || hir.tupleElemMemberType[el] === H.TM_OPTIONAL ? "?" : ""}:${hir.tupleElemRest[el] ? "..." : ""}:${htr(hir.tupleElemWritten[el])}`)
        .join(";")
        .split(";")
        .map((x) => x)
        .join(";");
    case H.TYPE_UNION:
    case H.TYPE_INTERSECTION:
      return hTypes(a, b);
    case H.TYPE_FN: {
      const f = a;
      return `${hir.fnKind[f] === H.FN_CONSTRUCTOR_TYPE ? "new" : "fn"}|${hmods(0, 0).replace("m0", "m" + (hir.fnFlags[f] & H.FLAG_ABSTRACT))}|tp${hir.fnTypeParamsLen[f]}|p${hir.fnParamsLen[f]}|${hir.fnThisParam[f] >= 0 ? "this" : ""}|${htr(hir.fnRet[f])}`;
    }
    case H.TYPE_OBJECT:
      return `m${b}`;
    case H.TYPE_COND:
      return `${htr(a)}|${htr(b)}|${htr(c)}|${htr(d)}`;
    case H.TYPE_INFER:
      return `${atomText(hir.typeParamName[a])}|${htr(hir.typeParamConstraint[a])}`;
    case H.TYPE_MAPPED: {
      const m = a;
      const mod = (v: number, plus: number): string => (v === H.MM_NONE ? "none" : v === H.MM_REMOVE ? "remove" : plus ? "add+" : "add");
      return `${mod(hir.mappedReadonly[m], hir.mappedIsReadonlyWithPlus[m])}|${mod(hir.mappedOptional[m], hir.mappedIsOptionalWithPlus[m])}|${atomText(hir.typeParamName[hir.mappedParam[m]])}|${htr(hir.typeParamConstraint[hir.mappedParam[m]])}|${htr(hir.mappedNameTy[m])}|${htr(hir.mappedTy[m])}|m${hir.mappedMembersLen[m]}`;
    }
    case H.TYPE_INDEXED_ACCESS:
      return `${htr(a)}|${htr(b)}`;
    case H.TYPE_KEYOF:
    case H.TYPE_READONLY:
    case H.TYPE_UNIQUE:
      return htr(a);
    case H.TYPE_UNIQUE_SYMBOL:
      return "";
    case H.TYPE_TYPEOF:
      return `${hNames(a, b)}<${hTypes(c, d)}>`;
    case H.TYPE_IMPORT:
      return `${aux & 1 ? "typeof" : ""}|${atomText(a)}|${hNames(b, c)}|${hTypes(d, e)}`;
    case H.TYPE_PREDICATE:
      return `${atomText(a)}|${aux ? "asserts" : ""}|${htr(b)}`;
  }
  return "";
}

// ───────────── members and type parameters ─────────────
function tsMemberSig(n: ts.Node): string {
  const mods = tsMods(n);
  const named = n as ts.PropertyDeclaration;
  const name = named.name ? propNameText(named.name) : "";
  const q = (n as ts.PropertySignature).questionToken ? "?" : "";
  const type = (n as ts.PropertySignature).type;
  const init = (n as ts.PropertyDeclaration).initializer;
  if (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) return `${mods}|${name}|${q}|${tr(type)}|${tr(init)}`;
  if (ts.isMethodSignature(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isCallSignatureDeclaration(n) || ts.isConstructSignatureDeclaration(n)) {
    const f = n as ts.SignatureDeclarationBase;
    const ps = f.parameters;
    const hasThis = ps.length > 0 && ts.isIdentifier(ps[0].name) && ps[0].name.text === "this";
    return `${mods}|${name}|${q}|tp${f.typeParameters?.length ?? 0}|p${ps.length - (hasThis ? 1 : 0)}|${tr(f.type)}`;
  }
  if (ts.isConstructorDeclaration(n)) return `${mods}|ctor|p${n.parameters.length}`;
  if (ts.isIndexSignatureDeclaration(n)) return `${mods}|p${n.parameters.length}|${tr(n.type)}`;
  return "";
}

function hirMemberSig(m: number): string {
  const mods = hmods(hir.memberModStart[m], hir.memberModLen[m]);
  const kind = hir.memberKind[m];
  const name = hir.memberKeyKind[m] === H.PK_NAME ? atomText(hir.memberKeyVal[m]) : hir.memberKeyKind[m] === H.PK_PRIVATE ? atomText(hir.memberKeyVal[m]) : "[computed]";
  const q = hir.memberFlags[m] & H.FLAG_OPTIONAL ? "?" : "";
  const f = hir.memberFunc[m];
  if (kind === H.MEMBER_PROPERTY) return `${mods}|${name}|${q}|${htr(hir.memberTy[m])}|${hexpr(hir.memberInit[m])}`;
  if (kind === H.MEMBER_CONSTRUCTOR) return `${mods}|ctor|p${hir.fnParamsLen[f]}`;
  if (kind === H.MEMBER_INDEX_SIGNATURE) return `${mods}|p${hir.fnParamsLen[f]}|${htr(hir.memberTy[m] >= 0 ? hir.memberTy[m] : hir.fnRet[f])}`;
  if (kind === H.MEMBER_STATIC_BLOCK) return "";
  const nm = kind === H.MEMBER_CALL_SIGNATURE || kind === H.MEMBER_CONSTRUCT_SIGNATURE ? "" : name;
  return `${mods}|${nm}|${q}|tp${hir.fnTypeParamsLen[f]}|p${hir.fnParamsLen[f]}|${htr(hir.fnRet[f])}`;
}

// ───────────── jsx ─────────────
function jsxName(n: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isJsxNamespacedName(n)) return n.namespace.text + ":" + n.name.text;
  if (n.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(n)) return jsxName(n.expression as ts.JsxTagNameExpression) + "." + n.name.text;
  return "?";
}
function tsJsxAttrs(attrs: ts.JsxAttributes): string {
  return attrs.properties
    .map((a) => {
      if (ts.isJsxSpreadAttribute(a)) return `...${tr(a.expression)}`;
      const nm = ts.isJsxNamespacedName(a.name) ? a.name.namespace.text + ":" + a.name.name.text : a.name.text;
      const i = a.initializer;
      let v = "-";
      if (i) v = ts.isJsxExpression(i) ? (i.expression ? tr(i.expression) : `${i.getStart(SF)}-${i.getStart(SF)}`) : tr(i);
      return `${nm}=${v}`;
    })
    .join(";");
}
function tsJsxChildren(kids: ts.NodeArray<ts.JsxChild>): string {
  const r: string[] = [];
  for (const k of kids) {
    if (ts.isJsxText(k)) {
      if (k.containsOnlyTriviaWhiteSpaces) continue;
      r.push(`text`);
    } else if (ts.isJsxExpression(k)) {
      if (k.dotDotDotToken) r.push(`spread${k.getStart(SF)}-${k.end}`);
      else r.push(k.expression ? tr(k.expression) : `${k.getStart(SF)}-${k.getStart(SF)}`);
    } else r.push(`${k.getStart(SF)}-${k.end}`);
  }
  return r.join(",");
}
function tsJsxSig(n: ts.Node): string {
  if (ts.isJsxSelfClosingElement(n)) return `${jsxName(n.tagName)}<${tTypes(n.typeArguments)}>|${tsJsxAttrs(n.attributes)}|self`;
  if (ts.isJsxElement(n)) return `${jsxName(n.openingElement.tagName)}<${tTypes(n.openingElement.typeArguments)}>|${tsJsxAttrs(n.openingElement.attributes)}|${tsJsxChildren(n.children)}|${jsxName(n.closingElement.tagName)}|${n.closingElement.getStart(SF)}`;
  if (ts.isJsxFragment(n)) return `frag|${tsJsxChildren(n.children)}|${n.closingFragment.getStart(SF)}`;
  return "?";
}
function hexprName(e: number): string {
  const t = hir.exprTag[e];
  if (t === H.EXPR_IDENT) return atomText(hir.exprA[e]);
  if (t === H.EXPR_STRING) return atomText(hir.exprA[e]);
  if (t === H.EXPR_THIS) return "this";
  if (t === H.EXPR_DOT) return hexprName(hir.exprA[e]) + "." + atomText(hir.exprB[e]);
  return "?";
}
function hirJsxSig(e: number): string {
  const j = hir.exprA[e];
  const attrs = ids(hir.jsxAttrsStart[j], hir.jsxAttrsLen[j])
    .map((p) => (hir.propKind[p] === H.PROP_SPREAD ? `...${hexpr(hir.propValue[p])}` : `${atomText(hir.propKeyVal[p])}=${hexpr(hir.propValue[p])}`))
    .join(";");
  const jsxExprs = new Map<number, number>();
  for (let i = 0; i < hir.nJsxExpressions; i++) jsxExprs.set(hir.jsxExpressionExpr[i], hir.jsxExpressionStart[i]);
  const kids = ids(hir.jsxChildrenStart[j], hir.jsxChildrenLen[j])
    .map((c) => {
      const t = hir.exprTag[c];
      if (t === H.EXPR_JSX) return hexpr(c);
      if (t === H.EXPR_STRING && !jsxExprs.has(c)) return "text";
      if (t === H.EXPR_SPREAD) return `spread${jsxExprs.get(c)}-${hir.jsxExpressionEnd[[...jsxExprs.keys()].indexOf(c)]}`;
      return hexpr(c);
    })
    .join(",");
  if (hir.jsxTag[j] < 0) return `frag|${kids}|${hir.jsxClosePos[j]}`;
  const tn = hexprName(hir.jsxTag[j]);
  const ta = hTypes(hir.jsxTypeArgsStart[j], hir.jsxTypeArgsLen[j]);
  if (hir.jsxClosePos[j] < 0) return `${tn}<${ta}>|${attrs}|self`;
  return `${tn}<${ta}>|${attrs}|${kids}|${hexprName(hir.jsxCloseTag[j])}|${hir.jsxClosePos[j]}`;
}

// ───────────── collect ─────────────
type Sigs = Map<string, string[]>;
function put(m: Sigs, key: string, sig: string): void {
  const a = m.get(key);
  if (a) a.push(sig);
  else m.set(key, [sig]);
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isClassStaticBlockDeclaration(n)
  );
}

function collectTs(sf: ts.SourceFile, cls: string): Sigs {
  const out: Sigs = new Map();
  const visit = (n: ts.Node): void => {
    if (cls === "stmt") {
      if (
        ts.isVariableStatement(n) || ts.isExpressionStatement(n) || ts.isIfStatement(n) || ts.isDoStatement(n) || ts.isWhileStatement(n) ||
        ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isContinueStatement(n) || ts.isBreakStatement(n) ||
        ts.isReturnStatement(n) || ts.isSwitchStatement(n) || ts.isLabeledStatement(n) || ts.isThrowStatement(n) || ts.isTryStatement(n) ||
        ts.isDebuggerStatement(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) ||
        ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n) || ts.isImportDeclaration(n) ||
        ts.isImportEqualsDeclaration(n) || ts.isExportDeclaration(n) || ts.isExportAssignment(n) || ts.isNamespaceExportDeclaration(n) ||
        ts.isEmptyStatement(n) || (ts.isBlock(n) && !(n.parent && isFunctionLike(n.parent)))
      ) {
        put(out, `${n.pos},${n.end}`, tsStmtSig(n));
      }
    } else if (cls === "type") {
      if (ts.isTypeNode(n) && !ts.isParenthesizedTypeNode(n) && !ts.isNamedTupleMember(n) && !ts.isOptionalTypeNode(n) && !ts.isRestTypeNode(n)) {
        let skipIt = ts.isConstTypeReference(n);
        if (ts.isExpressionWithTypeArguments(n) && n.parent && (!ts.isHeritageClause(n.parent) || (n.parent.token === ts.SyntaxKind.ExtendsKeyword && !ts.isInterfaceDeclaration(n.parent.parent)))) skipIt = true;
        if (n.kind === ts.SyntaxKind.ThisType && n.parent && ts.isTypePredicateNode(n.parent) && n.parent.parameterName === n) skipIt = true;
        if (ts.isLiteralTypeNode(n) && n.parent && ts.isImportTypeNode(n.parent) && n.parent.argument === n) skipIt = true;
        if (n.kind === ts.SyntaxKind.SymbolKeyword && n.parent && ts.isTypeOperatorNode(n.parent) && n.parent.operator === ts.SyntaxKind.UniqueKeyword) skipIt = true;
        if (ts.isTemplateLiteralTypeSpan(n as ts.Node)) skipIt = true;
        if (!skipIt) put(out, `${n.getStart(SF)},${n.end}`, tsTypeSig(n));
      }
    } else if (cls === "member") {
      if ((ts.isTypeElement(n) || ts.isClassElement(n)) && !ts.isSemicolonClassElement(n) && !(n.parent && ts.isObjectLiteralExpression(n.parent))) {
        put(out, `${n.pos},${n.end}`, tsMemberSig(n));
      }
    } else if (cls === "jsx") {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) put(out, `${n.getStart(SF)},${n.end}`, tsJsxSig(n));
    } else if (cls === "typeParam") {
      if (ts.isTypeParameterDeclaration(n)) put(out, `${n.getStart(SF)},${n.end}`, `${n.name.text}|${tr(n.constraint)}|${tr(n.default)}|${tsMods(n)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function collectHir(cls: string): Sigs {
  const out: Sigs = new Map();
  if (cls === "stmt") {
    const skipSet = new Set<number>();
    for (let s = 0; s < hir.nStmts; s++) {
      const t = hir.stmtTag[s];
      if (t === H.STMT_FOR || t === H.STMT_FOR_IN || t === H.STMT_FOR_OF) skipSet.add(hir.stmtA[s]);
    }
    for (let s = 0; s < hir.nStmts; s++) {
      if (skipSet.has(s)) continue;
      put(out, `${hir.stmtLocPos[s]},${hir.stmtLocEnd[s]}`, hirStmtSig(s));
    }
  } else if (cls === "type") {
    for (let t = 0; t < hir.nTypes; t++) put(out, `${hir.typePos[t]},${hir.typeEnd[t]}`, hirTypeSig(t));
  } else if (cls === "member") {
    for (let m = 0; m < hir.nMembers; m++) put(out, `${hir.memberLocPos[m]},${hir.memberLocEnd[m]}`, hirMemberSig(m));
  } else if (cls === "jsx") {
    for (let e = 0; e < hir.nExprs; e++) if (hir.exprTag[e] === H.EXPR_JSX) put(out, `${hir.exprPos[e]},${hir.exprEnd[e]}`, hirJsxSig(e));
  } else if (cls === "typeParam") {
    for (let m = 0; m < hir.nTypeParams; m++) {
      put(out, `${hir.typeParamStart[m]},${hir.typeParamEnd[m]}`, `${atomText(hir.typeParamName[m])}|${htr(hir.typeParamConstraint[m])}|${htr(hir.typeParamDefault[m])}|${hmods(hir.typeParamModStart[m], hir.typeParamModLen[m])}`);
    }
  }
  return out;
}

const classes = only ? [only] : ["stmt", "type", "member", "typeParam", "jsx"];
const list: string[] = files.length > 0 ? files : [...walk(root)];
let checked = 0;
const stat = new Map<string, { nodes: number; bad: number; ex: string[] }>();
for (const c of classes) stat.set(c, { nodes: 0, bad: 0, ex: [] });
for (let fi = skip; fi < list.length && checked < limit; fi++) {
  const file = list[fi];
  const buf = fs.readFileSync(file);
  const text = buf.toString("latin1"); // one char per byte: the positions of the HIR are bytes
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, JS ? (file.endsWith("x") ? ts.ScriptKind.JSX : ts.ScriptKind.JS) : file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if ((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0) continue;
  SF = sf;
  const src = new Uint8Array(buf.length + 16);
  src.set(buf);
  const r = parseFile(src, buf.length, file, false);
  if (r !== 0) {
    console.log("REFUSED", file, refusalName(r), lx.refusedAt);
    continue;
  }
  checked++;
  for (const c of classes) {
    const st = stat.get(c)!;
    const a = collectHir(c);
    const b = collectTs(sf, c);
    for (const [k, sa] of a) {
      const sb = b.get(k);
      if (!sb) continue; // the position check reports the missing nodes
      st.nodes += sa.length;
      const x = [...sa].sort().join("\n");
      const y = [...sb].sort().join("\n");
      if (x !== y) {
        st.bad++;
        if (st.ex.length < show) st.ex.push(`${file} @${k} ${JSON.stringify(text.slice(+k.split(",")[0], +k.split(",")[0] + 50))}\n      HIR: ${x}\n      TS : ${y}`);
      }
    }
  }
}
console.log(`checked ${checked} files`);
for (const c of classes) {
  const st = stat.get(c)!;
  console.log(`${c.padEnd(10)} nodes ${st.nodes} mismatching ${st.bad}`);
  for (const e of st.ex) console.log("    " + e);
}
