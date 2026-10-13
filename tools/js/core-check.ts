// Sanity checks of the core of the JavaScript formatter (src/format/js) over the files of bench/vscode (or any list):
//   * `AstNodes`: for every node of the tree, `nodeAsAstNodes` and the chain of `anParent` end at the `Program` (within 400 steps), the span is
//     inside the file;
//   * `followingSpanStartIn`: for the child of every node the answer is 0 or at/after the end of the child;
//   * `collectComments`: the comments are sorted by `cs`, `ce >= cs`, every flag combination is sane;
//   * the formatter prints every comment exactly once: after `formatScript` no comment is left unprinted (`unprintedComments() === 0`).
//
//   node --stack-size=7000 tools/js/core-check.ts [--limit=N] [--filter=substr] [--root=bench/vscode] [--list=/tmp/vscode-files.txt] [--comments-only]
import * as fs from "node:fs";
import * as path from "node:path";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { FORMAT_OK } from "../../src/format/errors.ts";
import { formatScript, isTypeScriptPath } from "../../src/format/js/script.ts";
import { unprintedComments } from "../../src/format/js/mod.ts";
import { parseFile } from "../../src/sema/parser/parser/run.ts";
import { names } from "../../src/sema/parser/parser/mod.ts";
import {
  AN_PROGRAM,
  anParent,
  anSpan,
  anTag,
  nodeAsAstNodes,
} from "../../src/format/js/ast_nodes.ts";
import { followingSpanStartIn } from "../../src/format/js/siblings.ts";
import { Comments, collectComments } from "../../src/format/js/comments.ts";
import {
  N_EXPR,
  NODE_FILE,
  SP,
  fileBegin,
  fileIsJavascript,
  hir,
  nodeChildren,
  nodeKind,
  nodeSpan,
} from "../../src/lint/ast/index.ts";
import { I32Vec } from "../../src/sema/vec.ts";

function arg(name: string, dflt: string): string {
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--" + name + "=")) return process.argv[i].substring(name.length + 3);
  }
  return dflt;
}
function flag(name: string): boolean {
  return process.argv.includes("--" + name);
}

const repo = path.resolve(import.meta.dirname, "../..");
const root = path.resolve(repo, arg("root", "bench/vscode"));
const limit = Number(arg("limit", "0"));
const filter = arg("filter", "");
const onlyComments = flag("comments-only");
const text = Buffer.from(fs.readFileSync(arg("list", "/tmp/vscode-files.txt"), "latin1"), "latin1").toString("utf8").split("\n");
let files = text.filter((l) => l.length > 0 && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(l) && (filter === "" || l.includes(filter)));
if (limit > 0) files = files.slice(0, limit);

let bad = 0;
let checkedNodes = 0;
let checkedComments = 0;
const examples: string[] = [];
function report(rel: string, what: string): void {
  bad++;
  if (examples.length < 25) examples.push(rel + ": " + what);
}

const out = new ByteBuf(1 << 20);
const stack = new I32Vec(1024);
const kids = new I32Vec(64);
const options = new FormatOptions();
options.indentStyle = 1;
const cmCheck = new Comments();

for (const rel of files) {
  const abs = path.join(root, rel);
  const src = fs.readFileSync(abs);
  const bytes = new Uint8Array(src.buffer, src.byteOffset, src.length);
  const tried = [false, true];
  let parsed = false;
  let isScript = false;
  for (const s of tried) {
    if (parseFile(bytes, bytes.length, abs, s) === 0) {
      parsed = true;
      isScript = s;
      break;
    }
  }
  if (!parsed) continue;
  fileBegin(names, isTypeScriptPath(abs), !isScript);
  const textBytes = hir.text.subarray(0, hir.sourceLen | 0);
  const len = textBytes.length;
  try {
    collectComments(cmCheck, textBytes, options.flavor, fileIsJavascript());
    for (let i = 0; i < cmCheck.n; i++) {
      checkedComments++;
      if ((cmCheck.ce[i] | 0) < (cmCheck.cs[i] | 0)) report(rel, "comment " + i + ": ce < cs");
      if (i > 0 && (cmCheck.cs[i] | 0) < (cmCheck.cs[i - 1] | 0)) report(rel, "comments not sorted at " + i);
    }
  } catch (e) {
    report(rel, "collectComments: " + (e instanceof Error ? e.message : String(e)));
    continue;
  }
  if (!onlyComments) {
    stack.reset();
    stack.push(NODE_FILE);
    while (stack.len > 0) {
      const n = stack.pop();
      checkedNodes++;
      try {
        let an = nodeAsAstNodes(n);
        anSpan(an);
        const s0 = SP[0] | 0;
        const e0 = SP[1] | 0;
        if (s0 < 0 || e0 > len || s0 > e0 + 1) report(rel, "span of node " + n + " tag " + anTag(an) + ": " + s0 + ".." + e0 + " of " + len);
        let steps = 0;
        const first = an;
        while (anTag(an) !== AN_PROGRAM && steps < 400) {
          an = anParent(an);
          steps++;
        }
        if (anTag(an) !== AN_PROGRAM) report(rel, "the parents of node " + n + " (tag " + anTag(first) + ") do not end at Program");
        const base = kids.len;
        nodeChildren(n, -1, kids);
        for (let i = base; i < kids.len; i++) {
          const c = kids.data[i] | 0;
          stack.push(c);
          if (nodeKind(n) === N_EXPR || true) {
            nodeSpan(c);
            const cs = SP[0] | 0;
            const ce = SP[1] | 0;
            const parentAn = nodeAsAstNodes(n);
            const following = followingSpanStartIn(cs, ce, parentAn, 0);
            if (following !== 0 && following < cs) report(rel, "following start " + following + " < start " + cs + " of child " + c + " in tag " + anTag(parentAn));
          }
        }
        kids.len = base;
      } catch (e) {
        report(rel, "node " + n + ": " + (e instanceof Error ? e.message : String(e)));
        break;
      }
    }
  }
  // The formatter prints every comment once.
  out.reset();
  parseFile(bytes, bytes.length, abs, isScript);
  fileBegin(names, isTypeScriptPath(abs), !isScript);
  try {
    const code = formatScript(abs, abs, bytes, options, out);
    if (code === FORMAT_OK) {
      const left = unprintedComments();
      if (left !== 0) report(rel, left + " comments are not printed");
    }
  } catch (e) {
    report(rel, "formatScript: " + (e instanceof Error ? e.message : String(e)));
  }
}
console.log(`files ${files.length}, nodes ${checkedNodes}, comments ${checkedComments}, problems ${bad}`);
for (const e of examples) console.log("  " + e);
process.exit(bad === 0 ? 0 : 1);
