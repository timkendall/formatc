// Checks docs/LINT_AST_API.md against src/lint/ast/index.ts: every `identifier` or `identifier(` in backticks that looks like one of this layer's names
// (camelCase with a known prefix, or an UPPER_CASE constant) must be an export. Usage: node tools/lintast-doccheck.ts
import * as fs from "node:fs";
import * as A from "../src/lint/ast/index.ts";

const exported = new Set(Object.keys(A));
const doc = fs.readFileSync("docs/LINT_AST_API.md", "utf8");
const prefixes = [
  "expr", "stmt", "type", "pat", "func", "param", "typeParam", "class", "member", "prop", "varDecl", "case", "enumMember", "importSpec", "exportSpec",
  "tupleElem", "mapped", "modifier", "interface", "alias", "enum", "module", "import", "export", "call", "jsx", "key", "entity", "name", "ident", "list", "node",
  "file", "comment", "importAttributes", "token", "skip", "fill", "flow", "binOp", "unOp", "assign", "goes", "number", "ends", "to", "is", "sp", "set", "shrink",
  "span", "hir", "template",
];
const missing = new Map<string, number>();
const re = /`([A-Za-z_][A-Za-z0-9_]*)(\([^`]*\))?`/g;
let m: RegExpExecArray | null;
let checked = 0;
while ((m = re.exec(doc)) !== null) {
  const id = m[1];
  const isConst = /^[A-Z][A-Z0-9_]+$/.test(id);
  const isFn = /^[a-z][A-Za-z0-9]*$/.test(id) && prefixes.some((p) => id.startsWith(p)) && m[2] !== undefined;
  if (!isConst && !isFn) continue;
  if (isConst && !/^(EXPR|STMT|TYPE|PAT|FLAG|FN|BIN|UN|CHAIN|PROP|MEMBER|VAR|KW|MM|KEY|N|NODE|TK|JC|BODY|MODNAME|IET|RARE|P|SP|FLOW|A)_/.test(id) && id !== "SP") continue;
  checked++;
  if (!exported.has(id)) missing.set(id, (missing.get(id) ?? 0) + 1);
}
console.log("checked", checked, "missing", missing.size);
for (const [k, v] of missing) console.log("  missing:", k, v);
// the other direction: functions exported by this layer's modules that the doc never names
const named = new Set<string>();
const re2 = /[A-Za-z_][A-Za-z0-9_]*/g;
while ((m = re2.exec(doc)) !== null) named.add(m[0]);
const undocumented: string[] = [];
for (const k of Object.keys(A)) {
  if (typeof (A as Record<string, unknown>)[k] !== "function") continue;
  if (named.has(k)) continue;
  if (/^(push|new)/.test(k)) continue;
  if (/^(expr|stmt|type|pat|func|param|class|member|prop|varDecl|case|enumMember|importSpec|exportSpec|tupleElem|mapped|modifier|interface|alias|enum|module|import|export|call|jsx|key|entity|name|ident|list|node|file|comment|importAttributes|token|skip)/.test(k) && !/^(hir|beginFile)/.test(k)) undocumented.push(k);
}
console.log("exported but not named in the doc:", undocumented.length);
console.log(undocumented.join(" "));
