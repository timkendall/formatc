// Self-test of src/format/markdown: texts and what `bun fmt` makes of them. `node src/format/markdown/markdown.test.ts`; compiled it prints
// the same. (Generated once with `tools/markdown/gen-test.mjs`; the expectations are Bun's output.)
import { ByteBuf } from "../../base/bytebuf.ts";
import { utf8Bytes } from "../../base/bytes.ts";
import { FormatOptions } from "../options.ts";
import { format, formatMdx } from "./mod.ts";

let total = 0;
let failures = 0;

function run(name: string, input: string, isMdx: boolean, flags: string[][], expected: string): void {
  total = total + 1;
  const options = new FormatOptions();
  for (let i = 0; i < flags.length; i++) options.set(flags[i][0], flags[i][1]);
  const out = new ByteBuf(256);
  const text = utf8Bytes(input);
  const r = isMdx ? formatMdx(text, options, out) : format(text, options, out);
  const actual = r === 0 ? out.toLatin1() : "(error " + r + ")";
  const want = new ByteBuf(expected.length + 8);
  want.appendAll(utf8Bytes(expected));
  if (actual !== want.toLatin1()) {
    failures = failures + 1;
    console.log("FAIL " + name + ": expected " + JSON.stringify(want.toUtf8()) + ", got " + JSON.stringify(r === 0 ? out.toUtf8() : actual));
  }
}

