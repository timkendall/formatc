// Every codepoint next to emphasis markers, rendered by Bun and by the TS port: the Unicode white space / punctuation
// classes (CommonMark flanking rules) must agree.   bun tools/md/diff-unicode-bun.ts
import { ByteBuf, FOLD, Options, caseFold, renderToHtmlWithOptions } from "../../src/md/lib.ts";

const options = new Options();
const out = new ByteBuf(1 << 12);
let checked = 0;
let bad = 0;
for (let c = 0x80; c <= 0x10ffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  const ch = String.fromCodePoint(c);
  for (const doc of [`a*${ch}*\n`, `*${ch}*a\n`, `a_${ch}_ b\n`, `${ch}**a** \n`, `**a**${ch}\n`, `~~${ch}~~x ~~y~~${ch}\n`]) {
    const bytes = Buffer.from(doc);
    out.reset();
    renderToHtmlWithOptions(bytes, options, out);
    const mine = Buffer.from(out.view()).toString("utf8");
    const theirs = Bun.markdown.html(doc);
    checked++;
    if (mine !== theirs) {
      bad++;
      if (bad <= 10) console.log("DIFF U+" + c.toString(16), JSON.stringify(doc), JSON.stringify(mine), JSON.stringify(theirs));
    }
  }
}

// Reference labels are compared case folded: [ch]: ... and [fold(ch)] must be the same label (and [ch2] for the others).
let labels = 0;
for (let c = 0x80; c <= 0x10ffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  caseFold(c);
  const f = FOLD.n === 1 ? String.fromCodePoint(FOLD.c0) : FOLD.n === 2 ? String.fromCodePoint(FOLD.c0, FOLD.c1) : String.fromCodePoint(FOLD.c0, FOLD.c1, FOLD.c2);
  const ch = String.fromCodePoint(c);
  if (f === ch) continue;
  for (const doc of [`[${ch}]: /u\n\n[${f}] x\n`, `[${f}]: /u\n\n[${ch}] x\n`]) {
    const bytes = Buffer.from(doc);
    out.reset();
    renderToHtmlWithOptions(bytes, options, out);
    const mine = Buffer.from(out.view()).toString("utf8");
    const theirs = Bun.markdown.html(doc);
    labels++;
    if (mine !== theirs || !mine.includes("<a ")) {
      bad++;
      if (bad <= 10) console.log("LABEL U+" + c.toString(16), JSON.stringify(doc), JSON.stringify(mine), JSON.stringify(theirs));
    }
  }
}
console.log(`${checked} documents, ${labels} label documents, ${bad} differ`);
process.exit(bad === 0 ? 0 : 1);
