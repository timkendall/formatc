// Self-test of src/parsers/{yaml,toml}.ts. Runs under node (`node tools/parsers/selftest.ts`) and compiled
// (`scriptc build tools/parsers/selftest.ts -o selftest`). The expected values were checked against Bun's own parser
// (accept/reject and the place of the error with `bun fmt`) by tools/parsers/{yaml,toml}-diff.ts; the token ranges are
// regression values (the differential tests check their form, and every simple string of Bun's value against them).
// Rust has no unit tests for these parsers.
import {
  yamlParseAsWritten, yamlErrorPos, yamlDocCount, yamlDocRoot, yamlNodeKind, yamlNodeCount, yamlItem, yamlPropKey, yamlPropValue,
  yamlTokenCount, yamlTokenKind, yamlTokenStart, yamlTokenEnd, parseErrorName, yamlSetMaxDepth, yamlMaxDepth, PE_STACK_OVERFLOW,
  yamlNodeLoc, NK_OBJECT,
} from "../../src/parsers/yaml.ts";
import {
  tomlTokens, tomlErrorMessage, tomlErrorPos, tomlTokenCount, tomlTokenKind, tomlTokenStart, tomlTokenEnd,
} from "../../src/parsers/toml.ts";

const YAML_CASES: string[] = [
  "",
  "a: 1\n",
  "a: 1\nb: [x, y]\n",
  "- a\n- b: c\n  d: e\n",
  "# c\nkey: |\n  text\n  more\nother: 'q' # t\n",
  "---\n!!str a: &x b\n...\n---\nfoo\n",
  "a: [1, 2\nb: c\n",
  "? a\n: b\n",
  "{a: 1, b: [2, 3], ? c : d}",
  "a: *x\n",
  "%YAML 1.2\n---\na: 1\n",
  "%TAG !e! tag:example.com,2000:\n---\n!e!foo bar\n",
  "a:\n\t- b\n",
  "a: 1\n  b: 2\n",
  "a: \"x\n",
  "key: >-\n  folded\n  text\n\nnext: 1\n",
  "- - a\n  - b\n- - c\n",
  "a: &anchor\n  b: c\n",
  "[a, b: c, ? d : e]\n",
  "'a': b\n\"c\": d\n",
  "a: |2\n    x\n   y\n",
  "- |\n a\n- >\n b\n",
  "a: !!set\n  ? b\n  ? c\n",
  "\"\\u00e9\\x41\\U0001F600\": 1\n",
  "a: b: c\n",
  "&a a: 1\n*a : 2\n",
  "a: 'it''s'\n",
  "plain\n  multi line\n  scalar\n",
  "---\n...\n",
  "a: 1\r\nb: 2\r\n",
  "\u00e9: \u00e8\n"
  ];
const YAML_EXPECTED: string[] = [
  "~ ;",
  "{s:s} ; 15@0-1 6@1-2 15@3-5",
  "{s:s,s:[s,s]} ; 15@0-1 6@1-2 15@3-5 15@5-6 6@6-7 8@8-9 15@9-10 7@10-11 15@12-13 9@13-14",
  "[s,{s:s,s:s}] ; 4@0-1 15@2-4 4@4-5 15@6-7 6@7-8 15@9-13 15@13-14 6@14-15 15@16-18",
  "{s:s,s:s} ; 0@0-3 15@4-7 6@7-8 15@9-25 15@25-30 6@30-31 15@32-35 0@36-39",
  "{s:s} | s ; 2@0-3 14@4-9 15@10-11 6@11-12 12@13-15 15@16-18 3@18-21 2@22-25 15@26-30",
  "ERR UnexpectedToken 9",
  "{s:s} ; 5@0-1 15@2-4 6@4-5 15@6-8",
  "{s:s,s:[s,s],s:s} ; 10@0-1 15@1-2 6@2-3 15@4-5 7@5-6 15@7-8 6@8-9 8@10-11 15@11-12 7@12-13 15@14-15 9@15-16 7@16-17 5@18-19 15@20-22 6@22-23 15@24-25 11@25-26",
  "{s:*} ; 15@0-1 6@1-2 13@3-5",
  "{s:s} ; 1@0-1 2@10-13 15@14-15 6@15-16 15@17-19",
  "s ; 1@0-1 2@31-34 14@35-41 15@42-46",
  "ERR TabIndentation 4",
  "ERR UnexpectedToken 8",
  "ERR UnexpectedCharacter 6",
  "{s:s,s:s} ; 15@0-3 6@3-4 15@5-25 15@25-29 6@29-30 15@31-33",
  "[[s,s],[s]] ; 4@0-1 4@2-3 15@4-8 4@8-9 15@10-12 4@12-13 4@14-15 15@16-18",
  "{s:{s:s}} ; 15@0-1 6@1-2 12@3-10 15@13-14 6@14-15 15@16-18",
  "[s,{s:s},{s:s}] ; 8@0-1 15@1-2 7@2-3 15@4-5 6@5-6 15@7-8 7@8-9 5@10-11 15@12-14 6@14-15 15@16-17 9@17-18",
  "{s:s,s:s} ; 15@0-3 6@3-4 15@5-7 15@7-10 6@10-11 15@12-14",
  "{s:s} ; 15@0-1 6@1-2 15@3-17",
  "[s,s] ; 4@0-1 15@2-7 4@7-8 15@9-14",
  "{s:{s:~,s:~}} ; 15@0-1 6@1-2 14@3-8 5@11-12 15@13-17 5@17-18 15@19-21",
  "{s:s} ; 15@0-22 6@22-23 15@24-26",
  "ERR UnexpectedToken 4",
  "{s:s,*:s} ; 12@0-2 15@3-4 6@4-5 15@6-8 13@8-10 6@11-12 15@13-15",
  "{s:s} ; 15@0-1 6@1-2 15@3-10",
  "s ; 15@0-28",
  "~ ; 2@0-3 3@4-7",
  "{s:s,s:s} ; 15@0-1 6@1-2 15@3-6 15@6-7 6@7-8 15@9-12",
  "{s:s} ; 15@0-2 6@2-3 15@4-7"
  ];
