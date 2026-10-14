// Re-runnable, idempotent codemod: moves compile-time-constant module-level `const`s out of modules that are part of an
// import cycle into an import-free sibling leaf module `<file>.consts.ts`.
//   node tools/codemod/leaf-consts.mjs src [--dry] [--strings] [--bools]
// Why: scriptc 0.3.0 folds `const X: number = 18;` to a compile-time constant, EXCEPT when the declaring module is in an
// import cycle; then X is a thread-local global + `X_initialized` flag and every use (every `case X:` label) costs two
// `_tlv_get_addr` calls. In an import-free leaf module nothing is cyclic, so the constant folds everywhere.
// Steps: (1) import graph of src (static imports, re-exports), Tarjan SCCs with > 1 module = cycles;
// (2) in each cyclic module, module-level `const` statements whose initializers are numeric literals or arithmetic /
//     bitwise expressions over literals and over other consts being moved (fixpoint); optionally string / boolean literals;
// (3) text-splice them (with their leading doc comments) into <file>.consts.ts (no imports), and in the original add
//     `import { ... } from "./<file>.consts.ts"` + `export { <exported ones> } from "./<file>.consts.ts"`.
// Position-based edits, no line numbers. Re-running moves nothing new (leaves are not cyclic), appends if new constants qualify.
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
const withStrings = flag("--strings");
const withBools = flag("--bools");
const target = path.resolve(root, args.find((a) => !a.startsWith("--")) || "src");

function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const files = walk(target, []).sort();
const fileSet = new Set(files);
const sources = new Map();
const sfs = new Map();
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  sources.set(f, text);
  sfs.set(f, ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS));
}

// (1) import graph
function resolveSpec(from, spec) {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, base + ".ts", path.join(base, "index.ts")]) if (fileSet.has(c)) return c;
  return undefined;
}
const edges = new Map();
for (const f of files) {
  const out = new Set();
  for (const st of sfs.get(f).statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const r = resolveSpec(f, st.moduleSpecifier.text);
      if (r) out.add(r);
    }
  }
  edges.set(f, [...out]);
}
// Tarjan (iterative-safe enough: graph is small)
const idx = new Map(), low = new Map(), onSt = new Set(), stack = [];
let counter = 0;
const cyclic = new Set();
const sccs = [];
function strong(v) {
  idx.set(v, counter); low.set(v, counter); counter++; stack.push(v); onSt.add(v);
  for (const w of edges.get(v)) {
    if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onSt.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
    const comp = [];
    let w;
    do { w = stack.pop(); onSt.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1 || edges.get(v).includes(v)) { sccs.push(comp); for (const m of comp) cyclic.add(m); }
  }
}
for (const f of files) if (!idx.has(f)) strong(f);
console.log(`modules: ${files.length}, cyclic SCCs: ${sccs.length}, modules in cycles: ${cyclic.size}`);

// (2) candidates
const isExported = (st) => !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
function constOk(e, names, sf) {
  switch (e.kind) {
    case ts.SyntaxKind.NumericLiteral: return true;
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral: return withStrings;
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword: return withBools;
    case ts.SyntaxKind.ParenthesizedExpression: return constOk(e.expression, names, sf);
    case ts.SyntaxKind.PrefixUnaryExpression:
      return (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken || e.operator === ts.SyntaxKind.TildeToken) && constOk(e.operand, names, sf);
    case ts.SyntaxKind.BinaryExpression: {
      const k = e.operatorToken.kind;
      const ok = [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, ts.SyntaxKind.AsteriskAsteriskToken].includes(k);
      return ok && constOk(e.left, names, sf) && constOk(e.right, names, sf);
    }
    case ts.SyntaxKind.Identifier: return names.has(e.text);
    default: return false;
  }
}
// type annotation must be absent or a primitive keyword (number/string/boolean)
function typeOk(d) {
  if (!d.type) return true;
  return [ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.StringKeyword, ts.SyntaxKind.BooleanKeyword].includes(d.type.kind);
}
// leading comment start: comments directly attached (no blank line between) to the statement
function attachedStart(text, st, sf) {
  const full = st.getFullStart();
  const ranges = ts.getLeadingCommentRanges(text, full) || [];
  let start = st.getStart(sf);
  for (let i = ranges.length - 1; i >= 0; i--) {
    const gap = text.slice(ranges[i].end, start);
    if ((gap.match(/\n/g) || []).length > 1) break;
    start = ranges[i].pos;
  }
  return start;
}
function leafPathOf(f) { return f.replace(/\.ts$/, ".consts.ts"); }

