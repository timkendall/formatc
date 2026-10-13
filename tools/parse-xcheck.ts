// Cross-checks the HIR of the sema parser against TypeScript's own parser (node_modules/typescript) on the vscode corpus.
// Bun's parser follows typescript-go, so for every node class that is ported a TS node of the corresponding kind must exist with the
// same (start, end): `node.getStart()` / `node.end` against the `pos` / `end` columns of the HIR rows.
//
//   node tools/parse-xcheck.ts [--limit N] [--stride K] [--only substring] [--verbose] [--samples N] [--list F] [--root R]
//
// Forward check: every HIR row of exprs, stmts, types, patterns, binding elements, params, type params, members, props, var decls,
// cases, import/export specifiers, enum members, tuple elements has a TS node of an allowed kind at the same range.
// Reverse check: every TS node of the main expression kinds (and statements) has a HIR row at the same range.
// Only runs under node. Files that our parser refuses are skipped (and counted).
import * as fs from "node:fs";
import ts from "typescript";
import * as H from "../src/sema/hir.ts";
import { hir } from "../src/sema/hir.ts";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { lx } from "../src/sema/parser/parser/mod.ts";

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) if (a[i] === name) return a[i + 1];
  return dflt;
}
const limit = parseInt(arg("--limit", "0"), 10);
const stride = parseInt(arg("--stride", "1"), 10);
const only = arg("--only", "");
const maxSamples = parseInt(arg("--samples", "4"), 10);
const verbose = process.argv.includes("--verbose");
const root = arg("--root", "bench/vscode");
const listPath = arg("--list", "/tmp/vscode-files.txt");

const K = ts.SyntaxKind;
type KindSet = number[];

function isTarget(p: string): boolean {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p);
}

// ───────────────────────── HIR tag -> TS kinds ─────────────────────────

const KEYWORD_TYPE_KINDS: KindSet = [
  K.AnyKeyword, K.UnknownKeyword, K.NeverKeyword, K.VoidKeyword, K.UndefinedKeyword, K.StringKeyword, K.NumberKeyword,
  K.BooleanKeyword, K.BigIntKeyword, K.SymbolKeyword, K.ObjectKeyword, K.ThisType, K.LiteralType, K.IntrinsicKeyword,
  K.TypeReference,
];
const UNARY_KINDS: KindSet = [
  K.PrefixUnaryExpression, K.PostfixUnaryExpression, K.DeleteExpression, K.TypeOfExpression, K.VoidExpression,
];

const EXPR_KINDS: Record<number, KindSet> = {
  [H.EXPR_IDENT]: [K.Identifier],
  [H.EXPR_PRIVATE_IDENTIFIER]: [K.PrivateIdentifier],
  [H.EXPR_THIS]: [K.ThisKeyword],
  [H.EXPR_SUPER]: [K.SuperKeyword],
  [H.EXPR_NULL]: [K.NullKeyword],
  [H.EXPR_TRUE]: [K.TrueKeyword],
  [H.EXPR_FALSE]: [K.FalseKeyword],
  [H.EXPR_NUMBER]: [K.NumericLiteral],
  [H.EXPR_STRING]: [K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.JsxText],
  [H.EXPR_BIG_INT]: [K.BigIntLiteral],
  [H.EXPR_REGEX]: [K.RegularExpressionLiteral],
  [H.EXPR_TEMPLATE]: [K.TemplateExpression],
  [H.EXPR_TAGGED_TEMPLATE]: [K.TaggedTemplateExpression],
  [H.EXPR_ARRAY]: [K.ArrayLiteralExpression],
  [H.EXPR_OBJECT]: [K.ObjectLiteralExpression],
  [H.EXPR_FN]: [K.FunctionExpression, K.ArrowFunction],
  [H.EXPR_CLASS]: [K.ClassExpression],
  [H.EXPR_DOT]: [K.PropertyAccessExpression],
  [H.EXPR_INDEX]: [K.ElementAccessExpression],
  [H.EXPR_CALL]: [K.CallExpression],
  [H.EXPR_NEW]: [K.NewExpression],
  [H.EXPR_UNARY]: UNARY_KINDS,
  [H.EXPR_BINARY]: [K.BinaryExpression],
  [H.EXPR_ASSIGN]: [K.BinaryExpression],
  [H.EXPR_COND]: [K.ConditionalExpression],
  [H.EXPR_SPREAD]: [K.SpreadElement],
  [H.EXPR_AWAIT]: [K.AwaitExpression],
  [H.EXPR_YIELD]: [K.YieldExpression],
  [H.EXPR_AS]: [K.AsExpression, K.TypeAssertionExpression],
  [H.EXPR_SATISFIES]: [K.SatisfiesExpression],
  [H.EXPR_AS_CONST]: [K.AsExpression, K.TypeAssertionExpression],
  [H.EXPR_NON_NULL]: [K.NonNullExpression],
  [H.EXPR_INSTANTIATION]: [K.ExpressionWithTypeArguments],
  [H.EXPR_JSX]: [K.JsxElement, K.JsxSelfClosingElement, K.JsxFragment],
  [H.EXPR_IMPORT_CALL]: [K.CallExpression],
  [H.EXPR_IMPORT_META]: [K.MetaProperty],
  [H.EXPR_NEW_TARGET]: [K.MetaProperty],
};