const TOML_CASES: string[] = [
  "",
  "a = 1\n",
  "[t]\na = \"x\"\n[[u]]\nb = [1, 2,\n 3]\n",
  "a.b . 'c' = { x = 1, y = [true, 1979-05-27] }\n",
  "a = [1\n",
  "a = 0x\n",
  "k = \"\"\"x\ny\"\"\"\n# end",
  "a = 1\r\nb = 2\r\n",
  "\u00e9 = 1\n",
  "a = \"\\uD800\"\n",
  "a = 1__0\n",
  "[a]]\n",
  "a = {x = 1\n",
  "x = 1979-02-30\n",
  "a = 12345678901234567890123\n",
  "\ufeffa = 1\n"
  ];
const TOML_EXPECTED: string[] = [
  "",
  "4@0-1 6@2-3 7@4-5",
  "0@0-1 4@1-2 1@2-3 4@4-5 6@6-7 7@8-11 2@12-14 4@14-15 3@15-17 4@18-19 6@20-21 8@22-23 7@23-24 12@24-25 7@26-27 12@27-28 7@30-31 9@31-32",
  "4@0-1 5@1-2 4@2-3 5@4-5 4@6-9 6@10-11 10@12-13 4@14-15 6@16-17 7@18-19 12@19-20 4@21-22 6@23-24 8@25-26 7@26-30 12@30-31 7@32-42 9@42-43 11@44-45",
  "ERR Expected ',' or ']' in an array but found end of file @7",
  "ERR Expected at least one digit after the radix prefix @6",
  "4@0-1 6@2-3 7@4-13",
  "4@0-1 6@2-3 7@4-5 4@7-8 6@9-10 7@11-12",
  "ERR Expected a key but found (0xC3) @0",
  "ERR Escaped code point must be a Unicode scalar value @5",
  "ERR Underscores in numbers must be surrounded by digits @5",
  "ERR Expected a newline or end of file after a table header @3",
  "ERR Expected ',' or '}' in an inline table but found end of file @11",
  "ERR Invalid date: day is out of range for the month @12",
  "4@0-1 6@2-3 7@4-27",
  "4@3-4 6@5-6 7@7-8"
  ];

const enc = new TextEncoder();

function showNode(id: number): string {
  const k = yamlNodeKind(id);
  if (k === 0) return "~";
  if (k === 1) return "s";
  if (k === 2) return "*";
  let o = "";
  const count = yamlNodeCount(id);
  if (k === 3) {
    for (let i = 0; i < count; i++) o = o + (i > 0 ? "," : "") + showNode(yamlPropKey(id, i)) + ":" + showNode(yamlPropValue(id, i));
    return "{" + o + "}";
  }
  for (let i = 0; i < count; i++) o = o + (i > 0 ? "," : "") + showNode(yamlItem(id, i));
  return "[" + o + "]";
}

