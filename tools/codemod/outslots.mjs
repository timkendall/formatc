// Re-runnable, idempotent codemod: module-level `const X = new Int32Array(n)` / `new Float64Array(n)` (n <= 8) whose every
// mention (imports resolved with the TypeChecker) is an element access with a constant index becomes an instance of
// `SlotsN` (src/base/slots.ts, number fields s0..s{n-1}). That lets hoist-globals alias it once per function.
//   node tools/codemod/outslots.mjs src [--dry]      then: node tools/codemod/hoist-globals.mjs src
//   X[k]            -> X.sk
//   X[k] = e        -> X.sk = (e) | 0            (Float64: X.sk = e; TS already guarantees number)
//   X[k] op= e      -> X.sk = (X.sk op (e)) | 0
//   X[k]++ / --X[k] -> X.sk = (X.sk + 1) | 0     (only as a statement / for-clause; else the array is skipped)
// Skipped: any mention that is not `X[const]` (passed, .set/.fill/.length, typeof, export {X}, shorthand, destructuring
// target), index out of range, or an assignment whose value is used. Text splices by position; no line numbers used.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ts = require("../../node_modules/typescript/lib/typescript.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const target = path.resolve(root, args.find((a) => !a.startsWith("--")) || "src");
const MAXN = 8;
const skipNames = new Set((args.find((a) => a.startsWith("--skip=")) || "--skip=").slice(7).split(",").filter(Boolean));
const helperPath = path.join(root, "src/base/slots.ts");

const cfg = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram({ rootNames: cfg.fileNames, options: cfg.options });
const checker = program.getTypeChecker();
const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && f.fileName.startsWith(path.join(root, "src")) && !f.fileName.includes("/node_modules/"));
const inTarget = (f) => f.fileName.startsWith(target);

const resolve = (sym) => (sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
const isModuleVar = (d) =>
  d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.parent && ts.isVariableDeclarationList(d.parent) &&
  d.parent.parent && ts.isVariableStatement(d.parent.parent) && ts.isSourceFile(d.parent.parent.parent);
const isConst = (d) => !!(d.parent.flags & ts.NodeFlags.Const);

// numeric value of an expression: literal, or module-level const with a numeric-literal initializer
function constVal(e, depth = 0) {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isIdentifier(e) && depth < 4) {
    const s = resolve(checker.getSymbolAtLocation(e));
    const d = s && s.valueDeclaration;
    if (isModuleVar(d) && isConst(d) && d.initializer) return constVal(d.initializer, depth + 1);
  }
  return undefined;
}

// import-cycle membership (Tarjan SCC): scriptc rejects (SC1016) a module-level user-class construction in a module that is part of
// a cycle with certain class users (seen with tag_formatters.ts), so candidates in non-trivial SCCs are skipped unless --cycles.
const adj = new Map();
for (const sf of files) {
  const out = [];
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const r = ts.resolveModuleName(st.moduleSpecifier.text, sf.fileName, cfg.options, ts.sys).resolvedModule;
      if (r) out.push(r.resolvedFileName);
    }
  }
  adj.set(sf.fileName, out);
}
const inCycle = new Set();
{
  let idx = 0; const index = new Map(), low = new Map(), onS = new Set(), stack = [];
  const sc = (v) => {
    index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onS.add(v);
    for (const w of adj.get(v) || []) {
      if (!adj.has(w)) continue;
      if (!index.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onS.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); onS.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) comp.forEach((x) => inCycle.add(x));
    }
  };
  for (const v of adj.keys()) if (!index.has(v)) sc(v);
}