const edits = []; // {file, start, end, text}
let totalMoved = 0, modulesTouched = 0;
const summary = [];
for (const f of files) {
  if (!cyclic.has(f)) continue;
  const sf = sfs.get(f), text = sources.get(f);
  const stmts = sf.statements.filter((s) => ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const));
  // all module-level binding names that are not const-statements (to detect shadowing is unnecessary: same scope)
  let cand = stmts.filter((s) => s.declarationList.declarations.every((d) => ts.isIdentifier(d.name) && d.initializer && typeOk(d)));
  let names = new Set(cand.flatMap((s) => s.declarationList.declarations.map((d) => d.name.text)));
  // fixpoint: drop statements whose initializer is not constant over `names`
  for (;;) {
    const keep = cand.filter((s) => s.declarationList.declarations.every((d) => constOk(d.initializer, names, sf)));
    if (keep.length === cand.length) break;
    cand = keep;
    names = new Set(cand.flatMap((s) => s.declarationList.declarations.map((d) => d.name.text)));
  }
  if (!cand.length) continue;
  // a name referenced before... (hoisting is irrelevant for imports)
  const leaf = leafPathOf(f);
  const chunks = [];
  const exportedNames = [], allNames = [];
  for (const s of cand) {
    const start = attachedStart(text, s, sf);
    let end = s.getEnd();
    // swallow trailing same-line comment and the newline
    const m = /^[ \t]*(\/\/[^\n]*)?\n?/.exec(text.slice(end));
    let trailing = m ? m[0] : "";
    end += trailing.length;
    let body = text.slice(start, end);
    if (!body.endsWith("\n")) body += "\n";
    // a leaf statement must be exported
    if (!isExported(s)) body = body.replace(/^((?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*?)const /, (all, pre) => pre + "export const ");
    // handle comments: the replace above targets the first `const ` after leading comments
    chunks.push(body);
    for (const d of s.declarationList.declarations) { allNames.push(d.name.text); if (isExported(s)) exportedNames.push(d.name.text); }
    // remove from original; also remove one preceding blank line if the next one is blank too (keep tidy)
    let rs = start, re = end;
    while (text[re] === "\n" && (rs === 0 || text[rs - 1] === "\n") && (rs < 2 || text[rs - 2] === "\n")) re++;
    edits.push({ file: f, start: rs, end: re, text: "" });
  }
  // insertion of import/re-export after the last import-ish statement (or at top of statements)
  const rel = "./" + path.basename(leaf);
  const lastImp = [...sf.statements].filter((s) => ts.isImportDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier)).pop();
  const imp = `import { ${allNames.join(", ")} } from "${rel}";\n` + (exportedNames.length ? `export { ${exportedNames.join(", ")} } from "${rel}";\n` : "");
  if (lastImp) {
    edits.push({ file: f, start: lastImp.getEnd() + (text[lastImp.getEnd()] === "\n" ? 1 : 0), end: lastImp.getEnd() + (text[lastImp.getEnd()] === "\n" ? 1 : 0), text: imp });
  } else {
    const first = sf.statements[0];
    const p = attachedStart(text, first, sf);
    edits.push({ file: f, start: p, end: p, text: imp + "\n" });
  }
  // leaf content: appended if exists
  let leafText = fs.existsSync(leaf) ? fs.readFileSync(leaf, "utf8") : `// Constants of ${path.basename(f)}, kept in an import-free leaf module so scriptc folds them at compile time\n// (module-level consts of modules in an import cycle are thread-local globals). Generated by tools/codemod/leaf-consts.mjs.\n\n`;
  if (!leafText.endsWith("\n")) leafText += "\n";
  edits.push({ file: leaf, leafAppend: chunks.join("") , base: leafText });
  totalMoved += allNames.length; modulesTouched++;
  summary.push(`${path.relative(root, f)}: ${allNames.length}`);
}
console.log(summary.join("\n"));
console.log(`moved ${totalMoved} constants out of ${modulesTouched} modules${dry ? " (dry run)" : ""}`);
if (dry) process.exit(0);
const byFile = new Map();
for (const e of edits) { if (e.leafAppend !== undefined) continue; (byFile.get(e.file) || byFile.set(e.file, []).get(e.file)).push(e); }
for (const [f, es] of byFile) {
  es.sort((a, b) => b.start - a.start || b.end - a.end);
  let t = sources.get(f);
  for (const e of es) t = t.slice(0, e.start) + e.text + t.slice(e.end);
  fs.writeFileSync(f, t);
}
for (const e of edits) if (e.leafAppend !== undefined) fs.writeFileSync(e.file, e.base + e.leafAppend);
