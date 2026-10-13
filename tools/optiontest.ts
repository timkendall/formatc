// Checks how the driver resolves the options of a file against Bun, by what Bun does with them: a probe program is
// formatted by `bun fmt --stdin-filepath <file>` and the options it was formatted with are read off the result; the same
// options are read off `bin/fmt --dump-options` (the resolved options of the file, ours) and the two are compared.
//
//   node tools/optiontest.ts            # all scenarios
//   node tools/optiontest.ts -v name    # show the options of the scenarios whose name contains `name`
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const bun = process.env.HOME + "/.bun/bin/bun";
const ours = process.env.OURS || path.join(root, "bin/fmt");

function line(width: number, name: string): string {
  const prefix = `const ${name} = someFunction(argumentNumberOne, `;
  const pad = width - prefix.length - 2;
  return prefix + "x".repeat(pad) + ");";
}

const widths = [80, 81, 100, 101, 120, 121];
// `quoteProps: preserve` / `consistent` and `singleQuote` change what the probe of the property looks like: not told apart by it
const probe =
  `const config = { a: 1, "b-c": 2 };
const quoted = { "b": 1 };
const fn = x => x;
function f() {
  if (x) {
    y("q");
  }
}
` + widths.map((w) => line(w, "r" + w)).join("\n") + "\n";

interface Opts {
  semi: boolean;
  singleQuote: boolean;
  indent: string;
  width: string;
  trailing: string;
  bracketSpacing: boolean;
  arrowParens: boolean;
  quoteProps: boolean;
  eol: string;
}

