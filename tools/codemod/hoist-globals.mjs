// Re-runnable, idempotent codemod: removes repeated thread-local lookups of module-level singletons.
//   node tools/codemod/hoist-globals.mjs src [--dry] [--min=2] [--accessors]
// Phase 1: in each function body, a module-level `const` of class/object type that is mentioned >= 2 times
//   (nested functions excluded) gets `const <name>$ = <name>;` as the first statement; mentions are rewritten.
//   An already existing leading `const <x>$ = <name>;` is reused (so re-running after a merge stays stable).
// Phase 2: calls of trivial `return <singleton>.<col>[<param>] | 0;` accessors become `<alias>.<col>[<arg>] | 0`
//   when the argument is side-effect free; an alias is created when the body does not have one yet.
// Edits are applied as text splices by position (comments/formatting untouched). Never touches let/var globals.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ts = require("../../node_modules/typescript/lib/typescript.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const dry = flag("--dry");
const noAcc = !flag("--accessors");
const minRefs = Number((args.find((a) => a.startsWith("--min=")) || "--min=2").slice(6));
const target = path.resolve(root, args.find((a) => !a.startsWith("--")) || "src");

const cfgPath = path.join(root, "tsconfig.json");
const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram({ rootNames: cfg.fileNames, options: cfg.options });
const checker = program.getTypeChecker();

const inTarget = (f) => !f.isDeclarationFile && f.fileName.startsWith(target) && !f.fileName.includes("/node_modules/");
const isFn = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);

// Resolve identifier -> module-level const variable declaration (or undefined).
const symCache = new Map();
function globalConstDecl(id) {
  let sym = checker.getSymbolAtLocation(id);
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  if (symCache.has(sym)) return symCache.get(sym);
  let res;
  const d = sym.valueDeclaration;
  if (d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.parent && ts.isVariableDeclarationList(d.parent) &&
      (d.parent.flags & ts.NodeFlags.Const) && d.parent.parent && ts.isVariableStatement(d.parent.parent) &&
      ts.isSourceFile(d.parent.parent.parent) && !d.parent.parent.parent.isDeclarationFile) {
    const t = checker.getTypeAtLocation(d.name);
    const ts_ = t.getSymbol();
    const ok = ts_ && (ts_.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.ObjectLiteral)) &&
      (ts_.declarations || []).length > 0 && ts_.declarations.every((x) => !x.getSourceFile().isDeclarationFile && inSrc(x.getSourceFile()));
    if (ok) res = { sym, decl: d };
  }
  symCache.set(sym, res);
  return res;
}
const inSrc = (f) => f.fileName.startsWith(path.join(root, "src"));

// ---- phase 2 table: trivial accessors `function f(p) { return <obj>.<col>[p] | 0; }`
const accessors = new Map(); // function symbol -> { objSym, col }
if (!noAcc) {
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !inSrc(sf)) continue;
    for (const st of sf.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.body || !st.name || st.parameters.length !== 1 || st.body.statements.length !== 1) continue;
      const r = st.body.statements[0];
      if (!ts.isReturnStatement(r) || !r.expression) continue;
      let e = r.expression;
      if (!(ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarToken && ts.isNumericLiteral(e.right) && e.right.text === "0")) continue;
      e = e.left;
      if (!ts.isElementAccessExpression(e) || !ts.isIdentifier(e.argumentExpression)) continue;
      const p = st.parameters[0];
      if (!ts.isIdentifier(p.name) || e.argumentExpression.text !== p.name.text) continue;
      if (!ts.isPropertyAccessExpression(e.expression) || !ts.isIdentifier(e.expression.expression)) continue;
      const g = globalConstDecl(e.expression.expression);
      if (!g) continue;
      const fs_ = checker.getSymbolAtLocation(st.name);
      if (fs_) accessors.set(fs_, { objSym: g.sym, col: e.expression.name.text, decl: g.decl });
    }
  }
}

const pure = (e) => {
  if (ts.isIdentifier(e) || ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isParenthesizedExpression(e)) return pure(e.expression);
  if (ts.isPropertyAccessExpression(e)) return pure(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarToken) return pure(e.left) && pure(e.right);
  return false;
};