const STMT_KINDS: Record<number, KindSet> = {
  [H.STMT_EMPTY]: [K.EmptyStatement],
  [H.STMT_DEBUGGER]: [K.DebuggerStatement],
  [H.STMT_EXPR]: [K.ExpressionStatement],
  [H.STMT_VAR]: [K.VariableStatement, K.VariableDeclarationList],
  [H.STMT_FN]: [K.FunctionDeclaration],
  [H.STMT_CLASS]: [K.ClassDeclaration],
  [H.STMT_INTERFACE]: [K.InterfaceDeclaration],
  [H.STMT_TYPE_ALIAS]: [K.TypeAliasDeclaration],
  [H.STMT_ENUM]: [K.EnumDeclaration],
  [H.STMT_MODULE]: [K.ModuleDeclaration],
  [H.STMT_RETURN]: [K.ReturnStatement],
  [H.STMT_IF]: [K.IfStatement],
  [H.STMT_FOR]: [K.ForStatement],
  [H.STMT_FOR_IN]: [K.ForInStatement],
  [H.STMT_FOR_OF]: [K.ForOfStatement],
  [H.STMT_WHILE]: [K.WhileStatement],
  [H.STMT_DO_WHILE]: [K.DoStatement],
  [H.STMT_BLOCK]: [K.Block],
  [H.STMT_SWITCH]: [K.SwitchStatement],
  [H.STMT_TRY]: [K.TryStatement],
  [H.STMT_THROW]: [K.ThrowStatement],
  [H.STMT_BREAK]: [K.BreakStatement],
  [H.STMT_CONTINUE]: [K.ContinueStatement],
  [H.STMT_LABELED]: [K.LabeledStatement],
  [H.STMT_IMPORT]: [K.ImportDeclaration],
  [H.STMT_IMPORT_EQUALS]: [K.ImportEqualsDeclaration],
  [H.STMT_EXPORT_NAMED]: [K.ExportDeclaration],
  [H.STMT_EXPORT_STAR]: [K.ExportDeclaration],
  [H.STMT_EXPORT_DEFAULT]: [K.ExportAssignment],
  [H.STMT_EXPORT_ASSIGN]: [K.ExportAssignment],
  [H.STMT_EXPORT_AS_NAMESPACE]: [K.NamespaceExportDeclaration],
};

const TYPE_KINDS: Record<number, KindSet> = {
  [H.TYPE_HERITAGE]: [K.ExpressionWithTypeArguments, K.TypeReference],
  [H.TYPE_KEYWORD]: KEYWORD_TYPE_KINDS,
  [H.TYPE_REF]: [K.TypeReference, K.ExpressionWithTypeArguments],
  [H.TYPE_STRING_LIT]: [K.LiteralType],
  [H.TYPE_NUMBER_LIT]: [K.LiteralType],
  [H.TYPE_BIG_INT_LIT]: [K.LiteralType],
  [H.TYPE_BOOL_LIT]: [K.LiteralType],
  [H.TYPE_TEMPLATE]: [K.TemplateLiteralType],
  [H.TYPE_ARRAY]: [K.ArrayType],
  [H.TYPE_TUPLE]: [K.TupleType],
  [H.TYPE_UNION]: [K.UnionType],
  [H.TYPE_INTERSECTION]: [K.IntersectionType],
  [H.TYPE_FN]: [K.FunctionType, K.ConstructorType],
  [H.TYPE_OBJECT]: [K.TypeLiteral],
  [H.TYPE_COND]: [K.ConditionalType],
  [H.TYPE_INFER]: [K.InferType],
  [H.TYPE_MAPPED]: [K.MappedType],
  [H.TYPE_INDEXED_ACCESS]: [K.IndexedAccessType],
  [H.TYPE_KEYOF]: [K.TypeOperator],
  [H.TYPE_READONLY]: [K.TypeOperator],
  [H.TYPE_UNIQUE_SYMBOL]: [K.TypeOperator],
  [H.TYPE_UNIQUE]: [K.TypeOperator],
  [H.TYPE_TYPEOF]: [K.TypeQuery],
  [H.TYPE_IMPORT]: [K.ImportType],
  [H.TYPE_PREDICATE]: [K.TypePredicate],
};