function fromOutput(out: string): string {
  const lines = out.split(/\r?\n/);
  const find = (re: RegExp): string => lines.find((l) => re.test(l)) ?? "";
  const yline = find(/y\(/);
  const indent = /^(\s*)/.exec(yline)![1];
  const fits: string[] = [];
  for (const w of widths) {
    const wrapped = out.includes(`const r${w} = someFunction(\r\n`) || out.includes(`const r${w} = someFunction(\n`);
    fits.push(wrapped ? "w" : "f");
  }
  // the width: the longest printed line (a line without `;` is one shorter) that fits
  const semiOn = /y\([^)]*\);/.test(yline);
  let width = "<80";
  for (let i = 0; i < widths.length; i++) if (fits[i] === "f") width = String(widths[i] - (semiOn ? 0 : 1));
  const wrapLine = out.split("\n").findIndex((l) => /someFunction\($/.test(l.replace(/\r$/, "")));
  let trailing = "n/a";
  if (wrapLine >= 0) {
    const l = out.split("\n");
    let i = wrapLine + 1;
    while (i < l.length && !/^\)/.test(l[i])) i++;
    const last = l[i - 1].replace(/\r$/, "");
    trailing = last.endsWith(",") ? "comma" : "none";
  }
  const o: Opts = {
    semi: /y\([^)]*\);/.test(yline),
    singleQuote: /y\('q'\)/.test(yline),
    indent: indent.includes("\t") ? "tab" : String(indent.length / 2),
    width,
    trailing,
    bracketSpacing: /\{ /.test(find(/const config/)),
    arrowParens: /\(x\) =>/.test(find(/const fn/)),
    quoteProps: /\{ ?["']b["']/.test(find(/const quoted/)),
    eol: out.includes("\r\n") ? "crlf" : "lf",
  };
  return JSON.stringify(o);
}

function fromDump(settings: string): string {
  // settings: "name=value name=value ..." (after the path), applied in order
  const m = new Map<string, string>();
  const parts = settings.split(" ").filter((p) => p.includes("="));
  for (const p of parts) {
    const i = p.indexOf("=");
    m.set(p.slice(0, i), p.slice(i + 1));
  }
  const bool = (k: string, d: boolean): boolean => (m.has(k) ? m.get(k) === "true" : d);
  const semi = bool("semi", true);
  const useTabs = bool("useTabs", false);
  const tabWidth = Number(m.get("tabWidth") ?? "2");
  const printWidth = Number(m.get("printWidth") ?? (m.get("flavor") === "oxfmt" ? "100" : "80"));
  const trailingComma = m.get("trailingComma") ?? "all";
  let width = "<80";
  for (const w of widths) if (w - (semi ? 0 : 1) <= printWidth) width = String(w - (semi ? 0 : 1));
  // lines of exactly `w` characters fit when w <= printWidth
  const o: Opts = {
    semi,
    singleQuote: bool("singleQuote", false),
    indent: useTabs ? "tab" : String(tabWidth),
    width,
    trailing: width === String(widths[widths.length - 1] - (semi ? 0 : 1)) ? "n/a" : trailingComma === "all" ? "comma" : "none",
    bracketSpacing: bool("bracketSpacing", true),
    arrowParens: (m.get("arrowParens") ?? "always") === "always",
    quoteProps: (m.get("quoteProps") ?? "as-needed") === "preserve",
    eol: (m.get("endOfLine") ?? "lf") === "crlf" ? "crlf" : "lf",
  };
  return JSON.stringify(o);
}

interface Scenario {
  name: string;
  files: Record<string, string>;
  flags: string[];
  targets: string[];
}
const scenarios: Scenario[] = [];
function s(name: string, files: Record<string, string>, targets: string[], flags: string[] = []): void {
  scenarios.push({ name, files, flags, targets });
}

const T = ["a.js", "b.ts", "src/c.tsx", "src/deep/d.js", "e.cjs", "package.json"];
s("defaults", {}, T);
s("editorconfig tab", { ".editorconfig": "root = true\n[*]\nindent_style = tab\n" }, T);
s("editorconfig space size", { ".editorconfig": "root = true\n[*]\nindent_style = space\nindent_size = 4\n" }, T);
s("editorconfig tab_width", { ".editorconfig": "root = true\n[*]\nindent_style = tab\ntab_width = 8\n" }, T);
s("editorconfig size tab", { ".editorconfig": "root = true\n[*]\nindent_size = tab\ntab_width = 3\n" }, T);
s("editorconfig sections", { ".editorconfig": "root = true\n[*]\nindent_style = tab\n[*.ts]\nindent_style = space\nindent_size = 3\n[src/**]\nmax_line_length = 100\n" }, T);
s("editorconfig vscode", { ".editorconfig": "root = true\n[*]\nindent_style = tab\ntrim_trailing_whitespace = true\n[{*.yml,*.yaml,package.json}]\nindent_style = space\nindent_size = 2\n" }, T);
s("editorconfig max_line_length", { ".editorconfig": "[*]\nmax_line_length = 100\nend_of_line = crlf\nquote_type = single\n" }, T);
s("editorconfig off", { ".editorconfig": "[*]\nmax_line_length = off\n" }, T);
s("editorconfig nested", { ".editorconfig": "[*]\nindent_style = tab\n", "src/.editorconfig": "[*.tsx]\nindent_style = space\nindent_size = 8\n" }, T);
s("editorconfig root nested", { ".editorconfig": "[*]\nindent_style = tab\n", "src/.editorconfig": "root = true\n[*.tsx]\nindent_size = 8\n" }, T);
s("editorconfig braces", { ".editorconfig": "[{a,b}.{js,ts}]\nindent_style = tab\n" }, T);
s("editorconfig globstar", { ".editorconfig": "[src/**.js]\nindent_size = 4\nindent_style = space\n" }, T);
s("editorconfig abs section", { ".editorconfig": "[/src/*.tsx]\nindent_size = 4\nindent_style = space\n" }, T);
s("editorconfig quoted", { ".editorconfig": '[*]\nindent_size = "4"\nindent_style = space\n' }, T);
s("editorconfig ignored by flag", { ".editorconfig": "[*]\nindent_style = tab\n" }, T, ["--no-editorconfig"]);
s("prettierrc json", { ".prettierrc.json": '{ "semi": false, "singleQuote": true, "tabWidth": 4 }\n' }, T);
s("prettierrc yaml", { ".prettierrc": "semi: false\nsingleQuote: true\ntabWidth: 4\n" }, T);
s("prettierrc yaml overrides", { ".prettierrc.yaml": 'semi: false\noverrides:\n  - files: "*.ts"\n    options:\n      semi: true\n      tabWidth: 8\n  - files:\n      - "src/**/*.js"\n    options:\n      useTabs: true\n' }, T);
s("prettierrc yml flow", { ".prettierrc.yml": "{ semi: false, tabWidth: 6 }\n" }, T);
s("prettierrc toml", { ".prettierrc.toml": 'semi = false\ntabWidth = 3\n[[overrides]]\nfiles = "*.ts"\n[overrides.options]\nsingleQuote = true\n' }, T);
s("prettierrc json5", { ".prettierrc.json5": "{ semi: false, // c\n singleQuote: true, }\n" }, T);
s("prettierrc js", { ".prettierrc.js": "module.exports = {\n  semi: false,\n  tabWidth: 8,\n};\n" }, T);
s("prettierrc mjs", { "prettier.config.mjs": "export default {\n  semi: false,\n  printWidth: 100,\n};\n" }, T);
s("prettierrc js const", { "prettier.config.js": "/** @type {import('prettier').Config} */\nconst config = {\n  semi: false,\n  singleQuote: true,\n};\n\nexport default config;\n" }, T);
s("package.json key", { "package.json": '{ "name": "x", "prettier": { "semi": false, "tabWidth": 5 } }\n' }, T);
s("package.json without key", { "package.json": '{ "name": "x" }\n', ".prettierrc.json": '{ "semi": false }\n' }, T);
s("overrides glob", { ".prettierrc.json": '{ "overrides": [{ "files": "*.ts", "options": { "semi": false } }, { "files": ["src/**/*.js", "*.tsx"], "excludeFiles": "src/deep/*", "options": { "tabWidth": 8 } }] }\n' }, T);
s("overrides with slash basename", { ".prettierrc.json": '{ "overrides": [{ "files": "src/*.tsx", "options": { "semi": false } }, { "files": "deep/*.js", "options": { "tabWidth": 8 } }] }\n' }, T);
s("overrides braces", { ".prettierrc.json": '{ "overrides": [{ "files": "*.{js,ts}", "options": { "singleQuote": true } }] }\n' }, T);
s("overrides extglob", { ".prettierrc.json": '{ "overrides": [{ "files": "*.@(js|cjs)", "options": { "singleQuote": true } }] }\n' }, T);
s("overrides parser", { ".prettierrc.json": '{ "overrides": [{ "files": "*.cjs", "options": { "semi": false } }] }\n' }, T);
s("nested prettierrc", { ".prettierrc.json": '{ "semi": false }\n', "src/.prettierrc.json": '{ "tabWidth": 8 }\n' }, T);
s("nested prettierrc + editorconfig", { ".editorconfig": "[*]\nindent_style = tab\n", "src/.prettierrc.json": '{ "tabWidth": 8, "useTabs": false }\n' }, T);
s("editorconfig vs prettierrc", { ".editorconfig": "[*]\nindent_style = tab\nindent_size = 8\n", ".prettierrc.json": '{ "tabWidth": 3 }\n' }, T);
s("flags", {}, T, ["--no-semi", "--single-quote", "--print-width=100", "--tab-width=4", "--use-tabs", "--trailing-comma=none", "--no-bracket-spacing", "--arrow-parens=avoid", "--quote-props=preserve", "--end-of-line=crlf"]);
s("flags over config", { ".prettierrc.json": '{ "semi": true, "tabWidth": 8 }\n' }, T, ["--no-semi"]);
s("flags file-override", { ".prettierrc.json": '{ "semi": true, "tabWidth": 8 }\n' }, T, ["--no-semi", "--config-precedence=file-override"]);
s("flags prefer-file", { ".prettierrc.json": '{ "semi": true }\n' }, T, ["--no-semi", "--tab-width=3", "--config-precedence=prefer-file"]);
s("flags prefer-file no config", {}, T, ["--no-semi", "--tab-width=3", "--config-precedence=prefer-file"]);
s("flags with editorconfig", { ".editorconfig": "[*]\nindent_style = tab\n" }, T, ["--use-tabs=false"]);
s("bunfig", { "bunfig.toml": "[fmt]\nsemi = false\nprintWidth = 120\nsingleQuote = true\n" }, T);
s("bunfig + flag", { "bunfig.toml": "[fmt]\nsemi = false\nprintWidth = 120\n" }, T, ["--print-width=100"]);
s("bunfig overrides", { "bunfig.toml": '[fmt]\nsemi = false\n[[fmt.overrides]]\nfiles = "*.ts"\n[fmt.overrides.options]\nsemi = true\nprintWidth = 100\n' }, T);
s("bunfig overrides glob", { "bunfig.toml": '[[fmt.overrides]]\nfiles = ["src/**/*.js", "*.tsx"]\nexcludeFiles = "src/deep/*"\n[fmt.overrides.options]\ntabWidth = 8\n' }, T);
s("bunfig overrides noslash", { "bunfig.toml": '[[fmt.overrides]]\nfiles = "*.js"\n[fmt.overrides.options]\ntabWidth = 8\n' }, T);
s("bunfig overrides flags", { "bunfig.toml": '[[fmt.overrides]]\nfiles = "*.js"\n[fmt.overrides.options]\ntabWidth = 8\nsemi = false\n' }, T, ["--no-semi"]);
s("bunfig editorconfig false", { "bunfig.toml": "[fmt]\neditorconfig = false\n", ".editorconfig": "[*]\nindent_style = tab\n" }, T);
s("bunfig + prettierrc", { "bunfig.toml": "[fmt]\nsemi = false\n", ".prettierrc.json": '{ "tabWidth": 8 }\n' }, T);
s("config flag", { "my.json": '{ "semi": false }\n' }, T, ["--config", "my.json"]);
s("config flag yaml", { "my": "semi: false\n" }, T, ["--config", "my"]);
s("no-config", { ".prettierrc.json": '{ "semi": false }\n', ".editorconfig": "[*]\nindent_style = tab\n" }, T, ["--no-config"]);
s("shebang", { "bin/tool": "#!/usr/bin/env node\n" }, ["bin/tool"]);
s("insertFinalNewline flag", {}, T, ["--no-insert-final-newline"]);
s("unknown option", { ".prettierrc.json": '{ "foo": 1 }\n' }, T);


s("yaml comments", { ".prettierrc": "# comment\nsemi: false # trailing\n\n# another\nsingleQuote: true\n" }, T);
s("yaml quoted", { ".prettierrc.yaml": '"semi": false\n\'tabWidth\': 4\ntrailingComma: "none"\n' }, T);
s("yaml flow overrides", { ".prettierrc.yaml": 'overrides:\n  - files: ["*.ts", "*.tsx"]\n    options: { semi: false, tabWidth: 8 }\n' }, T);
s("yaml doc start", { ".prettierrc.yml": "---\nsemi: false\n" }, T);
s("yaml string values", { ".prettierrc": "trailingComma: es5\narrowParens: avoid\nendOfLine: lf\nquoteProps: consistent\n" }, T);
s("yaml json inside", { ".prettierrc": '{ "semi": false, "tabWidth": 4 }\n' }, T);
s("yaml number string", { ".prettierrc": 'tabWidth: "4"\n' }, T);
s("yaml null", { ".prettierrc": "semi:\nsingleQuote: true\n" }, T);
s("yaml infinity", { ".prettierrc": "printWidth: .inf\n" }, T);
s("yaml overrides nested seq", { ".prettierrc": "overrides:\n- files:\n  - '*.ts'\n  options:\n    semi: false\n" }, T);
s("json5 comments", { ".prettierrc.json5": "// c\n{\n  /* x */ semi: false,\n  'singleQuote': true,\n  tabWidth: 0x4,\n}\n" }, T);
s("jsonc in .json", { ".prettierrc.json": '{\n  // c\n  "semi": false,\n}\n' }, T);
s("toml nested", { ".prettierrc.toml": 'semi = false\n\n[[overrides]]\nfiles = ["*.ts"]\n\n[overrides.options]\nsemi = true\ntabWidth = 8\n' }, T);
s("toml inline", { ".prettierrc.toml": 'overrides = [{ files = "*.ts", options = { semi = false } }]\n' }, T);
s("package.yaml", { "package.yaml": "prettier:\n  semi: false\n" }, T);
s("js export default", { "prettier.config.js": "export default {\n  semi: false,\n  overrides: [{ files: '*.ts', options: { semi: true } }],\n};\n" }, T);
s("js with comment", { "prettier.config.cjs": "// @ts-check\n\n/** @type {import('prettier').Config} */\nmodule.exports = {\n  // no semis\n  semi: false,\n};\n" }, T);
s("ts config", { "prettier.config.ts": "import { type Config } from 'prettier';\n\nconst config: Config = {\n  semi: false,\n  singleQuote: true,\n};\n\nexport default config;\n" }, T);
s("editorconfig crlf", { ".editorconfig": "root = true\r\n[*]\r\nindent_style = tab\r\n" }, T);
s("editorconfig indent_size tab", { ".editorconfig": "[*]\nindent_style = tab\nindent_size = tab\ntab_width = 4\n" }, T);
s("editorconfig unset", { ".editorconfig": "[*]\nindent_style = tab\n[*.ts]\nindent_style = unset\n" }, T);
s("editorconfig case", { ".editorconfig": "[*]\nINDENT_STYLE = TAB\nIndent_Size = 4\n" }, T);
s("editorconfig comment", { ".editorconfig": "[*] ; comment\nindent_style = tab ; c\n" }, T);
s("editorconfig quote_type", { ".editorconfig": "[*]\nquote_type = double\n" }, T, ["--single-quote"]);
s("editorconfig eol", { ".editorconfig": "[*]\nend_of_line = crlf\n[*.ts]\nend_of_line = lf\n" }, T);
s("editorconfig bad line", { ".editorconfig": "[*]\nthis is not valid\nindent_style = tab\n" }, T);
s("editorconfig bad section", { ".editorconfig": "[*\nindent_style = tab\n" }, T);


// ---- oxfmt ----
const OX = { ".oxfmtrc.json": "{}\n" };
s("ox defaults", OX, T);
s("ox options", { ".oxfmtrc.json": '{ "semi": false, "singleQuote": true, "printWidth": 120, "tabWidth": 4 }\n' }, T);
s("ox jsonc", { ".oxfmtrc.jsonc": '{\n  // c\n  "semi": false,\n}\n' }, T);
s("ox editorconfig", { ...OX, ".editorconfig": "root = true\n[*]\nindent_style = tab\n" }, T);
s("ox editorconfig size", { ...OX, ".editorconfig": "[*]\nindent_style = space\nindent_size = 4\nmax_line_length = 120\nquote_type = single\n" }, T);
s("ox editorconfig sections", { ...OX, ".editorconfig": "[*]\nindent_style = space\nindent_size = 2\n[*.ts]\nindent_size = 4\n[src/**/*.js]\nindent_size = 8\n" }, T);
s("ox editorconfig tab_width", { ...OX, ".editorconfig": "[*]\nindent_style = space\ntab_width = 6\n" }, T);
s("ox editorconfig unset", { ...OX, ".editorconfig": "[*]\nindent_style = space\nindent_size = unset\n[*.ts]\nindent_size = 4\n" }, T);
s("ox editorconfig vs oxfmtrc", { ".oxfmtrc.json": '{ "useTabs": false, "tabWidth": 2 }\n', ".editorconfig": "[*]\nindent_style = tab\nindent_size = 8\n" }, T);
s("ox editorconfig partial", { ".oxfmtrc.json": '{ "tabWidth": 8 }\n', ".editorconfig": "[*]\nindent_style = tab\n" }, T);
s("ox editorconfig nested file", { ...OX, ".editorconfig": "[*]\nindent_style = tab\n", "src/.editorconfig": "[*]\nindent_style = space\nindent_size = 8\n" }, T);
s("ox editorconfig case", { ...OX, ".editorconfig": "[*]\nindent_style = TAB\n" }, T);
s("ox editorconfig braces", { ...OX, ".editorconfig": "[{a,b}.{js,ts}]\nindent_style = tab\n" }, T);
s("ox editorconfig star", { ...OX, ".editorconfig": "[**.js]\nindent_style = tab\n[src/**]\nindent_size = 3\nindent_style = space\n" }, T);
s("ox editorconfig bad width", { ...OX, ".editorconfig": "[*]\nmax_line_length = 1000\n" }, T);
s("ox editorconfig off", { ...OX, ".editorconfig": "[*]\nmax_line_length = off\n" }, T);
s("ox overrides", { ".oxfmtrc.json": '{ "overrides": [{ "files": ["*.ts"], "options": { "semi": false } }, { "files": ["src/**/*.js"], "excludeFiles": ["src/deep/**"], "options": { "tabWidth": 8 } }] }\n' }, T);
s("ox overrides noslash", { ".oxfmtrc.json": '{ "overrides": [{ "files": ["deep/*.js"], "options": { "semi": false } }, { "files": ["d.js"], "options": { "tabWidth": 8 } }] }\n' }, T);
s("ox overrides braces", { ".oxfmtrc.json": '{ "overrides": [{ "files": ["*.{js,ts}"], "options": { "singleQuote": true } }] }\n' }, T);
s("ox nested", { ".oxfmtrc.json": '{ "semi": false }\n', "src/.oxfmtrc.json": '{ "tabWidth": 8 }\n' }, T);
s("ox nested replaces", { ".oxfmtrc.json": '{ "semi": false, "singleQuote": true }\n', "src/.oxfmtrc.jsonc": '{ "tabWidth": 8 }\n' }, T);
s("ox config flag", { ...OX, "my.json": '{ "semi": false }\n' }, T, ["--config", "my.json"]);
s("ox -c", { ...OX, "my.json": '{ "semi": false }\n' }, T, ["-c", "my.json"]);
s("ox flags", OX, T, ["--no-semi", "--tab-width=3"]);
s("ox flags over config", { ".oxfmtrc.json": '{ "semi": true, "tabWidth": 8 }\n' }, T, ["--no-semi"]);
s("ox bunfig", { ...OX, "bunfig.toml": "[fmt]\nsemi = false\nprintWidth = 90\n" }, T);
s("ox null option", { ".oxfmtrc.json": '{ "semi": null, "tabWidth": 8 }\n' }, T);
s("ox string option", { ".oxfmtrc.json": '{ "tabWidth": "4" }\n' }, T);
s("ox bad width", { ".oxfmtrc.json": '{ "printWidth": 1000 }\n' }, T);
s("ox bad tab", { ".oxfmtrc.json": '{ "tabWidth": 100 }\n' }, T);
s("ox flavor flag", {}, T, ["--flavor=oxfmt"]);
s("ox flavor flag editorconfig", { ".editorconfig": "[*]\nindent_style = tab\n" }, T, ["--flavor=oxfmt"]);
s("ox deps", { "package.json": '{ "devDependencies": { "oxfmt": "^1" } }\n' }, T);
s("ox deps both", { "package.json": '{ "devDependencies": { "oxfmt": "^1", "prettier": "^3" } }\n' }, T);
s("ox deps prettier", { "package.json": '{ "devDependencies": { "prettier": "^3" } }\n' }, T);
s("ox deps with prettierrc", { "package.json": '{ "devDependencies": { "oxfmt": "^1" } }\n', ".prettierrc.json": '{ "semi": false }\n' }, T);
s("ox flavor prettier flag", { ...OX }, T, ["--flavor=prettier"]);
s("mixed nested oxfmt", { ".prettierrc.json": '{ "semi": false }\n', "src/.oxfmtrc.json": '{ "tabWidth": 8 }\n' }, T);
s("ox both configs", { ".oxfmtrc.json": "{}\n", ".oxfmtrc.jsonc": "{}\n" }, T);
s("ox and prettierrc", { ".oxfmtrc.json": '{ "semi": false }\n', ".prettierrc.json": '{ "tabWidth": 8 }\n' }, T);
s("ox insertFinalNewline", { ".oxfmtrc.json": '{ "insertFinalNewline": false }\n' }, T);
s("ox jsdoc", { ".oxfmtrc.json": '{ "jsdoc": { "capitalizeDescriptions": false } }\n' }, T);
s("ox sortImports", { ".oxfmtrc.json": '{ "sortImports": { "order": "desc" } }\n' }, T);

const verbose = process.argv.includes("-v");
const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"))[0];
let pass = 0;
let fail = 0;
const failed: string[] = [];
for (const sc of scenarios) {
  if (filter !== undefined && !sc.name.includes(filter)) continue;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opt-")));
  for (const [name, content] of Object.entries(sc.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  for (const t of sc.targets) {
    fs.mkdirSync(path.dirname(path.join(dir, t)), { recursive: true });
    if (!fs.existsSync(path.join(dir, t))) fs.writeFileSync(path.join(dir, t), "");
  }
  // ours: one run, the dump for every file
  const env = { ...process.env, NO_COLOR: "1" } as Record<string, string>;
  const mine = spawnSync(ours, ["--dump-options", ...sc.flags, ...sc.targets], { cwd: dir, encoding: "utf8", env });
  const dumped = new Map<string, string>();
  for (const l of mine.stdout.split("\n")) {
    const i = l.indexOf("\t");
    if (i > 0) dumped.set(l.slice(0, i), l.slice(i + 1));
  }
  for (const t of sc.targets) {
    const b = spawnSync(bun, ["fmt", "--stdin-filepath", t, ...sc.flags], { cwd: dir, input: probe, encoding: "utf8", env });
    // package.json is formatted as JSON: no probe; compare only for scripts
    if (t.endsWith(".json") || t.endsWith("/tool")) continue;
    const expect = b.status === 0 ? fromOutput(b.stdout) : "bun failed: " + b.stderr.trim().split("\n")[0];
    const d = dumped.get(t);
    const got = d === undefined ? (mine.stderr.startsWith("error: ") ? "bun failed: " + mine.stderr.trim().split("\n")[0] : "missing: " + mine.stdout.slice(0, 100) + mine.stderr.slice(0, 300)) : d.startsWith("ERROR ") ? "bun failed: error: " + d.slice(6) : fromDump(d);
    const same = expect === got;
    if (same) pass++;
    else {
      fail++;
      failed.push(sc.name + ":" + t);
    }
    if (!same || verbose) {
      console.log((same ? "ok   " : "FAIL ") + sc.name + " " + t + "  flags=" + sc.flags.join(" "));
      if (!same || verbose) {
        console.log("  bun : " + expect);
        console.log("  ours: " + got + (d === undefined ? "" : "   <- " + d));
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
if (failed.length > 0) console.log("failed: " + failed.join(" | "));