function yamlDump(s: string): string {
  const b = enc.encode(s);
  const r = yamlParseAsWritten(b, b.length);
  if (r !== 0) return "ERR " + parseErrorName(r) + " " + yamlErrorPos();
  let o = "";
  for (let i = 0; i < yamlDocCount(); i++) o = o + (i > 0 ? " | " : "") + showNode(yamlDocRoot(i));
  o = o + " ;";
  for (let i = 0; i < yamlTokenCount(); i++) o = o + " " + yamlTokenKind(i) + "@" + yamlTokenStart(i) + "-" + yamlTokenEnd(i);
  return o;
}

function tomlDump(s: string): string {
  const b = enc.encode(s);
  const r = tomlTokens(b, b.length);
  if (r !== 0) return "ERR " + tomlErrorMessage() + " @" + tomlErrorPos();
  let o = "";
  for (let i = 0; i < tomlTokenCount(); i++) o = o + (i > 0 ? " " : "") + tomlTokenKind(i) + "@" + tomlTokenStart(i) + "-" + tomlTokenEnd(i);
  return o;
}

let failures = 0;
let checks = 0;
function expect(what: string, got: string, want: string): void {
  checks = checks + 1;
  if (got !== want) {
    failures = failures + 1;
    console.log("FAIL " + what + "\n   got:  " + got + "\n   want: " + want);
  }
}

for (let i = 0; i < YAML_CASES.length; i++) expect("yaml " + JSON.stringify(YAML_CASES[i]), yamlDump(YAML_CASES[i]), YAML_EXPECTED[i]);
for (let i = 0; i < TOML_CASES.length; i++) expect("toml " + JSON.stringify(TOML_CASES[i]), tomlDump(TOML_CASES[i]), TOML_EXPECTED[i]);

// The place of a node: `key.loc == node.loc` tells a block mapping that starts with a flow collection from the flow
// mapping (format/yaml/ast.rs `is_in_braces`).
{
  const b = enc.encode("[a]: b\n");
  yamlParseAsWritten(b, b.length);
  const root = yamlDocRoot(0);
  expect("block mapping with a flow key: kind", String(yamlNodeKind(root)), String(NK_OBJECT));
  expect("block mapping with a flow key: loc of mapping", String(yamlNodeLoc(root)), "0");
  expect("block mapping with a flow key: loc of key", String(yamlNodeLoc(yamlPropKey(root, 0))), "0");
}
{
  const b = enc.encode("{[a]: b}\n");
  yamlParseAsWritten(b, b.length);
  const root = yamlDocRoot(0);
  expect("flow mapping with a flow key: loc of mapping", String(yamlNodeLoc(root)), "0");
  expect("flow mapping with a flow key: loc of key", String(yamlNodeLoc(yamlPropKey(root, 0))), "1");
}

// Nesting: the budget, and that a parse after one that ran out starts clean.
{
  const old = yamlMaxDepth();
  yamlSetMaxDepth(50);
  let deep = "";
  for (let i = 0; i < 100; i++) deep = deep + "[";
  for (let i = 0; i < 100; i++) deep = deep + "]";
  expect("nested too deeply", yamlDump(deep).slice(0, 3), "ERR");
  const b = enc.encode(deep);
  expect("nested too deeply: kind", parseErrorName(yamlParseAsWritten(b, b.length)), parseErrorName(PE_STACK_OVERFLOW));
  expect("after a refusal", yamlDump("a: 1\n"), YAML_EXPECTED[1]);
  yamlSetMaxDepth(old);
  let ok = "";
  for (let i = 0; i < 40; i++) ok = ok + "[";
  for (let i = 0; i < 40; i++) ok = ok + "]";
  expect("deep enough", yamlDump(ok).slice(0, 3), "[[[");
}

// Large and repeated: the storage is reused
{
  let text = "";
  for (let i = 0; i < 3000; i++) text = text + "key" + i + ": [a, b, {c: d}]\n";
  const first = yamlDump(text);
  const again = yamlDump(text);
  expect("repeated parse of a big text", again, first);
  const b = enc.encode(text);
  yamlParseAsWritten(b, b.length);
  expect("tokens of a big text", String(yamlTokenCount()), String(3000 * 13));
  expect("mapping of a big text", String(yamlNodeCount(yamlDocRoot(0))), "3000");
}

console.log(failures === 0 ? "selftest ok: " + checks + " checks" : "selftest FAILED: " + failures + " of " + checks);
if (failures > 0) process.exit(1);