// ---- --tables phase (runs INSTEAD of phases 1/2): alias module-level typed-array (and, with --strings, string) consts
// mentioned inside loops; `const T$ = T;` goes right before the OUTERMOST loop mentioning T (nested functions excluded).
if (flag("--tables")) {
  const withStrings = flag("--strings");
  const TA = /^(Uint8|Int8|Uint16|Int16|Int32|Uint32|Float64)Array$/;
  const tcache = new Map();
  const tableSym = (id) => {
    let sym = checker.getSymbolAtLocation(id);
    if (!sym) return undefined;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    if (tcache.has(sym)) return tcache.get(sym);
    let ok = false;
    const d = sym.valueDeclaration;
    if (d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.parent && ts.isVariableDeclarationList(d.parent) &&
        (d.parent.flags & ts.NodeFlags.Const) && d.parent.parent && ts.isVariableStatement(d.parent.parent) &&
        ts.isSourceFile(d.parent.parent.parent) && !d.parent.parent.parent.isDeclarationFile && inSrc(d.parent.parent.parent)) {
      const t = checker.getTypeAtLocation(d.name);
      const tsym = t.getSymbol();
      if (tsym && TA.test(tsym.name)) ok = true;
      else if (withStrings && (t.flags & ts.TypeFlags.StringLike)) ok = true;
    }
    tcache.set(sym, ok ? { sym, decl: d } : undefined);
    return tcache.get(sym);
  };
  const isLoop = (n) => ts.isIterationStatement(n, false);
  let aliases = 0, refs = 0, files = 0;
  for (const sf of program.getSourceFiles()) {
    if (!inTarget(sf)) continue;
    const text = sf.text;
    const edits = [];
    const topNames = new Set();
    const localNames = new Map();
    let lastImport;
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) {
        lastImport = st;
        const c = st.importClause;
        if (c && c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) {
          topNames.add(e.name.text);
          let sy = checker.getSymbolAtLocation(e.name);
          if (sy && (sy.flags & ts.SymbolFlags.Alias)) sy = checker.getAliasedSymbol(sy);
          if (sy) localNames.set(sy, e.name.text);
        }
        else if (c && c.name) topNames.add(c.name.text);
        else if (c && c.namedBindings) topNames.add(c.namedBindings.name.text);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) {
          topNames.add(d.name.text);
          const sy = checker.getSymbolAtLocation(d.name); if (sy) localNames.set(sy, d.name.text);
        }
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) topNames.add(st.name.text);
    }
    const needImports = new Map();
    function processFn(fn) {
      const body = fn.body;
      if (!body || !ts.isBlock(body)) return;
      if (ts.isConstructorDeclaration(fn) && fn.parent.heritageClauses) return;
      const groups = new Map(); // loop -> Map(sym -> {decl, ids})
      const bodyNames = new Set();
      function walk(n, loop) {
        if (n !== body && isFn(n)) return;
        if (ts.isIdentifier(n)) {
          bodyNames.add(n.text);
          if (!loop) return;
          const p = n.parent;
          if (ts.isVariableDeclaration(p) && p.initializer === n && p.name.text.endsWith("$")) return; // existing alias
          if (ts.isShorthandPropertyAssignment(p) && p.name === n) return;
          if (ts.isPropertyAccessExpression(p) && p.name === n) return;
          if (ts.isQualifiedName(p) || ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p)) return;
          if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) ||
               ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) ||
               ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p)) && p.name === n) return;
          if (ts.isBindingElement(p) && p.propertyName === n) return;
          const g = tableSym(n);
          if (!g) return;
          let m = groups.get(loop); if (!m) groups.set(loop, (m = new Map()));
          let r = m.get(g.sym); if (!r) m.set(g.sym, (r = { decl: g.decl, ids: [] }));
          r.ids.push(n);
          return;
        }
        ts.forEachChild(n, (k) => walk(k, loop || (isLoop(n) ? n : undefined)));
      }
      // loop must be the node whose children we walk: handle by passing loop when entering a loop node
      function walk2(n, loop) {
        if (n !== body && isFn(n)) return;
        if (isLoop(n) && !loop) loop = n;
        if (ts.isIdentifier(n)) return walk(n, loop);
        ts.forEachChild(n, (k) => walk2(k, loop));
      }
      walk2(body, undefined);
      if (groups.size === 0) return;
      const alias = (base) => { let a = base + "$"; while (bodyNames.has(a) || topNames.has(a)) a += "$"; bodyNames.add(a); return a; };
      const byPos = new Map(); // insertion stmt -> [texts]
      for (const [loop, m] of groups) {
        let st = loop;
        while (st.parent && ts.isLabeledStatement(st.parent)) st = st.parent;
        const par = st.parent;
        if (!(ts.isBlock(par) || ts.isCaseClause(par) || ts.isDefaultClause(par) || ts.isSourceFile(par))) continue;
        for (const [sym, r] of m) {
          let ln = r.ids[0].text;
          const imported = localNames.get(sym);
          if (!imported) {
            ln = r.decl.name.text;
            if (topNames.has(ln) || !lastImport) continue;
            let rel = path.relative(path.dirname(sf.fileName), r.decl.getSourceFile().fileName);
            if (!rel.startsWith(".")) rel = "./" + rel;
            needImports.set(ln, rel); topNames.add(ln); localNames.set(sym, ln);
          }
          const name = alias(ln);
          byPos.set(st, [...(byPos.get(st) || []), `const ${name} = ${ln};`]);
          aliases++;
          for (const id of r.ids) { edits.push({ pos: id.getStart(sf), end: id.end, text: name }); refs++; }
        }
      }
      for (const [st, decls] of byPos) {
        const pos = st.getStart(sf);
        const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
        const before = text.slice(lineStart, pos);
        if (/^[ \t]*$/.test(before)) edits.push({ pos, end: pos, text: decls.map((d) => d + "\n" + before).join("") });
        else edits.push({ pos, end: pos, text: decls.join(" ") + " " });
      }
    }
    (function visit(n) { if (isFn(n)) processFn(n); ts.forEachChild(n, visit); })(sf);
    if (edits.length === 0) continue;
    for (const [n, rel] of needImports) edits.push({ pos: lastImport.end, end: lastImport.end, text: `\nimport { ${n} } from "${rel}";` });
    edits.sort((a, b) => b.pos - a.pos || b.end - a.end);
    let out = text;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      if (i > 0 && e.end > edits[i - 1].pos) throw new Error(`overlapping edits in ${sf.fileName} at ${e.pos}`);
      out = out.slice(0, e.pos) + e.text + out.slice(e.end);
    }
    files++;
    if (!dry) fs.writeFileSync(sf.fileName, out);
  }
  console.log(`hoist-globals --tables: ${aliases} aliases, ${refs} references, ${files} files${dry ? " (dry run)" : ""}`);
  process.exit(0);
}