const PAT_KINDS: Record<number, KindSet> = {
  [H.PAT_IDENT]: [K.Identifier, K.ThisKeyword],
  [H.PAT_OBJECT]: [K.ObjectBindingPattern],
  [H.PAT_ARRAY]: [K.ArrayBindingPattern],
  [H.PAT_MISSING]: [K.OmittedExpression],
};

function name(prefix: string, v: number): string {
  for (const k of Object.keys(H)) if (k.startsWith(prefix) && (H as any)[k] === v) return k.slice(prefix.length);
  return String(v);
}

// ───────────────────────── mismatch accounting ─────────────────────────

class Stat {
  count = 0;
  total = 0;
  samples: string[] = [];
}
const stats = new Map<string, Stat>();
function stat(label: string): Stat {
  let s = stats.get(label);
  if (!s) {
    s = new Stat();
    stats.set(label, s);
  }
  return s;
}

// ───────────────────────── per file ─────────────────────────

let cur = "";
let curText = "";
let curSf: ts.SourceFile;

/** (start, end) -> kinds of the TS nodes there. */
let nodeMap = new Map<number, number[]>();
const SHIFT = 4194304; // 2^22
function key(start: number, end: number): number {
  return start * SHIFT + end;
}

/** (start, end) of a BinaryExpression -> its operator token kinds. */
let opMap = new Map<number, number[]>();

const BIN_TS: Record<number, number> = {
  [H.BIN_ADD]: K.PlusToken, [H.BIN_SUB]: K.MinusToken, [H.BIN_MUL]: K.AsteriskToken, [H.BIN_DIV]: K.SlashToken,
  [H.BIN_REM]: K.PercentToken, [H.BIN_POW]: K.AsteriskAsteriskToken, [H.BIN_SHL]: K.LessThanLessThanToken,
  [H.BIN_SHR]: K.GreaterThanGreaterThanToken, [H.BIN_USHR]: K.GreaterThanGreaterThanGreaterThanToken,
  [H.BIN_BIT_AND]: K.AmpersandToken, [H.BIN_BIT_OR]: K.BarToken, [H.BIN_BIT_XOR]: K.CaretToken, [H.BIN_LT]: K.LessThanToken,
  [H.BIN_LE]: K.LessThanEqualsToken, [H.BIN_GT]: K.GreaterThanToken, [H.BIN_GE]: K.GreaterThanEqualsToken,
  [H.BIN_EQ_EQ]: K.EqualsEqualsToken, [H.BIN_NOT_EQ]: K.ExclamationEqualsToken, [H.BIN_EQ_EQ_EQ]: K.EqualsEqualsEqualsToken,
  [H.BIN_NOT_EQ_EQ]: K.ExclamationEqualsEqualsToken, [H.BIN_IN]: K.InKeyword, [H.BIN_INSTANCEOF]: K.InstanceOfKeyword,
  [H.BIN_AND]: K.AmpersandAmpersandToken, [H.BIN_OR]: K.BarBarToken, [H.BIN_NULLISH]: K.QuestionQuestionToken,
  [H.BIN_COMMA]: K.CommaToken,
};
const ASSIGN_TS: Record<number, number> = {
  0: K.EqualsToken,
  [H.BIN_ADD + 1]: K.PlusEqualsToken, [H.BIN_SUB + 1]: K.MinusEqualsToken, [H.BIN_MUL + 1]: K.AsteriskEqualsToken,
  [H.BIN_DIV + 1]: K.SlashEqualsToken, [H.BIN_REM + 1]: K.PercentEqualsToken, [H.BIN_POW + 1]: K.AsteriskAsteriskEqualsToken,
  [H.BIN_SHL + 1]: K.LessThanLessThanEqualsToken, [H.BIN_SHR + 1]: K.GreaterThanGreaterThanEqualsToken,
  [H.BIN_USHR + 1]: K.GreaterThanGreaterThanGreaterThanEqualsToken, [H.BIN_BIT_AND + 1]: K.AmpersandEqualsToken,
  [H.BIN_BIT_OR + 1]: K.BarEqualsToken, [H.BIN_BIT_XOR + 1]: K.CaretEqualsToken, [H.BIN_OR + 1]: K.BarBarEqualsToken,
  [H.BIN_AND + 1]: K.AmpersandAmpersandEqualsToken, [H.BIN_NULLISH + 1]: K.QuestionQuestionEqualsToken,
};
const UNARY_TS: Record<number, number> = {
  [H.UN_PLUS]: K.PlusToken, [H.UN_MINUS]: K.MinusToken, [H.UN_BIT_NOT]: K.TildeToken, [H.UN_NOT]: K.ExclamationToken,
  [H.UN_TYPEOF]: K.TypeOfKeyword, [H.UN_VOID]: K.VoidKeyword, [H.UN_DELETE]: K.DeleteKeyword, [H.UN_PRE_INC]: K.PlusPlusToken,
  [H.UN_PRE_DEC]: K.MinusMinusToken, [H.UN_POST_INC]: K.PlusPlusToken, [H.UN_POST_DEC]: K.MinusMinusToken,
};

