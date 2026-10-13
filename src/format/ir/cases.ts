// Documents with the text Prettier prints for them (checked against Prettier's `printDocToString` by tools/ir-check.ts,
// and against the printer of ir/ by ir.test.ts).
import * as T from "./testdoc.ts";

export class Case {
  name: string;
  doc: T.D;
  width: number;
  useTabs: boolean;
  tabWidth: number;
  expected: string;
  constructor(name: string, doc: T.D, width: number, useTabs: boolean, tabWidth: number, expected: string) {
    this.name = name;
    this.doc = doc;
    this.width = width;
    this.useTabs = useTabs;
    this.tabWidth = tabWidth;
    this.expected = expected;
  }
}

const t = T.text;
const line = T.line;
const softline = T.softline;
const hardline = T.hardline;

function call(args: T.D): T.D {
  return T.group(t("foo("), T.softBlockIndent(args), t(")"));
}

function xs(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += "x";
  return s;
}

function cjk(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += "中";
  return s;
}

function emoji(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += "👍";
  return s;
}

export function cases(): Case[] {
  const cs: Case[] = [];
  function add(name: string, doc: T.D, width: number, expected: string): void {
    cs.push(new Case(name, doc, width, false, 2, expected));
  }
  function addTabs(name: string, doc: T.D, width: number, tabWidth: number, expected: string): void {
    cs.push(new Case(name, doc, width, true, tabWidth, expected));
  }
  function addSpaces(name: string, doc: T.D, width: number, tabWidth: number, expected: string): void {
    cs.push(new Case(name, doc, width, false, tabWidth, expected));
  }

  // group fits / breaks
  const args = T.seq(t("a"), t(","), line(), t("b"));
  add("group fits", call(args), 80, "foo(a, b)");
  add("group breaks", call(args), 8, "foo(\n  a,\n  b\n)");
  add("group fits exactly", T.group(t(xs(75)), line(), t(xs(4))), 80, xs(75) + " " + xs(4));
  add("group one over", T.group(t(xs(75)), line(), t(xs(5))), 80, xs(75) + "\n" + xs(5));
  // nested groups: the outer breaks, the inner fits
  add(
    "nested groups",
    T.group(t("["), T.softBlockIndent(T.group(t("x"), line(), t("y")), t(","), line(), t("zzzz")), t("]")),
    10,
    "[\n  x y,\n  zzzz\n]",
  );
  add(
    "nested groups both break",
    T.group(t("["), T.softBlockIndent(T.group(t("xxxx"), line(), t("yyyy")), t(","), line(), t("zzzz")), t("]")),
    8,
    "[\n  xxxx\n  yyyy,\n  zzzz\n]",
  );
  // what follows a group counts up to the first possible line break
  add("rest counts", T.seq(T.group(t("aaa"), line(), t("bbb")), t(";;;;")), 9, "aaa\nbbb;;;;");
  add("rest counts, fits", T.seq(T.group(t("aaa"), line(), t("bbb")), t(";;;;")), 11, "aaa bbb;;;;");
  // hardline breaks the group, soft lines in other groups are not affected
  add("hardline breaks the group", T.group(t("a"), line(), t("b"), hardline(), t("c")), 80, "a\nb\nc");
  add(
    "hardline in a nested group",
    T.group(t("a"), line(), T.group(t("b"), hardline(), t("c")), line(), t("d")),
    80,
    "a\nb\nc\nd",
  );
  add("break parent", T.group(t("a"), line(), t("b"), T.breakParent()), 80, "a\nb");
  add("group with shouldBreak", T.groupBreak(t("a"), line(), t("b")), 80, "a\nb");
  add("soft line flat", T.group(t("a"), softline(), t("b")), 80, "ab");
  add("soft line broken", T.groupBreak(t("a"), softline(), t("b")), 80, "a\nb");
  // indent and soft block indent
  add("indent + hardline", T.seq(t("a {"), T.indent(hardline(), t("b")), hardline(), t("}")), 80, "a {\n  b\n}");
  add("block indent", T.seq(t("a {"), T.blockIndent(t("b"), hardline(), t("c")), t("}")), 80, "a {\n  b\n  c\n}");
  add("soft space block indent flat", T.group(t("{"), T.softSpaceBlockIndent(t("a")), t("}")), 80, "{ a }");
  add("soft space block indent broken", T.group(t("{"), T.softSpaceBlockIndent(t("a")), t("}")), 2, "{\n  a\n}");
  // ifBreak
  const arr = (): T.D =>
    T.group(t("["), T.indent(softline(), t("a"), t(","), line(), t("bb")), T.ifBreak(t(","), t("")), softline(), t("]"));
  add("ifBreak flat", arr(), 80, "[a, bb]");
  add("ifBreak broken", arr(), 5, "[\n  a,\n  bb,\n]");
  add("tokenIfBreaks flat", T.group(t("("), T.softBlockIndent(t("a"), T.tokenIfBreaks(",")), t(")")), 80, "(a)");
  add("tokenIfBreaks broken", T.group(t("("), T.softBlockIndent(t("aaaa"), T.tokenIfBreaks(",")), t(")")), 4, "(\n  aaaa,\n)");
  // ifBreak with a group id: the trailing comma depends on another group
  add(
    "ifBreak with group id",
    T.seq(T.groupId(1, t("a"), T.indent(softline(), t("bb"))), T.ifBreakId(1, t("!"), t("?"))),
    3,
    "a\n  bb!",
  );
  add(
    "ifBreak with group id, flat",
    T.seq(T.groupId(1, t("a"), T.indent(softline(), t("bb"))), T.ifBreakId(1, t("!"), t("?"))),
    80,
    "abb?",
  );
  // indentIfBreak
  add(
    "indentIfBreak, broken",
    T.seq(T.groupId(1, t("aaa"), T.indent(line())), T.indentIfBreak(1, t("b"), hardline(), t("c"))),
    4,
    "aaa\n  b\n  c",
  );
  add(
    "indentIfBreak, flat",
    T.seq(T.groupId(1, t("aaa"), T.indent(line())), T.indentIfBreak(1, t("b"), hardline(), t("c"))),
    80,
    "aaa b\nc",
  );
  // IndentedLineGroup is group(indent(line)) with an id
  add(
    "indented line group, flat",
    T.seq(t("aaa"), T.indentedLineGroup(1), T.indentIfBreak(1, t("b"), hardline(), t("c"))),
    80,
    "aaa b\nc",
  );
  add(
    "indented line group, broken",
    T.seq(t("aaa"), T.indentedLineGroup(1), T.indentIfBreak(1, t("b"), hardline(), t("c"))),
    4,
    "aaa\n  b\n  c",
  );
  // fill
  add(
    "fill",
    T.fill(t("aaa"), line(), t("bbb"), line(), t("ccc"), line(), t("ddd"), line(), t("eee")),
    10,
    "aaa bbb\nccc ddd\neee",
  );
  add("fill all fit", T.fill(t("aaa"), line(), t("bbb"), line(), t("ccc")), 80, "aaa bbb ccc");
  add(
    "fill with a long item",
    T.fill(t("a"), line(), t(xs(12)), line(), t("b"), line(), t("c")),
    10,
    "a\n" + xs(12) + "\nb c",
  );
  add(
    "fill in indent",
    T.indent(t("["), T.fill(t("aaa"), line(), t("bbb"), line(), t("ccc"))),
    9,
    "[aaa bbb\n  ccc",
  );
  add("fill of soft lines", T.fill(t("aaa"), softline(), t("bbb"), softline(), t("ccc")), 7, "aaabbb\nccc");
  // line suffix
  add("line suffix", T.seq(t("a"), T.lineSuffix(t(" // c")), t(";"), hardline(), t("b")), 80, "a; // c\nb");
  add("line suffix flushed at the end", T.seq(t("a"), T.lineSuffix(t(" // c")), t(";")), 80, "a; // c");
  add(
    "line suffix boundary",
    T.seq(t("a"), T.lineSuffix(t(" // c")), T.lineSuffixBoundary(), t("x")),
    80,
    "a // c\nx",
  );
  add("line suffix boundary without suffix", T.seq(t("a"), T.lineSuffixBoundary(), t("x")), 80, "ax");
  add(
    "line suffix does not count",
    T.group(t("aaaa"), T.lineSuffix(t(" // long long comment")), line(), t("bbb")),
    10,
    "aaaa bbb // long long comment",
  );
  // best fitting
  const fn = (): T.D =>
    T.best(
      T.seq(t("f("), t("aaaa"), t(")")),
      T.group(t("f("), T.indent(softline(), t("aaaa")), softline(), t(")")),
    );
  add("best fitting, first", fn(), 80, "f(aaaa)");
  add("best fitting, last", fn(), 5, "f(\n  aaaa\n)");
  add(
    "best fitting, middle",
    T.best(t("xxxxxxxxxx"), T.seq(t("yyyy"), t("yyyy")), T.seq(t("z"), hardline(), t("z"))),
    9,
    "yyyyyyyy",
  );
  add(
    "best fitting, none",
    T.best(t("xxxxxxxxxx"), T.seq(t("yyyy"), t("yyyyyyy")), T.seq(t("z"), hardline(), t("z"))),
    9,
    "z\nz",
  );
  add(
    "best fitting followed by text",
    T.seq(T.best(t("aaa"), T.seq(t("a"), hardline(), t("a"))), t("bbbbbbb")),
    9,
    "a\nabbbbbbb",
  );
  // align and dedent
  add("align", T.seq(t("a"), T.align(2, hardline(), t("b"))), 80, "a\n  b");
  add("align 0 does nothing", T.seq(t("a"), T.align(0, hardline(), t("b"))), 80, "a\nb");
  add("indent + align", T.indent(t("a"), T.align(3, hardline(), t("b"))), 80, "a\n     b");
  add("nested align", T.align(2, t("a"), T.align(3, hardline(), t("b"))), 80, "a\n     b");
  add(
    "dedent to root",
    T.indent(t("a"), hardline(), t("b"), T.dedentToRoot(hardline(), t("c"))),
    80,
    "a\n  b\nc",
  );
  add("dedent", T.indent(T.indent(t("a"), T.dedent(hardline(), t("b")))), 80, "a\n  b");
  // tabs and spaces
  addTabs("tabs", T.indent(t("a"), hardline(), t("b"), T.indent(hardline(), t("c"))), 80, 4, "a\n\tb\n\t\tc");
  addSpaces("spaces, tab width 4", T.indent(t("a"), hardline(), t("b"), T.indent(hardline(), t("c"))), 80, 4, "a\n    b\n        c");
  addTabs("tabs: trailing align is spaces", T.seq(t("a"), T.align(2, hardline(), t("b"))), 80, 4, "a\n  b");
  addTabs("tabs: indent + align", T.indent(t("a"), T.align(2, hardline(), t("b"))), 80, 4, "a\n\t  b");
  addTabs("tabs: align + indent", T.align(2, t("a"), T.indent(hardline(), t("b"))), 80, 4, "a\n\t\tb");
  addSpaces("spaces: align + indent", T.align(2, t("a"), T.indent(hardline(), t("b"))), 80, 4, "a\n      b");
  addTabs(
    "tabs break a group by the width of a tab",
    T.indent(T.group(t("aaaa"), line(), t("bbb"))),
    13,
    4,
    "aaaa bbb",
  );
  addTabs(
    "tabs: width of the indentation counts",
    T.seq(t("x"), T.indent(hardline(), T.group(t("aaaa"), line(), t("bbbbbbb")))),
    13,
    4,
    "x\n\taaaa\n\tbbbbbbb",
  );
  // text widths
  add("width: cjk fits", T.group(t("["), T.softBlockIndent(t(cjk(39))), t("]")), 80, "[" + cjk(39) + "]");
  add("width: cjk breaks", T.group(t("["), T.softBlockIndent(t(cjk(40))), t("]")), 80, "[\n  " + cjk(40) + "\n]");
  add("width: emoji fits", T.group(t("["), T.softBlockIndent(t(emoji(39))), t("]")), 80, "[" + emoji(39) + "]");
  add("width: emoji breaks", T.group(t("["), T.softBlockIndent(t(emoji(40))), t("]")), 80, "[\n  " + emoji(40) + "\n]");
  add("width: combining mark", T.group(t(xs(77)), t("e\u0301"), line(), t("y")), 80, xs(77) + "e\u0301 y");
  add("width: tab counts as nothing", T.group(t("a\tb"), line(), t("c")), 4, "a\tb c");
  // groups with ids that are broken by a nested hardline
  add(
    "group id broken by a nested hardline",
    T.seq(T.groupId(1, t("a"), hardline(), t("b")), T.ifBreakId(1, t("!"), t("?"))),
    80,
    "a\nb!",
  );
  // conditional content inside a group that does not fit
  add(
    "ifBreak in break mode is printed",
    T.groupBreak(t("a"), T.ifBreak(t("X"), t("Y")), line(), t("b")),
    80,
    "aX\nb",
  );
  add("ifBreak in flat mode", T.group(t("a"), T.ifBreak(t("X"), t("Y")), line(), t("b")), 80, "aY b");
  return cs;
}