// 1. candidates
const cands = new Map(); // symbol -> { decl, sf, n, kind, name, bad, uses: [] }
for (const sf of files) {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!isModuleVar(d) || !isConst(d) || !d.initializer) continue;
      const i = d.initializer;
      if (!ts.isNewExpression(i) || !ts.isIdentifier(i.expression) || !i.arguments || i.arguments.length !== 1) continue;
      const kind = i.expression.text;
      if (kind !== "Int32Array" && kind !== "Float64Array") continue;
      const n = constVal(i.arguments[0]);
      if (n === undefined || !(n >= 1 && n <= MAXN)) continue;
      const sym = checker.getSymbolAtLocation(d.name);
      if (!sym) continue;
      cands.set(sym, { decl: d, sf, n, kind, name: d.name.text, bad: !inTarget(sf) || (inCycle.has(sf.fileName) && !args.includes("--cycles")) || skipNames.has(d.name.text), uses: [] });
    }
  }
}
const names = new Set([...cands.values()].map((c) => c.name));
const badNames = new Set();
// local aliases `const sp = SP;` (hoist-globals output) count as mentions of SP through the alias
const aliasOf = new Map(); // alias symbol -> candidate
const aliasDecls = new Set(); // identifier nodes `SP` in those initializers
for (const sf of files) {
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !node.type && node.initializer && ts.isIdentifier(node.initializer) &&
        (node.parent.flags & ts.NodeFlags.Const) && !isModuleVar(node) && names.has(node.initializer.text)) {
      const c = cands.get(resolve(checker.getSymbolAtLocation(node.initializer)));
      const as = checker.getSymbolAtLocation(node.name);
      if (c && as) { aliasOf.set(as, c); aliasDecls.add(node.initializer); names.add(node.name.text); }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// 2. classify every mention
for (const sf of files) {
  const visit = (node) => {
    if (ts.isIdentifier(node) && names.has(node.text)) classify(node, sf);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
function classify(id, sf) {
  const p = id.parent;
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) { badNames.add(id.text); return; }
  if ((ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isPropertyAssignment(p) && p.name === id)) return;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) {
    const c = cands.get(resolve(checker.getSymbolAtLocation(id)));
    if (c && ts.isImportSpecifier(p) && p.propertyName) c.bad = true; // renamed import
    return;
  }
  const sym = resolve(checker.getSymbolAtLocation(id));
  const c = sym && (cands.get(sym) || aliasOf.get(sym));
  if (!c) return;
  if (id === c.decl.name || aliasDecls.has(id)) return;
  if (ts.isVariableDeclaration(p) && p.name === id) return; // alias declaration name
  if (!inTarget(sf)) { c.bad = true; return; }
  const why = (m) => { if (process.env.DBG) console.log("BAD", c.name, m, sf.fileName, sf.getLineAndCharacterOfPosition(id.getStart()).line + 1, p.getText().slice(0, 60)); c.bad = true; };
  if (!(ts.isElementAccessExpression(p) && p.expression === id)) { why("value"); return; }
  const k = constVal(p.argumentExpression);
  if (k === undefined || !Number.isInteger(k) || k < 0 || k >= c.n) { why("index"); return; }
  const gp = p.parent;
  let use = { sf, node: p, k, type: "read" };
  if (ts.isBinaryExpression(gp) && gp.left === p && gp.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && gp.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
    const st = gp.parent;
    if (!(ts.isExpressionStatement(st) || (ts.isForStatement(st) && st.incrementor === gp))) { c.bad = true; return; }
    use = { ...use, type: "assign", bin: gp };
  } else if ((ts.isPrefixUnaryExpression(gp) || ts.isPostfixUnaryExpression(gp)) &&
             (gp.operator === ts.SyntaxKind.PlusPlusToken || gp.operator === ts.SyntaxKind.MinusMinusToken)) {
    const st = gp.parent;
    if (!(ts.isExpressionStatement(st) || (ts.isForStatement(st) && st.incrementor === gp))) { c.bad = true; return; }
    use = { ...use, type: "incdec", un: gp };
  } else if (ts.isArrayLiteralExpression(gp) || ts.isSpreadElement(gp) || ts.isDeleteExpression(gp) || ts.isForOfStatement(gp) || ts.isForInStatement(gp) ||
             ts.isPrefixUnaryExpression(gp) && false) { c.bad = true; return; }
  c.uses.push(use);
}

// 3. edits
const edits = new Map(); // file -> [{s,e,t}]
const add = (sf, s, e, t) => { if (!edits.has(sf)) edits.set(sf, []); edits.get(sf).push({ s, e, t }); };
const opText = (k) => ts.tokenToString(k).slice(0, -1); // "+=" -> "+"
let nArr = 0, nUses = 0;
const skipped = [];
const usedN = new Set();
const isI32 = (c) => c.kind === "Int32Array";
const wrapNeeded = (c, e) => {
  if (!isI32(c)) return false;
  let x = e; while (ts.isParenthesizedExpression(x)) x = x.expression;
  if (ts.isNumericLiteral(x) && Number.isInteger(Number(x.text)) && Number(x.text) <= 0x7fffffff) return false;
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.BarToken && ts.isNumericLiteral(x.right) && x.right.text === "0") return false;
  return true;
};
for (const [sym, c] of cands) {
  if (c.bad || badNames.has(c.name)) { skipped.push(c.name); continue; }
  nArr++; usedN.add(c.n);
  // declaration
  const d = c.decl;
  add(c.sf, d.name.getEnd(), d.end, ` = new Slots${c.n}()`);
  for (const u of c.uses) {
    nUses++;
    const field = `${u.node.expression.text}.s${u.k}`;
    const sf = u.sf;
    if (u.type === "read") add(sf, u.node.getStart(), u.node.end, field);
    else if (u.type === "assign") {
      const b = u.bin, op = b.operatorToken.kind, r = b.right;
      const wrap = wrapNeeded(c, r) || (op !== ts.SyntaxKind.EqualsToken && isI32(c));
      if (op === ts.SyntaxKind.EqualsToken) {
        if (wrap) { add(sf, b.getStart(), r.getStart(), `${field} = (`); add(sf, r.end, r.end, `) | 0`); }
        else add(sf, b.getStart(), r.getStart(), `${field} = `);
      } else if (isI32(c)) {
        add(sf, b.getStart(), r.getStart(), `${field} = (${field} ${opText(op)} (`); add(sf, r.end, r.end, `)) | 0`);
      } else {
        add(sf, u.node.getStart(), u.node.end, field); // Float64: plain compound assignment on the field
      }
    } else {
      const un = u.un, plus = un.operator === ts.SyntaxKind.PlusPlusToken;
      add(sf, un.getStart(), un.end, isI32(c) ? `${field} = (${field} ${plus ? "+" : "-"} 1) | 0` : `${field} = ${field} ${plus ? "+" : "-"} 1`);
    }
  }
  // import of the helper
  const st = d.parent.parent;
  const rel = path.relative(path.dirname(c.sf.fileName), helperPath).split(path.sep).join("/");
  const imps = c.sf.statements.filter((x) => ts.isImportDeclaration(x));
  const lastImp = imps[imps.length - 1];
  c.imp = { sf: c.sf, at: lastImp ? lastImp.end : 0, lead: lastImp ? "\n" : "", trail: lastImp ? "" : "\n", n: c.n, rel: rel.startsWith(".") ? rel : "./" + rel };
}
// one import per (file, n) at the first candidate decl position
const impDone = new Set();
for (const c of cands.values()) {
  if (!c.imp) continue;
  const key = c.sf.fileName + c.n;
  if (impDone.has(key)) continue;
  impDone.add(key);
  add(c.sf, c.imp.at, c.imp.at, `${c.imp.lead}import { Slots${c.n} } from "${c.imp.rel}";${c.imp.trail}`);
}

// 4. apply
const helper = () => {
  let s = "// Generated by tools/codemod/outslots.mjs. Tiny out-slot records (number fields) replacing module-level\n// Int32Array/Float64Array scratch arrays that are only ever indexed with constants.\n";
  for (let n = 1; n <= MAXN; n++) {
    s += `\nexport class Slots${n} {\n` + Array.from({ length: n }, (_, i) => `  s${i}: number = 0;\n`).join("") + `}\n`;
  }
  return s;
};
let nFiles = 0;
for (const [sf, es] of edits) {
  es.sort((a, b) => b.s - a.s || b.e - a.e);
  let text = sf.text;
  for (const e of es) text = text.slice(0, e.s) + e.t + text.slice(e.e);
  nFiles++;
  if (!dry) fs.writeFileSync(sf.fileName, text);
}
if (!dry && nArr > 0) fs.writeFileSync(helperPath, helper());
console.log(`outslots: ${nArr} arrays converted (${[...cands.values()].filter((c) => !c.bad && !badNames.has(c.name)).map((c) => c.name).join(" ")}), ${nUses} mentions, ${nFiles} files; skipped: ${skipped.join(" ") || "-"}${dry ? " (dry)" : ""}`);