function collect(node: ts.Node): void {
  if (node.kind === K.BinaryExpression) {
    const k = key(node.getStart(curSf), node.end);
    const o = opMap.get(k);
    const op = (node as ts.BinaryExpression).operatorToken.kind;
    if (o === undefined) opMap.set(k, [op]);
    else o.push(op);
  } else if (node.kind === K.PrefixUnaryExpression || node.kind === K.PostfixUnaryExpression) {
    const k = key(node.getStart(curSf), node.end) + 0.5;
    const o = opMap.get(k);
    const op = (node as ts.PrefixUnaryExpression).operator;
    if (o === undefined) opMap.set(k, [op]);
    else o.push(op);
  } else if (node.kind === K.DeleteExpression || node.kind === K.TypeOfExpression || node.kind === K.VoidExpression) {
    const k = key(node.getStart(curSf), node.end) + 0.5;
    const o = opMap.get(k);
    const op = node.kind === K.DeleteExpression ? K.DeleteKeyword : node.kind === K.TypeOfExpression ? K.TypeOfKeyword : K.VoidKeyword;
    if (o === undefined) opMap.set(k, [op]);
    else o.push(op);
  }
  collect1(node);
}

function collect1(node: ts.Node): void {
  // TS skips the white space at the start of a JsxText in `getStart`; the HIR text token starts after the `>`.
  const start = node.kind === K.JsxText ? node.pos : node.getStart(curSf);
  const k = key(start, node.end);
  const l = nodeMap.get(k);
  if (l === undefined) nodeMap.set(k, [node.kind]);
  else l.push(node.kind);
  ts.forEachChild(node, collect);
}

/** UTF-8 byte offset -> UTF-16 index (identity for ASCII files). */
let u16: Int32Array | null = null;
function buildU16(buf: Buffer, len: number): void {
  let ascii = true;
  for (let i = 0; i < len; i++)
    if (buf[i] >= 0x80) {
      ascii = false;
      break;
    }
  if (ascii) {
    u16 = null;
    return;
  }
  u16 = new Int32Array(len + 2);
  let j = 0;
  for (let i = 0; i < len; i++) {
    u16[i] = j;
    const c = buf[i];
    if (c < 0x80) j += 1;
    else if (c >= 0xc0) j += c >= 0xf0 ? 2 : 1; // lead byte: 4-byte sequence = surrogate pair
  }
  u16[len] = j;
  u16[len + 1] = j;
}
function cv(pos: number): number {
  return u16 === null ? pos : u16[pos];
}

function snippet(start: number, end: number): string {
  const t = curText.slice(start, Math.min(end, start + 50)).replace(/\s+/g, " ");
  return JSON.stringify(t);
}

function present(start: number, end: number): string {
  // The TS nodes that start at `start`, for the message.
  const out: string[] = [];
  for (const [k, kinds] of nodeMap) {
    if (Math.floor(k / SHIFT) === start) for (const kind of kinds) out.push(ts.SyntaxKind[kind] + "-" + (k % SHIFT));
    if (out.length > 6) break;
  }
  void end;
  return out.join(",");
}

/** A HIR row (byte offsets `bs`, `be`) of the class `label` must have a TS node of one of `kinds` at that range. */
function expect(label: string, bs: number, be: number, kinds: KindSet | undefined, extra = ""): void {
  const st = stat(label);
  st.total++;
  const s = cv(bs);
  const e = cv(be);
  const l = nodeMap.get(key(s, e));
  if (l !== undefined) {
    if (kinds === undefined) return;
    for (let i = 0; i < l.length; i++) if (kinds.includes(l[i])) return;
  }
  st.count++;
  if (st.samples.length < maxSamples) {
    st.samples.push(`${cur}:${s}-${e} ${snippet(s, e)} ${extra} here=[${present(s, e)}]`);
  }
}