let fnCount = 0, refCount = 0, callCount = 0, fileCount = 0;
const perName = new Map();

for (const sf of program.getSourceFiles()) {
  if (!inTarget(sf)) continue;
  const text = sf.text;
  const edits = [];
  const topNames = new Set();
  const localNames = new Map(); // global const symbol -> name it has in this file
  const needImports = new Map(); // decl name -> module specifier (added once per file)
  const lastImport = sf.statements.filter(ts.isImportDeclaration).pop();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause && st.importClause.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const e of st.importClause.namedBindings.elements) {
        let sy = checker.getSymbolAtLocation(e.name);
        if (sy && (sy.flags & ts.SymbolFlags.Alias)) sy = checker.getAliasedSymbol(sy);
        if (sy) localNames.set(sy, e.name.text);
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) { const sy = checker.getSymbolAtLocation(d.name); if (sy) localNames.set(sy, d.name.text); }
    }
  }
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) { if (ts.isIdentifier(d.name)) topNames.add(d.name.text); }
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) topNames.add(st.name.text);
    else if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause; if (c.name) topNames.add(c.name.text);
      if (c.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) topNames.add(c.namedBindings.name.text); else for (const e of c.namedBindings.elements) topNames.add(e.name.text); }
    }
  }

  function processFn(fn) {
    const body = fn.body;
    if (!body || !ts.isBlock(body) || body.statements.length === 0) return;
    if (ts.isConstructorDeclaration(fn) && fn.parent.heritageClauses) return;
    const stmts = body.statements;
    const stmtIndex = new Map(stmts.map((s, i) => [s, i]));
    const topIdx = (n) => { while (n && n.parent !== body) n = n.parent; return n ? stmtIndex.get(n) : -1; };
    // existing aliases `const x$ = <global>;` at the top level of the body
    const aliases = new Map(); // sym -> { name, idx }
    const aliasInit = new Set();
    stmts.forEach((st, i) => {
      if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const) || st.declarationList.declarations.length !== 1) return;
      const d = st.declarationList.declarations[0];
      if (!ts.isIdentifier(d.name) || !d.name.text.endsWith("$") || !d.initializer || !ts.isIdentifier(d.initializer) || d.type) return;
      const g = globalConstDecl(d.initializer);
      if (!g || aliases.has(g.sym)) return;
      aliases.set(g.sym, { name: d.name.text, idx: i });
      aliasInit.add(d.initializer);
    });
    // mentions (nested function-likes excluded) and accessor calls
    const refs = new Map(); // sym -> { decl, ids: [], calls: [] }
    const get = (g) => { let r = refs.get(g.sym); if (!r) refs.set(g.sym, (r = { decl: g.decl, ids: [], calls: [] })); return r; };
    function walk(n) {
      if (n !== body && isFn(n)) return;
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        if (aliasInit.has(n)) return;
        if (ts.isShorthandPropertyAssignment(p) && p.name === n) return;
        if (ts.isPropertyAccessExpression(p) && p.name === n) return;
        if (ts.isQualifiedName(p) || ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p)) return;
        if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) ||
             ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) ||
             ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p)) && p.name === n) return;
        if (ts.isBindingElement(p) && p.propertyName === n) return;
        const g = globalConstDecl(n);
        if (g) get(g).ids.push(n);
        return;
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.length === 1 && !noAcc) {
        let fsym = checker.getSymbolAtLocation(n.expression);
        if (fsym && (fsym.flags & ts.SymbolFlags.Alias)) fsym = checker.getAliasedSymbol(fsym);
        const acc = fsym && accessors.get(fsym);
        if (acc && pure(n.arguments[0])) get({ sym: acc.objSym, decl: acc.decl }).calls.push({ call: n, acc });
      }
      ts.forEachChild(n, walk);
    }
    ts.forEachChild(body, walk);
    if (refs.size === 0) return;

    // Expected number of lookups on the costliest path: branches take the max, loop bodies count double.
    const pathCount = (root, hits) => {
      const c = (n) => {
        if (!n) return 0;
        if (n !== body && isFn(n)) return 0;
        if (hits.has(n)) return 1;
        const sum = () => { let s = 0; ts.forEachChild(n, (k) => { s += c(k); }); return s; };
        if (ts.isIfStatement(n)) return c(n.expression) + Math.max(c(n.thenStatement), c(n.elseStatement));
        if (ts.isConditionalExpression(n)) return c(n.condition) + Math.max(c(n.whenTrue), c(n.whenFalse));
        if (ts.isSwitchStatement(n)) {
          let m = 0;
          for (const cl of n.caseBlock.clauses) { let s = ts.isCaseClause(cl) ? c(cl.expression) : 0; for (const st of cl.statements) s += c(st); m = Math.max(m, s); }
          return c(n.expression) + m;
        }
        if (ts.isIterationStatement(n, false)) return 2 * sum();
        return sum();
      };
      return c(root);
    };

    const bodyNames = new Set();
    (function nm(n) { if (ts.isIdentifier(n)) bodyNames.add(n.text); ts.forEachChild(n, nm); })(body);
    const alias = (base) => {
      let a = base + "$";
      while (bodyNames.has(a) || topNames.has(a)) a += "$";
      bodyNames.add(a);
      return a;
    };
    const local = []; // id edits
    const callEdits = [];
    const inserts = []; // { stmt, text }
    for (const [sym, r] of refs) {
      const ex = aliases.get(sym);
      let name, ids = r.ids, calls = r.calls;
      if (ex) {
        name = ex.name;
        ids = ids.filter((id) => topIdx(id) > ex.idx);
        calls = calls.filter((c) => topIdx(c.call) > ex.idx);
        if (ids.length === 0 && calls.length === 0) continue;
      } else {
        const hits = new Set([...ids, ...calls.map((c) => c.call)]);
        let total = 0;
        for (const st of stmts) total += pathCount(st, hits);
        if (total < minRefs) continue;
        let ln = r.ids.length ? r.ids[0].text : localNames.get(sym);
        if (!ln) {
          ln = r.decl.name.text;
          if (topNames.has(ln) || !lastImport) continue;
          let rel = path.relative(path.dirname(sf.fileName), r.decl.getSourceFile().fileName);
          if (!rel.startsWith(".")) rel = "./" + rel;
          needImports.set(ln, rel);
          topNames.add(ln);
          localNames.set(sym, ln);
        }
        name = alias(ln);
        let first = Infinity;
        for (const h of hits) first = Math.min(first, topIdx(h));
        inserts.push({ stmt: stmts[first], text: `const ${name} = ${ln};` });
      }
      for (const id of ids) {
        local.push({ pos: id.getStart(sf), end: id.end, text: name });
        refCount++;
        perName.set(r.decl.name.text, (perName.get(r.decl.name.text) || 0) + 1);
      }
      for (const c of calls) callEdits.push({ c, name });
    }
    if (local.length === 0 && callEdits.length === 0 && inserts.length === 0) return;

    const render = (from, to) => {
      let s = "", cur = from;
      for (const x of local.filter((x) => x.pos >= from && x.end <= to).sort((p, q) => p.pos - q.pos)) { s += text.slice(cur, x.pos) + x.text; cur = x.end; }
      return s + text.slice(cur, to);
    };
    const noParen = (c) => {
      const p = c.parent;
      if (ts.isExpressionStatement(p) || ts.isReturnStatement(p) || ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) ||
          ts.isPropertyAssignment(p) || ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isCaseClause(p) || ts.isSwitchStatement(p)) return true;
      if (ts.isVariableDeclaration(p) || ts.isCallExpression(p) && p.expression !== c) return true;
      if (ts.isElementAccessExpression(p) && p.argumentExpression === c) return true;
      if (ts.isBinaryExpression(p)) {
        const k = p.operatorToken.kind;
        return k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.EqualsToken;
      }
      return false;
    };
    const covered = [];
    for (const { c, name } of callEdits) {
      const arg = c.call.arguments[0];
      const rep = `${name}.${c.acc.col}[${render(arg.getStart(sf), arg.end)}] | 0`;
      const pos = c.call.getStart(sf);
      covered.push({ pos, end: c.call.end });
      edits.push({ pos, end: c.call.end, text: noParen(c.call) ? rep : `(${rep})` });
      callCount++;
    }
    for (const x of local) if (!covered.some((c) => x.pos >= c.pos && x.end <= c.end)) edits.push(x);
    // insert alias declarations right before the first statement that mentions the global
    const byStmt = new Map();
    for (const i of inserts) byStmt.set(i.stmt, [...(byStmt.get(i.stmt) || []), i.text]);
    for (const [st, decls] of byStmt) {
      const pos = st.getStart(sf);
      const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
      const before = text.slice(lineStart, pos);
      if (/^[ \t]*$/.test(before)) edits.push({ pos, end: pos, text: decls.map((d) => d + "\n" + before).join("") });
      else edits.push({ pos, end: pos, text: decls.join(" ") + " " });
    }
    fnCount++;
  }

  (function visit(n) {
    if (isFn(n)) processFn(n);
    ts.forEachChild(n, visit);
  })(sf);

  if (edits.length === 0) continue;
  for (const [n, rel] of needImports) edits.push({ pos: lastImport.end, end: lastImport.end, text: `\nimport { ${n} } from "${rel}";` });
  edits.sort((a, b) => b.pos - a.pos || b.end - a.end);
  let out = text;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (i > 0 && e.end > edits[i - 1].pos) throw new Error(`overlapping edits in ${sf.fileName} at ${e.pos}`);
    out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  }
  fileCount++;
  if (!dry) fs.writeFileSync(sf.fileName, out);
}
console.log(`hoist-globals: ${fnCount} functions, ${refCount} references hoisted, ${callCount} accessor calls inlined, ${fileCount} files${dry ? " (dry run)" : ""}`);
const top = [...perName].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, c]) => `${n}:${c}`).join(" ");
console.log("top: " + top);
