// Random GraphQL documents (valid ones, with comments and odd white space in all places), for fmt.ts vs oracle.ts:
//   node tools/graphql/gen.ts <outdir> <count> [seed] [parts]
import * as fs from "node:fs";

let state = parseInt(process.argv[4] ?? "1") >>> 0;
function rnd(n: number): number {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return (state >>> 8) % n;
}
function pick<T>(a: T[]): T {
  return a[rnd(a.length)];
}
const names = ["a", "b", "foo", "bar", "baz", "veryLongFieldNameNumberOne", "veryLongFieldNameNumberTwo", "_x", "A1", "id", "user", "node", "edges", "x__y", "type", "query", "on", "fragment"];
const typeNames = ["Int", "String", "User", "Query", "Node", "VeryLongTypeNameForTheTest", "ID", "Boolean"];
const locations = ["QUERY", "FIELD", "FIELD_DEFINITION", "INPUT_FIELD_DEFINITION", "OBJECT", "ENUM_VALUE", "SCHEMA"];

// White space between tokens: nothing, a space, line breaks, a comment.
function ws(): string {
  if (process.env.PLAIN) return pick(["\n", "\n", "\n", " ", "\n\n", " "]);
  switch (rnd(14)) {
    case 0: return "\n";
    case 1: return "\n\n";
    case 2: return "\n\n\n";
    case 3: return " # comment " + rnd(100) + "\n";
    case 4: return "\n# own line comment\n";
    case 5: return "\n\n# own line comment after blank\n\n";
    case 6: return ",";
    case 7: return " , ";
    case 8: return "\t";
    case 9: return "  ";
    default: return " ";
  }
}
function sp(): string {
  return rnd(3) === 0 ? ws() : " ";
}
function opt(s: string): string {
  return rnd(3) === 0 ? ws() : "";
}
function name(): string { return pick(names); }
function typeName(): string { return pick(typeNames); }
function str(): string {
  switch (rnd(9)) {
    case 0: return '"hello"';
    case 1: return '""';
    case 2: return '"with \\"quote\\" and \\\\ and \\n and \\t and \\u00e9 and \\u{1F600}"';
    case 3: return '"""block"""';
    case 4: return '"""\n  indented block\n    more indented\n  back\n"""';
    case 5: return '"""\n\n\n  lots\n\n\n\n  of blanks\n\n"""';
    case 6: return '"""  a \\""" b  """';
    case 7: return '"""\n\ttabbed\n\t\tmore\n"""';
    default: return '"""\n   first line\n  second\n   third  \n"""';
  }
}
function value(d: number, isConst: boolean): string {
  const k = rnd(d > 3 ? 7 : 10);
  switch (k) {
    case 0: return String(rnd(1000) - 100);
    case 1: return (rnd(1000) / 10).toFixed(1) + (rnd(3) === 0 ? "e" + (rnd(5) - 2) : "");
    case 2: return str();
    case 3: return pick(["true", "false", "null"]);
    case 4: return pick(["RED", "GREEN", "BLUE", "ENUM_VALUE"]);
    case 5: return isConst ? "0" : "$" + name();
    case 6: return "-0";
    case 7: case 8: {
      let s = "[" + opt("");
      const n = rnd(5);
      for (let i = 0; i < n; i++) s += value(d + 1, isConst) + (i + 1 < n ? sp() : "") + (rnd(8) === 0 ? "," : "");
      return s + opt("") + "]";
    }
    default: {
      let s = "{" + opt("");
      const n = rnd(4);
      for (let i = 0; i < n; i++) s += name() + (rnd(4) === 0 ? " " : "") + ":" + sp() + value(d + 1, isConst) + (i + 1 < n ? sp() : "");
      return s + opt("") + "}";
    }
  }
}
function args(isConst: boolean): string {
  const n = rnd(5);
  if (n === 0) return "";
  let s = "(" + opt("");
  for (let i = 0; i < n; i++) s += name() + ":" + sp() + value(0, isConst) + (i + 1 < n ? sp() : "");
  return s + opt("") + ")";
}
function directives(isConst: boolean): string {
  let s = "";
  const n = rnd(4) === 0 ? 1 + rnd(3) : 0;
  for (let i = 0; i < n; i++) s += sp() + "@" + name() + args(isConst);
  return s;
}
function type(d: number): string {
  let t = d < 2 && rnd(3) === 0 ? "[" + opt("") + type(d + 1) + opt("") + "]" : typeName();
  if (rnd(3) === 0) t += "!";
  return t;
}
function desc(): string {
  if (process.env.PLAIN) return rnd(3) === 0 ? pick(['"A description of this field."', '"""\n  A longer description\n  of the thing.\n  """']) + "\n" : "";
  return rnd(4) === 0 ? str() + pick(["\n", " ", "\n\n"]) : "";
}
function selection(d: number): string {
  let s = "{" + ws();
  const n = 1 + rnd(4);
  for (let i = 0; i < n; i++) {
    switch (rnd(d > 3 ? 3 : 6)) {
      case 0: s += name() + args(false) + directives(false); break;
      case 1: s += name() + ":" + sp() + name() + args(false) + directives(false); break;
      case 2: s += "..." + name() + directives(false); break;
      case 3: s += "... on " + typeName() + directives(false) + sp() + selection(d + 1); break;
      case 4: s += "..." + directives(false) + sp() + selection(d + 1); break;
      default: s += name() + args(false) + directives(false) + sp() + selection(d + 1); break;
    }
    s += i + 1 < n ? ws() : "";
  }
  return s + ws() + "}";
}
function varDefs(): string {
  const n = rnd(4);
  if (n === 0) return "";
  let s = "(" + opt("");
  for (let i = 0; i < n; i++) {
    s += (rnd(6) === 0 ? desc() : "") + "$" + name() + ":" + sp() + type(0) + (rnd(3) === 0 ? " = " + value(0, true) : "") + directives(true) + (i + 1 < n ? sp() : "");
  }
  return s + opt("") + ")";
}
function inputValues(): string {
  const n = rnd(4);
  if (n === 0) return "";
  let s = "(" + opt("");
  for (let i = 0; i < n; i++) {
    s += desc() + name() + ":" + sp() + type(0) + (rnd(3) === 0 ? " = " + value(0, true) : "") + directives(true) + (i + 1 < n ? sp() : "");
  }
  return s + opt("") + ")";
}
function fields(input: boolean): string {
  const n = rnd(5);
  if (n === 0) return "";
  let s = " {" + ws();
  for (let i = 0; i < n; i++) {
    s += desc() + name() + (input ? "" : inputValues()) + ":" + sp() + type(0) + (input && rnd(3) === 0 ? " = " + value(0, true) : "") + directives(true) + (i + 1 < n ? ws() : "");
  }
  return s + ws() + "}";
}
function definition(): string {
  switch (rnd(16)) {
    case 0: return selection(0);
    case 1: case 2: return pick(["query", "mutation", "subscription"]) + (rnd(4) === 0 ? "" : " " + name()) + varDefs() + directives(false) + sp() + selection(0);
    case 3: return "fragment " + name().replace(/^on$/, "xon") + varDefs() + " on " + typeName() + directives(false) + sp() + selection(0);
    case 4: return desc() + "type " + typeName() + (rnd(2) === 0 ? " implements " + pick(["", "& "]) + typeName() + (rnd(2) === 0 ? sp() + "&" + sp() + typeName() : "") + (rnd(3) === 0 ? " & VeryLongInterfaceNameNumberOne & VeryLongInterfaceNameNumberTwo" : "") : "") + directives(true) + fields(false);
    case 5: return desc() + "interface " + typeName() + (rnd(3) === 0 ? " implements " + typeName() : "") + directives(true) + fields(false);
    case 6: return desc() + "input " + typeName() + directives(true) + fields(true);
    case 7: {
      let s = desc() + "enum " + typeName() + directives(true);
      const n = rnd(4);
      if (n > 0) {
        s += " {" + ws();
        for (let i = 0; i < n; i++) s += desc() + pick(["RED", "GREEN", "BLUE", "ENUM_VALUE_" + i]) + directives(true) + (i + 1 < n ? ws() : "");
        s += ws() + "}";
      }
      return s;
    }
    case 8: {
      let s = desc() + "union " + typeName() + directives(true);
      const n = rnd(5);
      if (n > 0) {
        s += sp() + "=" + sp() + (rnd(2) === 0 ? "|" + sp() : "");
        for (let i = 0; i < n; i++) s += (i > 0 ? sp() + "|" + sp() : "") + (rnd(4) === 0 ? "VeryLongUnionMemberTypeName" + i : typeName());
      }
      return s;
    }
    case 9: return desc() + "scalar " + typeName() + directives(true);
    case 10: {
      let s = desc() + "schema" + directives(true) + " {" + ws();
      const ops = ["query", "mutation", "subscription"];
      const n = 1 + rnd(3);
      for (let i = 0; i < n; i++) s += ops[i] + ":" + sp() + typeName() + (i + 1 < n ? ws() : "");
      return s + ws() + "}";
    }
    case 11: {
      let s = desc() + "directive @" + name() + inputValues() + (rnd(2) === 0 ? " repeatable" : "") + " on" + sp() + (rnd(2) === 0 ? "|" + sp() : "");
      const n = 1 + rnd(4);
      for (let i = 0; i < n; i++) s += (i > 0 ? sp() + "|" + sp() : "") + pick(locations);
      return s;
    }
    case 12: return "extend type " + typeName() + (rnd(2) === 0 ? " implements " + typeName() : "") + (rnd(2) === 0 ? " @a" : "") + (rnd(3) === 0 ? "" : fields(false) || " @b");
    case 13: return "extend " + pick(["scalar " + typeName() + " @a", "union " + typeName() + " = A | B", "enum " + typeName() + " { X }", "input " + typeName() + " { x: Int }", "interface " + typeName() + " @a", "schema @a", "schema { query: Q }", "directive @" + name() + " @a"]);
    case 14: return desc() + "type " + typeName() + fields(false);
    default: return "query " + name() + "($a: Int" + (rnd(2) === 0 ? " = 1" : "") + ") " + selection(0);
  }
}
function document(): string {
  if (process.env.PLAIN) { let t = ""; const k = 1 + rnd(5); for (let i = 0; i < k; i++) t += definition() + "\n\n"; return t; }
  let s = rnd(3) === 0 ? "# leading comment\n" + (rnd(2) === 0 ? "\n" : "") : "";
  const n = 1 + rnd(5);
  for (let i = 0; i < n; i++) {
    s += definition() + (i + 1 < n ? pick(["\n", "\n\n", "\n\n\n", " ", "\n# between\n", "\n\n# between\n\n", " # trailing\n"]) : "");
  }
  s += pick(["\n", "", "\n\n", " # end\n", "\n# end"]);
  if (rnd(10) === 0) s = s.replace(/\n/g, "\r\n");
  else if (rnd(25) === 0) s = s.replace(/\n/g, "\r");
  if (rnd(30) === 0) s = "﻿" + s;
  return s;
}

const outdir = process.argv[2];
const count = parseInt(process.argv[3]);
const parts = parseInt(process.argv[5] ?? "8");
for (let k = 0; k < parts; k++) fs.mkdirSync(outdir + "/p" + k, { recursive: true });
for (let i = 0; i < count; i++) fs.writeFileSync(outdir + "/p" + (i % parts) + "/g" + i + ".graphql", document());