function fnKindOfExpr(e: number): number {
  return hir.fnKind[hir.exprA[e]] | 0;
}

const byDesign = new Map<string, number>();
function design(reason: string): void {
  byDesign.set(reason, (byDesign.get(reason) ?? 0) + 1);
}

// Rows that differ from TypeScript's tree by design (they are the same in the Rust parser): see `markByDesign`.
let skipExpr = new Set<number>();
let skipStmt = new Set<number>();
let skipProp = new Set<number>();

function markDotChain(e: number): void {
  while (e >= 0) {
    skipExpr.add(e);
    const tag = hir.exprTag[e];
    if (tag === H.EXPR_DOT || tag === H.EXPR_INDEX) e = hir.exprA[e];
    else break;
  }
}

function markByDesign(): void {
  skipExpr = new Set();
  skipStmt = new Set();
  skipProp = new Set();
  // `typeof a.b.c`: the entity name is an expression in HIR, a QualifiedName in TS.
  for (let t = 0; t < hir.nTypes; t++) {
    if (hir.typeTag[t] === H.TYPE_TYPEOF && hir.typeE[t] >= 0) markDotChain(hir.typeE[t]);
  }
  // `with { type: "json" }`: ImportAttributes in TS.
  for (let i = 0; i < hir.importAttributesLen; i += 2) {
    const o = hir.importAttributes[i + 1];
    skipExpr.add(o);
    if (hir.exprTag[o] === H.EXPR_OBJECT) {
      const a = hir.exprA[o];
      const b = hir.exprB[o];
      for (let k = 0; k < b; k++) skipProp.add(hir.ids[a + k]);
    }
  }
  for (let s = 0; s < hir.nStmts; s++) {
    const tag = hir.stmtTag[s];
    // `for (init; ..)`: an expression statement in HIR.
    if (tag === H.STMT_FOR || tag === H.STMT_FOR_IN || tag === H.STMT_FOR_OF) {
      const init = hir.stmtA[s];
      if (init >= 0 && hir.stmtTag[init] === H.STMT_EXPR) skipStmt.add(init);
    }
    // `finally { }`: the block starts at the keyword.
    if (tag === H.STMT_TRY && hir.stmtD[s] >= 0) skipStmt.add(hir.stmtD[s]);
  }
}

