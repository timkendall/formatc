// A parse that starts inside a callback of another parse (the formatter does that in `Renderer.text`) must not disturb
// the outer one.   node tools/md/reentrancy.ts
import { Dump, HookExtensions, dump, parseSettings } from "./events.ts";
import type { Settings } from "./events.ts";
import { prettierDocs, specDocs, vscodeDocs } from "./corpus.ts";
import { renderWithExtensions } from "../../src/md/lib.ts";
import type { Definition, SpanDetail } from "../../src/md/lib.ts";

const settings: Settings = parseSettings("--track --hooks --read-leaves +tables +math_blocks +footnotes +no_single_tilde +micromark +micromark_to_the_letter -tasklists".split(" "));

let other: Uint8Array = new Uint8Array(0);
let depth = 0;
function nested(): void {
  if (depth >= 3) return;
  depth++;
  const d = new Dump(true, false);
  renderWithExtensions(other, settings.options, d, new HookExtensions(false));
  depth--;
}

class NestedDump extends Dump {
  enterBlock(t: number, data: number, flags: number): void { nested(); super.enterBlock(t, data, flags); }
  enterSpan(t: number, d: SpanDetail): void { nested(); super.enterSpan(t, d); }
  leaveSpan(t: number): void { nested(); super.leaveSpan(t); }
  text(t: number, b: Uint8Array, s: number, e: number): void { nested(); super.text(t, b, s, e); }
  inlineSource(beg: number, end: number): void { super.inlineSource(beg, end); if (beg % 7 === 0) nested(); }
  definition(d: Definition): void { nested(); super.definition(d); }
}

const docs = [...specDocs().slice(0, 300), ...vscodeDocs().slice(0, 100), ...prettierDocs(false)];
let bad = 0;
for (let i = 0; i < docs.length; i++) {
  other = docs[(i * 7 + 1) % docs.length].bytes;
  const plain = dump(docs[i].bytes, settings);
  const d = new NestedDump(true, true);
  renderWithExtensions(docs[i].bytes, settings.options, d, new HookExtensions(false));
  const mine = d.out.length ? d.out.join("\n") + "\n" : "";
  if (mine !== plain) {
    bad++;
    if (bad < 4) console.log("DIFF", docs[i].name);
  }
}
console.log(`${docs.length} documents with parses inside the callbacks, ${bad} differ`);
process.exit(bad === 0 ? 0 : 1);