run("headings", "Title\n=====\n\nSub\n---\n\n#   ATX   heading  ##\n\n####### not a heading\n", false, [], "Title\n=====\n\nSub\n---\n\n# ATX heading\n\n####### not a heading\n");
run("emphasis", "*a* _b_ **c** __d__ ***e*** ~~f~~ *a*_b_ snake_case_word _a_b_ **a**__b__\n", false, [], "_a_ _b_ **c** **d** _**e**_ ~~f~~ *a*_b_ snake_case_word _a_b_ **a**__b__\n");
run("lists", "* a\n* b\n\n  para\n* c\n\n\n1) x\n2) y\n\n- [ ] todo\n- [x] done\n\n3. three\n3. three\n3. three\n", false, [], "- a\n- b\n\n  para\n\n- c\n\n1. x\n2. y\n\n- [ ] todo\n- [x] done\n\n3. three\n4. three\n5. three\n");
run("nested lists", "- a\n    - b\n        - c\n\n1. one\n   - sub\n2. two\n\n   para in two\n", false, [], "- a\n  - b\n    - c\n\n1. one\n   - sub\n2. two\n\n   para in two\n");
run("alternate markers", "- a\n\n<!-- -->\n\n- b\n\n<!-- -->\n\n- c\n", false, [], "- a\n\n<!-- -->\n\n- b\n\n<!-- -->\n\n- c\n");
run("blockquote", "> quote\ncontinued\n> > nested\n>\n> - list\n> - items\n\n>no space\n", false, [], "> quote\n> continued\n>\n> > nested\n>\n> - list\n> - items\n\n> no space\n");
run("fences", "````\n```\ninner\n```\n````\n\n~~~ ruby  linenos\nputs 1\n~~~\n\n    indented code\n    more\n\ntext\n\n```\ntrailing   \nspaces   \n```\n", false, [], "````\n```\ninner\n```\n````\n\n```ruby linenos\nputs 1\n```\n\n    indented code\n    more\n\ntext\n\n```\ntrailing\nspaces\n```\n");
run("tables", "|a|b|c|\n|:-|:-:|-:|\n|1|22|333|\n|`x|y`|\\|z|你好|\n\n| only head |\n|-|\n", false, [], "| a   |  b  |   c |\n| :-- | :-: | --: |\n| 1   | 22  | 333 |\n| `x  | y`  | \\|z | 你好 |\n\n| only head |\n| --------- |\n");
run("table never wrap", "| a | b |\n|---|---|\n| a very long cell that goes on and on and on and on and on and on and on and on and on | x |\n", false, [["proseWrap","never"]], "| a | b |\n| --- | --- |\n| a very long cell that goes on and on and on and on and on and on and on and on and on | x |\n");
run("links", "[a](http://x.com \"t\") [b](<http://x y.com>) ![img](a.png 'title') <http://auto.link> <me@x.com> https://literal.com www.example.com\n\n[ref]: http://example.com  \"Title\"\n[Other Ref]:   <http://x.com/a b>\n\n[ref] [Other Ref][] [text][ref] ![alt][ref]\n", false, [], "[a](http://x.com \"t\") [b](<http://x y.com>) ![img](a.png \"title\") <http://auto.link> <me@x.com> https://literal.com www.example.com\n\n[ref]: http://example.com \"Title\"\n[Other Ref]: <http://x.com/a b>\n\n[ref] [Other Ref][] [text][ref] ![alt][ref]\n");
run("footnotes", "Text[^1] and[^note].\n\n[^1]: First.\n[^note]:\n    Second\n\n    Para\n", false, [], "Text[^1] and[^note].\n\n[^1]: First.\n\n[^note]: Second\n\n    Para\n");
run("html", "<div>\n  <p>hi</p>\n</div>\n\ntext <span>inline</span> text\n\n<!-- comment -->\n\n<!-- prettier-ignore -->\n| a | b |\n|--|--|\n\n<!-- prettier-ignore-start -->\nkeep   this\n<!-- prettier-ignore-end -->\n", false, [], "<div>\n  <p>hi</p>\n</div>\n\ntext <span>inline</span> text\n\n<!-- comment -->\n\n<!-- prettier-ignore -->\n| a | b |\n|--|--|\n\n<!-- prettier-ignore-start -->\nkeep   this\n<!-- prettier-ignore-end -->\n");
run("hard breaks", "line one  \nline two\\\nline three\n\nsoft\nbreak\n", false, [], "line one  \nline two\\\nline three\n\nsoft\nbreak\n");
run("escapes", "\\* not emphasis \\_ 1\\. not list\n\n1986\\. A great year\n\n* \\+ plus\n\n+ a\n\n\\# no heading\n\n&amp; &copy; &#35; &#x23;\n", false, [], "\\* not emphasis \\_ 1\\. not list\n\n1986\\. A great year\n\n- \\+ plus\n\n* a\n\n\\# no heading\n\n&amp; &copy; &#35; &#x23;\n");
run("thematic breaks", "***\n\n___\n\n- - -\n\n* a\n\n---\n\n* b\n", false, [], "---\n\n---\n\n---\n\n- a\n\n---\n\n- b\n");
run("front matter", "---\ntitle:   a\nlist: [1,2,   3]\n---\n\n# Hi\n", false, [], "---\ntitle: a\nlist: [1, 2, 3]\n---\n\n# Hi\n");
run("toml front matter", "+++\ntitle  =  'a'\n+++\n\n# Hi\n", false, [], "+++\ntitle  =  'a'\n+++\n\n# Hi\n");
run("math", "$$\nx^2\n$$\n\ninline $a+b$ and $$c$$ text\n\n$5 and $6\n", false, [], "$$\nx^2\n$$\n\ninline $a+b$ and $$c$$ text\n\n$5 and $6\n");
run("liquid", "{% include foo.html %}\n\nText {{ var }} more\n\n{{ block\n   multi }}\n", false, [], "{% include foo.html %}\n\nText {{ var }} more\n\n{{ block\n   multi }}\n");
run("wiki links", "[[Wiki Link]] and [[a\nb]]\n", false, [["proseWrap","always"]], "[[Wiki Link]] and [[a\nb]]\n");
run("prose wrap always", "A very long line of prose that should be wrapped at eighty columns because the prose wrap option is set to always, and *emphasis that is long* too.\n\n- a list item with a very long line of prose that should be wrapped at eighty columns, also\n\n> a quote with a very long line of prose that should be wrapped at eighty columns, certainly\n", false, [["proseWrap","always"]], "A very long line of prose that should be wrapped at eighty columns because the\nprose wrap option is set to always, and _emphasis that is long_ too.\n\n- a list item with a very long line of prose that should be wrapped at eighty\n  columns, also\n\n> a quote with a very long line of prose that should be wrapped at eighty\n> columns, certainly\n");
run("prose wrap never", "line\nbreaks\nare\njoined\n\n- also\n  here\n", false, [["proseWrap","never"]], "line breaks are joined\n\n- also here\n");
run("cjk", "中文和English混合的文本，应该正确处理。\n한국어 텍스트\n日本語のテキスト\n", false, [["proseWrap","always"],["printWidth","20"]], "中文和English混合的文本，应该正确处理。한국어\n텍스트\n日本語のテキスト\n");
run("embedded json", "```json\n{\"a\":1,   \"b\":[1,2,3]}\n```\n\n```jsonc\n// c\n{\"a\":1}\n```\n", false, [], "```json\n{ \"a\": 1, \"b\": [1, 2, 3] }\n```\n\n```jsonc\n// c\n{ \"a\": 1 }\n```\n");
run("embedded yaml graphql", "```yaml\na:   1\nb:\n    - x\n```\n\n```graphql\nquery {   a  }\n```\n", false, [], "```yaml\na: 1\nb:\n  - x\n```\n\n```graphql\nquery {\n  a\n}\n```\n");
run("embedded markdown", "```md\n*  a\n*  b\n```\n", false, [], "```md\n- a\n- b\n```\n");
run("embedded off", "```json\n{\"a\":1}\n```\n", false, [["embeddedLanguageFormatting","off"]], "```json\n{\"a\":1}\n```\n");
run("tab width 4", "- a\n  - b\n\n1. x\n   1. y\n", false, [["tabWidth","4"]], "- a\n    - b\n\n1. x\n    1. y\n");
run("use tabs", "- a\n  - b\n\n```\nx\n```\n\n> - a\n>   - b\n", false, [["useTabs","true"]], "- a\n  - b\n\n```\nx\n```\n\n> - a\n>   - b\n");
run("single quote titles", "[a](b \"it's\") [c](d 'say \"hi\"') [e](f \"both ' and \\\"\")\n", false, [["singleQuote","true"]], "[a](b \"it's\") [c](d 'say \"hi\"') [e](f (both ' and \"))\n");
run("empty", "", false, [], "");
run("blank", "  \n\n", false, [], "");
run("only front matter", "---\na: 1\n---\n", false, [], "---\na: 1\n---\n");
run("trailing spaces and tabs", "a  \t\nb\n\n\tcode\n\n- x\t\n", false, [], "a\nb\n\n    code\n\n- x\n");
run("unicode", "emoji 😀 text — “quotes” … café\n\n| 😀 | é |\n|--|--|\n| a | b |\n", false, [], "emoji 😀 text — “quotes” … café\n\n| 😀  | é   |\n| --- | --- |\n| a   | b   |\n");
run("setext in list", "- Title\n  =====\n- Other\n  ---\n", false, [], "- Title\n  =====\n- Other\n  ---\n");
run("long numbers", "1. a\n1. b\n1. c\n\n0. a\n0. b\n\n99. a\n100. b\n", false, [], "1. a\n1. b\n1. c\n\n1. a\n1. b\n\n1. a\n1. b\n");
run("html in list", "- a\n  <div>x</div>\n- b\n\n  <div>y</div>\n", false, [], "- a\n  <div>x</div>\n- b\n\n  <div>y</div>\n");
run("definition list-ish", "Term\n: Definition\n\n:::note\nhello\n:::\n", false, [], "Term\n: Definition\n\n:::note\nhello\n:::\n");
run("mdx basic", "# Hi\n\n<Foo bar=\"1\" />\n\n{/* comment */}\n\nText *a* **b** snake_case\n\n* item\n\n  <Bar />\n", true, [], "# Hi\n\n<Foo bar=\"1\" />\n\n{/* comment */}\n\nText _a_ **b** snake_case\n\n- item\n\n  <Bar />\n");
run("bom", "﻿# Title   x\n", false, [], "﻿# Title x\n");
run("crlf", "# Title\r\n\r\ntext\r\nmore\r\n\r\n- a\r\n- b\r\n", false, [], "# Title\n\ntext\nmore\n\n- a\n- b\n");
run("crlf endOfLine crlf", "# Title\n\ntext\nmore\n", false, [["endOfLine","crlf"]], "# Title\r\n\r\ntext\r\nmore\r\n");
run("cr", "# Title\r\rtext\rmore\r", false, [], "# Title\n\ntext\nmore\n");

console.log(total - failures + "/" + total + " markdown checks passed");
if (failures > 0) process.exit(1);