function checkFile(buf: Buffer, len: number, path: string, isScript: boolean): void {
  cur = path;
  curText = buf.toString("utf8", 0, len);
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(ts|mts|cts)$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  curSf = ts.createSourceFile(path, curText, ts.ScriptTarget.Latest, true, kind);
  nodeMap = new Map();
  opMap = new Map();
  collect(curSf);
  buildU16(buf, len);
  void isScript;
  markByDesign();

  // exprs
  for (let e = 0; e < hir.nExprs; e++) {
    const tag = hir.exprTag[e];
    if (tag === H.EXPR_MISSING) continue;
    if (skipExpr.has(e)) {
      design("expr in `typeof a.b` / import attributes");
      continue;
    }
    // A JSX child `{...x}` (HIR: a Spread that starts at the element, as in Rust).
    if (tag === H.EXPR_SPREAD && !curText.startsWith("...", cv(hir.exprPos[e]))) {
      design("JSX child {...x}");
      continue;
    }
    if (tag === H.EXPR_FN) {
      const fk = fnKindOfExpr(e);
      if (fk === H.FN_METHOD || fk === H.FN_GETTER || fk === H.FN_SETTER) {
        design("object literal method fn (starts at the parenthesis)");
        continue;
      }
    }
    expect("expr:" + name("EXPR_", tag), hir.exprPos[e], hir.exprEnd[e], EXPR_KINDS[tag]);
    // operators
    if (tag === H.EXPR_BINARY || tag === H.EXPR_ASSIGN || tag === H.EXPR_UNARY) {
      const s0 = cv(hir.exprPos[e]);
      const e0 = cv(hir.exprEnd[e]);
      const want = tag === H.EXPR_BINARY ? BIN_TS[hir.exprAux[e]] : tag === H.EXPR_ASSIGN ? ASSIGN_TS[hir.exprAux[e]] : UNARY_TS[hir.exprAux[e]];
      const have = opMap.get(key(s0, e0) + (tag === H.EXPR_UNARY ? 0.5 : 0));
      const st = stat("op:" + name("EXPR_", tag));
      st.total++;
      if (have === undefined || !have.includes(want)) {
        st.count++;
        if (st.samples.length < maxSamples) st.samples.push(`${cur}:${s0}-${e0} ${snippet(s0, e0)} op=${hir.exprAux[e]} ts=${have}`);
      }
    }
  }
  // stmts
  for (let s = 0; s < hir.nStmts; s++) {
    const tag = hir.stmtTag[s];
    if (hir.stmtLocEnd[s] === 0 && hir.stmtLocPos[s] === 0) continue; // loc not set (e.g. json)
    if (skipStmt.has(s)) {
      design("for-init expression statement / finally block");
      continue;
    }
    expect("stmt:" + name("STMT_", tag), hir.stmtStart[s], hir.stmtLocEnd[s], STMT_KINDS[tag]);
  }
  // types
  for (let t = 0; t < hir.nTypes; t++) {
    const tag = hir.typeTag[t];
    if (tag === H.TYPE_ERROR) continue;
    expect("type:" + name("TYPE_", tag), hir.typePos[t], hir.typeEnd[t], TYPE_KINDS[tag]);
  }
  // patterns
  for (let t = 0; t < hir.nPats; t++) {
    const tag = hir.patTag[t];
    if (tag === H.PAT_MISSING) {
      design("array pattern hole (pos > end as in Rust)");
      continue;
    } // a hole: `pos` is the token, `end` the end of the previous (as in Rust)
    expect("pat:" + name("PAT_", tag), hir.patPos[t], hir.patEnd[t], PAT_KINDS[tag]);
  }
  for (let i = 0; i < hir.nPatProps; i++) expect("patProp", hir.patPropPos[i], hir.patPropEnd[i], [K.BindingElement]);
  for (let i = 0; i < hir.nPatElems; i++) {
    const pt = hir.patElemPat[i];
    if (pt >= 0 && hir.patTag[pt] === H.PAT_MISSING) continue;
    expect("patElem", hir.patElemStart[i], hir.patElemEnd[i], [K.BindingElement]);
  }
  // params
  for (let i = 0; i < hir.nParams; i++) {
    if (hir.paramLocEnd[i] === 0) continue;
    expect("param", hir.paramPos[i], hir.paramLocEnd[i], [K.Parameter]);
  }
  for (let i = 0; i < hir.nTypeParams; i++) expect("typeParam", hir.typeParamStart[i], hir.typeParamEnd[i], [K.TypeParameter]);
  // members (class and type members)
  for (let i = 0; i < hir.nMembers; i++) {
    expect("member:" + name("MEMBER_", hir.memberKind[i]), hir.memberStart[i], hir.memberLocEnd[i], [
      K.PropertyDeclaration, K.MethodDeclaration, K.Constructor, K.GetAccessor, K.SetAccessor, K.IndexSignature,
      K.ClassStaticBlockDeclaration, K.PropertySignature, K.MethodSignature, K.CallSignature, K.ConstructSignature,
    ]);
  }
  // props (object literal)
  for (let i = 0; i < hir.nProps; i++) {
    if (hir.propEnd[i] === 0) continue;
    if (skipProp.has(i)) {
      design("import attributes property");
      continue;
    }
    expect("prop:" + name("PROP_", hir.propKind[i]), hir.propStart[i], hir.propEnd[i], [
      K.PropertyAssignment, K.ShorthandPropertyAssignment, K.SpreadAssignment, K.MethodDeclaration, K.GetAccessor,
      K.SetAccessor, K.JsxAttribute, K.JsxSpreadAttribute,
    ]);
  }
  for (let i = 0; i < hir.nVarDecls; i++) {
    const pat = hir.varDeclPat[i];
    if (pat < 0 || hir.varDeclLocEnd[i] === 0) continue;
    expect("varDecl", hir.patPos[pat], hir.varDeclLocEnd[i], [K.VariableDeclaration]);
  }
  for (let i = 0; i < hir.nCases; i++) expect("case", hir.casePos[i], hir.caseEnd[i], [K.CaseClause, K.DefaultClause]);
  for (let i = 0; i < hir.nImportSpecs; i++) expect("importSpec", hir.importSpecStart[i], hir.importSpecEnd[i], [K.ImportSpecifier]);
  for (let i = 0; i < hir.nExportSpecs; i++) expect("exportSpec", hir.exportSpecStart[i], hir.exportSpecEnd[i], [K.ExportSpecifier]);
  for (let i = 0; i < hir.nEnumMembers; i++) expect("enumMember", hir.enumMemberPos[i], hir.enumMemberLocEnd[i], [K.EnumMember]);
  for (let i = 0; i < hir.nTupleElems; i++) {
    expect("tupleElem", hir.tupleElemStart[i], hir.tupleElemEnd[i], undefined);
  }

  // Reverse: TS nodes that must have a HIR row.
  const have = new Set<number>();
  const haveStmt = new Set<number>();
  const rev = (bs: number, be: number, set: Set<number>) => set.add(key(cv(bs), cv(be)));
  for (let e = 0; e < hir.nExprs; e++) rev(hir.exprPos[e], hir.exprEnd[e], have);
  for (let s = 0; s < hir.nStmts; s++) rev(hir.stmtStart[s], hir.stmtLocEnd[s], haveStmt);
  const REV_EXPR: number[] = [
    K.BinaryExpression, K.CallExpression, K.PropertyAccessExpression, K.ElementAccessExpression, K.ConditionalExpression,
    K.ArrowFunction, K.FunctionExpression, K.ObjectLiteralExpression, K.ArrayLiteralExpression, K.NewExpression,
    K.TemplateExpression, K.TaggedTemplateExpression, K.AsExpression, K.NonNullExpression, K.AwaitExpression, K.YieldExpression,
    K.PrefixUnaryExpression, K.PostfixUnaryExpression, K.SpreadElement, K.ClassExpression, K.TypeOfExpression,
    K.DeleteExpression, K.VoidExpression, K.SatisfiesExpression, K.TypeAssertionExpression, K.StringLiteral, K.NumericLiteral,
    K.RegularExpressionLiteral, K.ThisKeyword, K.JsxElement, K.JsxSelfClosingElement, K.JsxFragment,
  ];
  const REV_STMT: number[] = [
    K.ExpressionStatement, K.VariableStatement, K.FunctionDeclaration, K.ClassDeclaration, K.InterfaceDeclaration,
    K.TypeAliasDeclaration, K.EnumDeclaration, K.ModuleDeclaration, K.ReturnStatement, K.IfStatement, K.ForStatement,
    K.ForInStatement, K.ForOfStatement, K.WhileStatement, K.DoStatement, K.Block, K.SwitchStatement, K.TryStatement,
    K.ThrowStatement, K.BreakStatement, K.ContinueStatement, K.LabeledStatement, K.ImportDeclaration, K.ExportDeclaration,
    K.ExportAssignment, K.EmptyStatement, K.ImportEqualsDeclaration,
  ];
  const revExpr = new Set(REV_EXPR);
  const revStmt = new Set(REV_STMT);
  const walk = (node: ts.Node): void => {
    const k = node.kind;
    if (revExpr.has(k) || revStmt.has(k)) {
      const start = node.getStart(curSf);
      const kk = key(start, node.end);
      if (revExpr.has(k)) {
        // A function body block / class body is not a statement; string literals that are names/specifiers are not expressions.
        const st = stat("rev-expr:" + ts.SyntaxKind[k]);
        const parent = node.parent;
        let skip = false;
        if (k === K.StringLiteral || k === K.NumericLiteral) {
          // names, module specifiers, enum member names, property keys, literal types, import attributes
          skip = !(parent && isExprPosition(node, parent));
        }
        if (k === K.ThisKeyword && parent && (parent.kind === K.ThisType || parent.kind === K.TypePredicate || parent.kind === K.Parameter)) skip = true;
        if (k === K.PropertyAccessExpression && inTypeOnlyHeritage(node)) skip = true;
        if (k === K.NumericLiteral && parent && parent.kind === K.PrefixUnaryExpression && parent.parent && parent.parent.kind === K.LiteralType) skip = true;
        if (k === K.PrefixUnaryExpression && parent && parent.kind === K.LiteralType) skip = true;
        if (k === K.ArrowFunction || k === K.FunctionExpression) skip = false;
        if (!skip) {
          st.total++;
          if (!have.has(kk)) {
            st.count++;
            if (st.samples.length < maxSamples) st.samples.push(`${cur}:${start}-${node.end} ${snippet(start, node.end)}`);
          }
        }
      }
      if (revStmt.has(k) && !(k === K.Block && (isBodyBlock(node) || isFinallyBlock(node)))) {
        const st = stat("rev-stmt:" + ts.SyntaxKind[k]);
        st.total++;
        if (!haveStmt.has(kk)) {
          st.count++;
          if (st.samples.length < maxSamples) st.samples.push(`${cur}:${start}-${node.end} ${snippet(start, node.end)}`);
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(curSf);
}

/** A string/number literal that is an expression (not a name, specifier, literal type, enum member name...). */
function isExprPosition(node: ts.Node, parent: ts.Node): boolean {
  switch (parent.kind) {
    case K.PropertyAssignment:
    case K.PropertyDeclaration:
    case K.PropertySignature:
    case K.MethodDeclaration:
    case K.MethodSignature:
    case K.GetAccessor:
    case K.SetAccessor:
    case K.EnumMember:
    case K.BindingElement:
    case K.ImportDeclaration:
    case K.ExportDeclaration:
    case K.ImportEqualsDeclaration:
    case K.ModuleDeclaration:
    case K.ExternalModuleReference:
    case K.LiteralType:
    case K.ImportSpecifier:
    case K.ExportSpecifier:
    case K.ImportAttribute:
    case K.JsxAttribute:
    case K.ShorthandPropertyAssignment:
    case K.NamedTupleMember:
    case K.TypeParameter:
    case K.Parameter:
    case K.ImportType:
    case K.ComputedPropertyName:
      if (parent.kind === K.ComputedPropertyName) return false;
      if (parent.kind === K.PropertyAssignment) return (parent as ts.PropertyAssignment).initializer === node;
      if (parent.kind === K.PropertyDeclaration) return (parent as ts.PropertyDeclaration).initializer === node;
      if (parent.kind === K.Parameter) return (parent as ts.ParameterDeclaration).initializer === node;
      if (parent.kind === K.BindingElement) return (parent as ts.BindingElement).initializer === node;
      if (parent.kind === K.EnumMember) return (parent as ts.EnumMember).initializer === node;
      return false;
    default:
      return true;
  }
}

/** A property access in `implements a.b` or `interface I extends a.b`: HIR has a type there. */
function inTypeOnlyHeritage(node: ts.Node): boolean {
  let n: ts.Node | undefined = node.parent;
  while (n && (n.kind === K.PropertyAccessExpression)) n = n.parent;
  if (!n || n.kind !== K.ExpressionWithTypeArguments) return false;
  const hc = n.parent;
  if (!hc || hc.kind !== K.HeritageClause) return false;
  const owner = hc.parent;
  return (hc as ts.HeritageClause).token === K.ImplementsKeyword || (owner && owner.kind === K.InterfaceDeclaration);
}

function isFinallyBlock(node: ts.Node): boolean {
  const p = node.parent;
  return !!p && p.kind === K.TryStatement && (p as ts.TryStatement).finallyBlock === node;
}

function isBodyBlock(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  switch (p.kind) {
    case K.FunctionDeclaration:
    case K.FunctionExpression:
    case K.ArrowFunction:
    case K.MethodDeclaration:
    case K.Constructor:
    case K.GetAccessor:
    case K.SetAccessor:
    case K.ClassStaticBlockDeclaration:
      return true;
    default:
      return false;
  }
}

// ───────────────────────── main ─────────────────────────

function main(): void {
  const lines = fs.readFileSync(listPath, "utf8").split("\n");
  let files = 0;
  let skipped = 0;
  let seen = 0;
  let n = 0;
  const t0 = performance.now();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length === 0 || !isTarget(l)) continue;
    if (only !== "" && l.indexOf(only) < 0) continue;
    if (seen++ % stride !== 0) continue;
    if (limit > 0 && n >= limit) break;
    n++;
    const buf = fs.readFileSync(root + "/" + l);
    if (buf.length >= SHIFT) {
      skipped++;
      continue;
    }
    const src = new Uint8Array(buf.length + 16);
    src.set(buf);
    const kinds = l.endsWith(".mjs") || l.endsWith(".mts") ? 1 : l.endsWith(".cjs") || l.endsWith(".cts") ? 2 : 3;
    let r = 1;
    let isScript = false;
    if ((kinds & 1) !== 0) r = parseFile(src, buf.length, l, false);
    if (r !== 0 && (kinds & 2) !== 0) {
      r = parseFile(src, buf.length, l, true);
      isScript = true;
    }
    if (r !== 0) {
      skipped++;
      continue;
    }
    files++;
    checkFile(buf, buf.length, l, isScript);
    if (verbose && files % 500 === 0) console.error("... files", files, "t", ((performance.now() - t0) / 1000).toFixed(0), "s");
  }
  console.log("files checked", files, "skipped (refused or too large)", skipped, "time", ((performance.now() - t0) / 1000).toFixed(1), "s");
  let totalMis = 0;
  let totalRows = 0;
  const labels = Array.from(stats.keys()).sort();
  for (const label of labels) {
    const s = stats.get(label)!;
    totalRows += s.total;
    totalMis += s.count;
    if (s.count > 0) {
      console.log(`MISMATCH ${label}: ${s.count} of ${s.total}`);
      for (const smp of s.samples) console.log("    " + smp);
    } else if (verbose) {
      console.log(`ok       ${label}: ${s.total}`);
    }
  }
  console.log("rows checked", totalRows, "mismatches", totalMis);
  for (const [k, v] of byDesign) console.log("  by design (not compared):", k, v);
  void lx;
}

main();
