// Differential test of the driver against Bun: runs scenarios (a tree of files, arguments, standard input) through
// `~/.bun/bin/bun fmt` and `bin/fmt` and compares standard output, standard error and the exit code.
// The formatters are stubs in our binary, so scenarios use files that are already formatted (or `--list-files`).
//
//   node tools/difftest.ts            # all scenarios
//   node tools/difftest.ts -v name    # show the outputs of the scenarios whose name contains `name`
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const bun = process.env.HOME + "/.bun/bin/bun";
const ours = process.env.OURS || path.join(root, "bin/fmt");

interface Scenario {
  name: string;
  files: Record<string, string>;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string; // relative to the root of the tree
  git?: string[]; // shell commands run in the tree before the test
  links?: string[][]; // symlinks [target, name]
}

const ok = "a = 1;\n";
const okJson = "{}\n";
const ugly = "if (a) {\nb( 1 )\n}\n";

const scenarios: Scenario[] = [];
function s(name: string, files: Record<string, string>, args: string[], extra: Partial<Scenario> = {}): void {
  scenarios.push({ name, files, args, ...extra });
}

const tree = {
  "a.js": ok,
  "a.cjs": ok,
  "a.ts": ok,
  "src/a.js": ok,
  "src/b.ts": ok,
  "src/x/d.js": ok,
  "src/x/e.tsx": ok,
  "lib/f.js": ok,
  "lib/deep/g.js": ok,
  "lib/deep/h.min.js": ok,
  "sub/i.js": ok,
  "README.md": "# hi\n",
  "data.json": okJson,
  "style.css": "a {\n  color: red;\n}\n",
  "notes.txt": "x",
  "node_modules/m/index.js": ok,
  ".git/config": "x",
  ".hidden/h.js": ok,
  "Makefile": "all:\n",
  "bin/tool": "#!/usr/bin/env node\na = 1;\n",
  "bin/sh": "#!/bin/sh\necho\n",
  "package-lock.json": okJson,
  "yarn.lock": "x",
  "Cargo.toml": "[a]\nb = 1\n",
};

s("list-files default", tree, ["--list-files"]);
s("list-files dir arg", tree, ["--list-files", "src"]);
s("list-files file arg", tree, ["--list-files", "src/a.js", "a.ts"]);
s("list-files lock named", tree, ["--list-files", "package-lock.json", "a.js"]);
s("list-files glob", tree, ["--list-files", "src/**/*.js"]);
s("list-files glob star", tree, ["--list-files", "*.js"]);
s("list-files glob braces", tree, ["--list-files", "{a,src/x/*}.?(c)js"]);
s("list-files glob ext", tree, ["--list-files", "src/**/*.@(js|ts)"]);
s("list-files glob neg", tree, ["--list-files", "**/*.js", "!lib/**"]);
s("list-files glob dir", tree, ["--list-files", "lib/*/**"]);
s("list-files with-node-modules", tree, ["--list-files", "--with-node-modules"]);
s("list-files node_modules explicit", tree, ["--list-files", "node_modules"]);
s("list-files dotted", tree, ["--list-files", ".hidden"]);
s("list-files missing", tree, ["--list-files", "nope"]);
s("list-files missing glob", tree, ["--list-files", "zzz/**/*.js"]);
s("list-files no-error-on-unmatched", tree, ["--list-files", "--no-error-on-unmatched-pattern", "nope"]);
s("list-files ./ prefix", tree, ["--list-files", "./src"]);
s("list-files dotdot", tree, ["--list-files", "../x"], { cwd: "src" });
s("list-files in subdir", tree, ["--list-files"], { cwd: "src" });
s("list-files abs", tree, ["--list-files", "<DIR>/src"]);
s("list-files unknown ext named", tree, ["--list-files", "notes.txt"]);
s("list-files cwd flag", tree, ["--list-files", "--cwd", "src"]);
s("list-files dup", tree, ["--list-files", "src", "src/a.js", "src"]);

s("gitignore", { ...tree, ".gitignore": "lib/\n*.cjs\n" }, ["--list-files"]);
s("gitignore negate", { ...tree, ".gitignore": "*.js\n!src/a.js\n" }, ["--list-files"]);
s("gitignore anchored", { ...tree, ".gitignore": "/a.js\nsub\n" }, ["--list-files"]);
s("gitignore nested not read", { ...tree, "src/.gitignore": "*.js\n" }, ["--list-files"]);
s("prettierignore", { ...tree, ".prettierignore": "src\n*.ts\n" }, ["--list-files"]);
s("prettierignore explicit file", { ...tree, ".prettierignore": "src\n" }, ["--list-files", "src/a.js", "a.js"]);
s("prettierignore explicit dir", { ...tree, ".prettierignore": "src\n" }, ["--list-files", "src"]);
s("ignore-path", { ...tree, "my.ignore": "lib\n" }, ["--list-files", "--ignore-path", "my.ignore"]);
s("ignore-path missing", tree, ["--list-files", "--ignore-path", "nothere"]);
s("ignore-pattern", tree, ["--list-files", "--ignore-pattern", "src", "--ignore-pattern", "*.cjs"]);
s("ignore double star", { ...tree, ".gitignore": "**/x\n" }, ["--list-files"]);
s("ignore doublestar slash", { ...tree, ".gitignore": "lib/**/\n" }, ["--list-files"]);
s("ignore char class", { ...tree, ".gitignore": "[ab].js\n" }, ["--list-files"]);
s("ignore question", { ...tree, ".gitignore": "?.js\n" }, ["--list-files"]);
s("ignore crlf", { ...tree, ".gitignore": "lib\r\nsub\r\n" }, ["--list-files"]);
s("ignore comment", { ...tree, ".gitignore": "# lib\n\\#x\nsub # not comment\n" }, ["--list-files"]);
s("ignore case", { ...tree, ".gitignore": "A.JS\nLIB/\n" }, ["--list-files"]);
s("ignore trailing slash space", { ...tree, ".gitignore": "lib/ \n" }, ["--list-files"]);
s("ignore with slash middle", { ...tree, ".gitignore": "src/x\n" }, ["--list-files"]);
s("ignore deep glob", { ...tree, ".gitignore": "lib/**/g.js\n" }, ["--list-files"]);
s("ignore ext deep", { ...tree, ".gitignore": "*.min.js\n" }, ["--list-files"]);

s("prettierrc json", { ...tree, ".prettierrc.json": "{}\n" }, ["--list-files"]);
s("min.js with config", { ...tree, ".prettierrc.json": "{}\n" }, ["--list-files"]);
s("lock with config", { ...tree, ".prettierrc": "semi: false\n" }, ["--list-files"]);
s("toml with config", { ...tree, ".prettierrc": "{}\n" }, ["--list-files"]);
s("toml native", tree, ["--list-files", "Cargo.toml"]);

s("version", {}, ["--version"]);
s("help", {}, ["--help"]);
s("help all", {}, ["--help", "--all"]);
s("help-all", {}, ["--help-all"]);
s("bogus flag", {}, ["--bogus"]);
s("bogus short", {}, ["-z"]);
s("threads zero", {}, ["--threads=0"]);
s("print-width missing", {}, ["--print-width"]);
s("log-level bad", {}, ["--log-level=bad"]);
s("no-prefix on value", {}, ["--no-print-width"]);
s("check list-different", {}, ["--check", "--list-different"]);
s("all without help", {}, ["--all"]);
s("config no-config", {}, ["--config", "x", "--no-config"]);
s("staged stdin", {}, ["--staged", "--stdin-filepath", "a.js"]);
s("flavor bad", {}, ["--flavor=x"]);
s("short group", {}, ["-cl"]);
s("short group arg", {}, ["-cf"]);
s("-NUM", {}, ["-12"]);
s("bool value", {}, ["--check=maybe"]);
s("bool value false", { "a.js": ok }, ["--check=false", "--list-files"]);
s("double dash", { "a.js": ok, "-b.js": ok }, ["--list-files", "--", "-b.js"]);
s("format flag", { "a.js": ok }, ["--format=xml"]);
s("cwd missing", {}, ["--cwd", "/nonexistent-dir-xyz"]);
s("cwd missing value", {}, ["--cwd"]);

s("check formatted", { "a.js": ok, "b.json": okJson, "c.css": "a {\n  color: red;\n}\n" }, ["--check"]);
s("check one file", { "a.js": ok }, ["--check"]);
s("check list-different", { "a.js": ok }, ["-l"]);
s("check empty dir", {}, ["--check"]);
s("check empty dir write", {}, []);
s("check unknown ext", { "a.txt": "x" }, ["--check"]);
s("check unknown ext named", { "a.txt": "x" }, ["--check", "a.txt"]);
s("check ignore-unknown", { "a.txt": "x" }, ["--check", "-u", "a.txt"]);
s("check missing file", { "a.js": ok }, ["--check", "nope.js"]);
s("write formatted", { "a.js": ok, "b.js": ok }, []);
s("check log-level", { "a.js": ok }, ["--check", "--log-level=silent"]);
s("check log-level error", { "a.js": ok }, ["--check", "--log-level=error"]);
s("check svelte", { "a.js": ok, "b.svelte": "<a/>" }, ["--check"]);
s("check svelte allow", { "a.js": ok, "b.svelte": "<a/>" }, ["--check", "--allow-unsupported"]);
s("check svelte+astro", { "a.js": ok, "b.svelte": "<a/>", "c.svelte": "x", "d.astro": "x" }, ["--check"]);
s("check prettierrc missing plugin", { "a.js": ok, ".prettierrc": '{ "plugins": ["prettier-plugin-foo"] }\n' }, ["--check"]);
s("check prettierrc svelte plugin", { "a.js": ok, "b.svelte": "x", ".prettierrc": '{ "plugins": ["prettier-plugin-svelte"] }\n' }, ["--check"]);
s("check with prettierrc", { "a.js": ok, ".prettierrc.json": "{}\n" }, ["--check"]);
s("check with prettierrc list", { "a.js": ok, ".prettierrc.json": "{}\n" }, ["-l"]);
s("write with prettierrc", { "a.js": ok, ".prettierrc.json": "{}\n" }, []);
s("prettierrc bad json", { "a.js": ok, ".prettierrc.json": "{" }, ["--check"]);
s("prettierrc bad value", { "a.js": ok, ".prettierrc.json": '{ "printWidth": "x" }\n' }, ["--check"]);
s("prettierrc bad option", { "a.js": ok, ".prettierrc.json": '{ "semi": "x" }\n' }, ["--check"]);
s("prettierrc unknown option", { "a.js": ok, ".prettierrc.json": '{ "foo": 1 }\n' }, ["--check"]);
s("prettierrc unknown option arr", { "a.js": ok, ".prettierrc.json": '{ "foo": [1, "a"], "bar": { "a": 1 } }\n' }, ["--check"]);
s("prettierrc scalar", { "a.js": ok, ".prettierrc.json": "3" }, ["--check"]);
s("prettierrc plugins non-array", { "a.js": ok, ".prettierrc.json": '{ "plugins": 1 }\n' }, ["--check"]);
s("prettierrc overrides bad", { "a.js": ok, ".prettierrc.json": '{ "overrides": 1 }\n' }, ["--check"]);
s("prettierrc both", { "a.js": ok, ".prettierrc.json": "{}\n", ".prettierrc.yaml": "{}\n" }, ["--check"]);
s("prettierrc yaml", { "a.js": ok, ".prettierrc": "semi: false\ntabWidth: 4\n" }, ["--check"]);
s("prettierrc yaml bad", { "a.js": ok, ".prettierrc": "a: [\n" }, ["--check"]);
s("prettierrc toml", { "a.js": ok, ".prettierrc.toml": "semi = false\n" }, ["--check"]);
s("prettierrc js", { "a.js": ok, ".prettierrc.js": "module.exports = {};\n" }, ["--check"]);
s("package.json prettier", { "a.js": ok, "package.json": '{ "prettier": { "semi": false } }\n' }, ["--check"]);
s("package.json no prettier", { "a.js": ok, "package.json": "{}\n" }, ["--check"]);
s("package.json prettier string", { "a.js": ok, "package.json": '{ "prettier": "@x/y" }\n' }, ["--check"]);
s("nested configs", { "a.js": ok, "sub/b.js": ok, "sub/.prettierrc.json": "{}\n" }, ["--check"]);
s("config flag", { "a.js": ok, "my.json": "{}\n" }, ["--check", "--config", "my.json"]);
s("config flag missing", { "a.js": ok }, ["--check", "--config", "nope.json"]);
s("find-config-path", { "a.js": ok, ".prettierrc.json": "{}\n" }, ["--find-config-path", "a.js"]);
s("find-config-path none", { "a.js": ok }, ["--find-config-path", "a.js"]);
s("no-config", { "a.js": ok, ".prettierrc.json": "{" }, ["--check", "--no-config"]);
s("editorconfig fine", { "a.js": ok, ".editorconfig": "root = true\n[*]\nindent_style = tab\n" }, ["--check"]);
s("print-width flag bad", { "a.js": ok }, ["--check", "--print-width=1.5"]);
s("tab-width flag bad", { "a.js": ok }, ["--check", "--tab-width=x"]);
s("trailing-comma flag bad", { "a.js": ok }, ["--check", "--trailing-comma=x"]);
s("parser flag", { "a.js": ok }, ["--check", "--parser=json", "a.js"]);
s("parser flag bad", { "a.js": ok }, ["--check", "--parser=nope", "a.js"]);
s("parser flag dir", { "a.js": ok }, ["--check", "--parser=babel", "."]);

s("stdin ok", {}, ["--stdin-filepath", "a.js"], { stdin: ok });
s("stdin json", {}, ["--stdin-filepath", "a.json"], { stdin: okJson });
s("stdin check ok", {}, ["--check", "--stdin-filepath", "a.js"], { stdin: ok });
s("stdin ignored", { ".prettierignore": "a.js\n" }, ["--stdin-filepath", "a.js"], { stdin: ugly });
s("stdin node_modules", {}, ["--stdin-filepath", "node_modules/x/a.js"], { stdin: ugly });
s("stdin unknown", {}, ["--stdin-filepath", "a.zzz"], { stdin: "x" });
s("stdin unknown check", {}, ["--check", "--stdin-filepath", "a.zzz"], { stdin: "x" });
s("stdin unknown -u", {}, ["-u", "--stdin-filepath", "a.zzz"], { stdin: "x" });
s("stdin svelte", {}, ["--stdin-filepath", "a.svelte"], { stdin: "x" });
s("stdin svelte allow", {}, ["--allow-unsupported", "--stdin-filepath", "a.svelte"], { stdin: "x" });
s("stdin parser", {}, ["--parser=json"], { stdin: okJson });
s("stdin no parser", {}, ["--print-width=100"], { stdin: okJson });
s("stdin utf16", {}, ["--stdin-filepath", "a.css"], { stdin: "\xff\xfea" });

s("bunfig semi", { "a.js": ok, "bunfig.toml": "[fmt]\nsemi = false\n" }, ["--check"]);
s("bunfig unknown key", { "a.js": ok, "bunfig.toml": "[fmt]\nbogus = 1\n" }, ["--check"]);
s("bunfig bad type", { "a.js": ok, "bunfig.toml": "[fmt]\nsemi = 1\n" }, ["--check"]);
s("bunfig bad type str", { "a.js": ok, "bunfig.toml": '[fmt]\nprintWidth = "x"\n' }, ["--check"]);
s("bunfig action key", { "a.js": ok, "bunfig.toml": "[fmt]\ncheck = true\n" }, ["--check"]);
s("bunfig misspelled", { "a.js": ok, "bunfig.toml": "[fmt]\nprintWidht = 100\n" }, ["--check"]);
s("bunfig section format", { "a.js": ok, "bunfig.toml": "[format]\nsemi = false\n" }, ["--check"]);
s("bunfig overrides", { "a.js": ok, "bunfig.toml": '[fmt]\n[[fmt.overrides]]\nfiles = "*.js"\n[fmt.overrides.options]\nsemi = false\n' }, ["--check"]);
s("bunfig overrides no files", { "a.js": ok, "bunfig.toml": "[[fmt.overrides]]\n" }, ["--check"]);
s("bunfig overrides table", { "a.js": ok, "bunfig.toml": "[fmt.overrides]\nfiles = 1\n" }, ["--check"]);
s("bunfig ignorePatterns", { "a.js": ok, "b.js": ok, "bunfig.toml": '[fmt]\nignorePatterns = ["b.js"]\n' }, ["--list-files"]);
s("bunfig threads", { "a.js": ok, "bunfig.toml": "[fmt]\nthreads = 2\n" }, ["--check"]);
s("bunfig syntax error", { "a.js": ok, "bunfig.toml": "[fmt\nsemi = 1\n" }, ["--check"]);
s("bunfig no fmt", { "a.js": ok, "bunfig.toml": "[install]\nx = 1\n" }, ["--check"]);
s("bunfig config false", { "a.js": ok, ".prettierrc.json": "{", "bunfig.toml": "[fmt]\nconfig = false\n" }, ["--check"]);
s("init", { "a.js": ok }, ["--init"]);
s("init existing", { "bunfig.toml": "[fmt]\n" }, ["--init"]);
s("init with config", { ".prettierrc.json": "{}\n" }, ["--init"]);

s("dump unknown plugin", { "a.js": ok, ".prettierrc.json": '{ "plugins": ["prettier-plugin-foo"] }\n' }, ["--list-files"]);
s("overrides json", { "a.js": ok, "b.ts": ok, ".prettierrc.json": '{ "overrides": [{ "files": "*.ts", "options": { "semi": false } }] }\n' }, ["--check"]);
s("hidden files with config", { ".hidden/h.js": ok, ".prettierrc.json": "{}\n" }, ["--list-files"]);
s("symlink file", { "a.js": ok }, ["--list-files"]);


// ---- from vendor/bun/test/cli/format/glob.test.ts ----
const gnames = ["a.js", "a.cjs", "a.mjs", "a.ts", "src/a.js", "src/b.ts", "src/x/d.js", "src/x/e.tsx", "lib/f.js", "lib/deep/g.js", "lib/deep/h.min.js", "sub/i.js"];
const gfiles: Record<string, string> = { ".prettierrc.json": "{}\n" };
for (const n of gnames) gfiles[n] = ok;
for (const p of ["src/**/*.@(js|ts)", "{a,src/x/*}.?(c)js", "lib/!(deep)*.js", "**/+(a|d).js", "(src|lib)/*.js", "lib/*/**", "lib/**", "src/**", "**", "*", "**/*.js", "**/x/*", "src/*/", "lib/deep/*.min.js", "lib/{deep,x}/*.js", "[ab].js", "[!a].js", "?.js", "*.[jt]s", "src/**/", "./src/**/*.js", "../x/*.js", "lib/deep/../f.js", "{src,lib}/**/*.js", "!src/**"]) {
  s("glob " + p, gfiles, ["--list-files", p]);
}
s("glob neg after", gfiles, ["--list-files", "**/*.js", "!**/*.min.js", "!sub/**"]);
s("glob neg before", gfiles, ["--list-files", "!sub/**", "**/*.js"]);
const numbered = ["0", "1", "2", "3", "4", "9", "10", "11", "15", "20", "01", "02", "03", "001", "-1", "a", "b", "c", "d"];
const nfiles: Record<string, string> = { ".prettierrc.json": "{}\n" };
for (const n of numbered) nfiles["x" + n + ".js"] = ok;
for (const p of ["x{1..3}.js", "x{3..1}.js", "x{01..03}.js", "x{1..10}.js", "x{10..20}.js", "x{1..9..2}.js", "x{a..c}.js", "x{c..a}.js", "x{-1..1}.js", "x{a}.js"]) {
  s("seq " + p, nfiles, ["--list-files", p]);
}
const lfiles: Record<string, string> = { "a/x.js": ok, "sub/a/y.js": ok, "z.js": ok, ".prettierrc.json": "{}\n" };
for (const line of ["a/", "a/ ", "a ", "a", "/a", "a/*", "a/**", "*/x.js", "z.js", "!z.js", "*.js\n!z.js", "sub/a", "sub/a/", "/sub/*/", "*", "**/y.js", "sub/**/y.js", "sub/*/y.js", "\\a", "\\!a", "[a-b]", "[a]/", "a?", "a*"]) {
  s("ignore line " + JSON.stringify(line), { ...lfiles, ".prettierignore": line + "\n" }, ["--list-files", "."]);
}
const bnames = "build/a.js build/sub/b.js build/sub/x/c.js src/build/d.js src/e.js a.js a/f.js ab.js".split(" ");
const bfiles: Record<string, string> = { ".prettierrc.json": "{}\n" };
for (const n of bnames) bfiles[n] = ok;
for (const line of ["build/**/", "**/build/**/", "build/", "build/**", "build/**/x/", "a**/**", "build/*/", "**/build", "build/**/*.js", "src/**/d.js", "/build/**", "build/*", "**/sub/**", "*/sub/*"]) {
  s("ignore ** " + line, { ...bfiles, ".prettierignore": line + "\n" }, ["--list-files", "."]);
}

const gitInit = ["git init -q", "git config user.email t@t", "git config user.name t", "git add -A", "git commit -q -m init"];
s("staged none", { "a.js": ok, "b.js": ok }, ["--staged", "--list-files"], { git: gitInit });
s("staged new file", { "a.js": ok }, ["--staged", "--list-files"], { git: [...gitInit, "echo 'b = 2;' > b.js", "echo 'c = 3;' > c.js", "git add b.js"] });
s("staged check", { "a.js": ok }, ["--staged", "--check"], { git: [...gitInit, "echo 'b = 2;' > b.js", "git add b.js"] });
s("staged not a repo", { "a.js": ok }, ["--staged", "--list-files"]);
s("changed list", { "a.js": ok, "b.js": ok }, ["--changed", "--list-files"], { git: [...gitInit, "git branch -m main", "git checkout -q -b feature", "echo 'c = 3;' > c.js", "git add c.js", "git commit -q -m c", "echo 'd = 4;' > d.js"] });
s("changed ref", { "a.js": ok }, ["--changed=HEAD", "--list-files"], { git: [...gitInit, "echo 'd = 4;' > d.js", "echo 'a = 2;' > a.js"] });
s("changed bad ref", { "a.js": ok }, ["--changed=nope", "--list-files"], { git: gitInit });
s("changed no commits", { "a.js": ok }, ["--changed", "--list-files"], { git: ["git init -q"] });
s("staged and changed", { "a.js": ok }, ["--staged", "--changed"], { git: gitInit });
s("staged partly", { "a.js": ok }, ["--staged"], { git: [...gitInit, "echo 'a = 2;\n' > a.js", "git add a.js", "echo 'a = 3;' > a.js"] });


// ---- odd names and trees ----
const odd: Record<string, string> = {
  "é ü.js": ok, "日本語.ts": ok, "a b/c d.js": ok, "dir with space/x.ts": ok, "UPPER.JS": ok, "lower.js": ok, "Mixed.Ts": ok,
  "a-b.js": ok, "a_b.js": ok, "a.b.js": ok, "a+b.js": ok, "a@b.js": ok, "a#b.js": ok, "a~b.js": ok, "a$b.js": ok, "0.js": ok, "10.js": ok, "2.js": ok,
  "z/a.js": ok, "Z/a.js": ok, "z-1/a.js": ok, "z.1/a.js": ok, "z_1/a.js": ok, "z 1/a.js": ok, ".dot.js": ok, "dir/.dot.ts": ok, "e\u0301.js": ok,
};
s("odd names", odd, ["--list-files"]);
s("odd names glob", odd, ["--list-files", "**/*.js"]);
s("odd names dir", odd, ["--list-files", "a b"]);
s("odd names ignore", { ...odd, ".gitignore": "a b/\n*.JS\n" }, ["--list-files"]);
s("odd names ignore space", { ...odd, ".gitignore": "dir\\ with\\ space\n" }, ["--list-files"]);
s("symlinks", { "a.js": ok, "d/b.js": ok }, ["--list-files"], { links: [["a.js", "ln.js"], ["d", "dlink"], ["nothere", "broken.js"]] });
s("symlink arg", { "a.js": ok, "d/b.js": ok }, ["--list-files", "ln.js"], { links: [["a.js", "ln.js"]] });
s("symlink dir arg", { "a.js": ok, "d/b.js": ok }, ["--list-files", "dlink"], { links: [["d", "dlink"]] });
s("symlink dir arg write", { "a.js": ok, "d/b.js": ok }, ["dlink"], { links: [["d", "dlink"]] });
s("empty files", { "a.js": "", "b.json": "", "c.css": "", "d.md": "", "e.yaml": "" }, ["--check"]);
s("deep nesting", { "a/b/c/d/e/f/g/h/i/j/k.js": ok }, ["--list-files"]);
s("many dirs", Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), ["--list-files"]);
s("many dirs ignore", { ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), ".gitignore": "d3\ns2\nf1*.js\n" }, ["--list-files"]);
s("many dirs nested config", { ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), "d4/.prettierrc.json": "{}\n", "d4/s2/.editorconfig": "[*]\nindent_style = tab\n" }, ["--check"]);
s("many dirs glob", Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), ["--list-files", "d1*/s[23]/f*5.js"]);
s("many dirs dir arg", Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), ["--list-files", "d3", "d1/s2", "d3/s1"]);
s("node_modules nested", { "a.js": ok, "x/node_modules/y.js": ok, "node_modules/z.js": ok, "x/y/node_modules/q/r.js": ok }, ["--list-files"]);
s("git dir nested", { "a.js": ok, "x/.git/y.js": ok, ".svn/z.js": ok, ".hg/z.js": ok, ".jj/z.js": ok, ".sl/z.js": ok }, ["--list-files"]);
s("hidden dir explicit", { ".hidden/a.js": ok }, ["--list-files", ".hidden/a.js"]);
s("explicit ignored dir", { ".git/a.js": ok, "b.js": ok }, ["--list-files", ".git"]);
s("explicit nm file", { "node_modules/a.js": ok }, ["--list-files", "node_modules/a.js"]);
s("explicit nm file with-node-modules", { "node_modules/a.js": ok }, ["--list-files", "--with-node-modules", "node_modules/a.js"]);
s("ignored explicit file", { "a.js": ok, ".prettierignore": "a.js\n" }, ["--check", "a.js"]);
s("ignored explicit dir files", { "d/a.js": ok, ".prettierignore": "d/\n" }, ["--check", "d/a.js"]);
s("ignored all", { "d/a.js": ok, ".prettierignore": "*\n" }, ["--check"]);
s("ignored all explicit", { "d/a.js": ok, ".prettierignore": "*\n" }, ["--check", "d"]);
s("ignored glob pattern", { "d/a.js": ok, ".prettierignore": "d\n" }, ["--check", "d/*.js"]);

s("nested broken config", { ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), "d4/s2/.prettierrc.json": "{\n" }, ["--check"]);
s("nested broken config list", { ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), "d4/s2/.prettierrc.json": "{\n" }, ["--list-files"]);
s("nested both configs", { ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), "d4/.prettierrc.json": "{}\n", "d4/.prettierrc.yaml": "{}\n" }, ["--check"]);
s("nested bad option", { ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), "d4/.prettierrc.json": '{ "printWidth": "x" }\n' }, ["--check"]);
s("nested editorconfig root", { ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`d${i % 17}/s${i % 5}/f${i}.js`, ok])), "d4/.editorconfig": "root = true\n" }, ["--check"]);

s("color write", { "a.js": ok }, ["--color"]);
s("color check", { "a.js": ok }, ["--color", "--check"]);
s("color warn", { "a.js": ok, ".prettierrc.json": '{ "foo": 1 }\n' }, ["--color", "--check"]);
s("color error", { "a.js": ok }, ["--color", "--check", "nope.js"]);
s("color unsupported", { "a.js": ok, "b.svelte": "x" }, ["--color", "--check"]);
s("color usage", {}, ["--color", "--bogus"]);
s("color list", { "a.js": ok }, ["--color", "--list-files"]);
s("no-color", { "a.js": ok, "b.svelte": "x" }, ["--no-color", "--check"], { env: { FORCE_COLOR: "1" } });
s("force color env", { "a.js": ok }, [], { env: { FORCE_COLOR: "1", NO_COLOR: "" } });

s("debug-check", { "a.js": ok, "b.json": okJson }, ["--debug-check"]);
s("debug-check list", { "a.js": ok, "b.json": okJson }, ["--debug-check", "-l"]);
s("debug-check check", { "a.js": ok, "b.json": okJson }, ["--debug-check", "--check"]);
s("debug-check write", { "a.js": ok }, ["--debug-check", "--write"]);
s("debug-check stdin", {}, ["--debug-check", "--stdin-filepath", "a.js"], { stdin: ok });
s("debug-check stdin unnamed", {}, ["--debug-check", "--parser=babel"], { stdin: ok });
s("write flag", { "a.js": ok }, ["--write"]);
s("write check", { "a.js": ok }, ["--write", "--check"]);
s("write list-different", { "a.js": ok }, ["--write", "-l"]);
s("cursor offset", {}, ["--stdin-filepath", "a.js", "--cursor-offset=2"], { stdin: ok });
s("range", {}, ["--stdin-filepath", "a.js", "--range-start=0", "--range-end=3"], { stdin: ok });
s("range bad", {}, ["--stdin-filepath", "a.js", "--range-start=x"], { stdin: ok });
s("require-pragma", { "a.js": ok }, ["--require-pragma", "--check"]);
s("tab-width fraction config", { "a.js": ok, ".prettierrc.json": '{ "tabWidth": 1.5 }\n' }, ["--check"]);
s("tab-width negative", { "a.js": ok }, ["--tab-width=-1", "--check"]);
s("print-width infinity", { "a.js": ok }, ["--print-width=Infinity", "--check"]);
s("trailing-comma override config", { "a.js": ok, ".prettierrc.json": '{ "trailingComma": "es5" }\n' }, ["--trailing-comma=none", "--check"]);
s("use-tabs false flag", { "a.js": ok }, ["--use-tabs=false", "--check"]);
s("end-of-line bad", { "a.js": ok }, ["--end-of-line=x", "--check"]);
s("sort-imports flag", { "a.js": ok }, ["--sort-imports", "--check"]);
s("sort-package-json flag", { "a.js": ok }, ["--sort-package-json", "--check"]);
s("jsdoc flag", { "a.js": ok }, ["--jsdoc", "--check"]);
s("sort-tailwindcss flag", { "a.js": ok }, ["--sort-tailwindcss", "--check"]);
s("plugin flag", { "a.js": ok }, ["--plugin=prettier-plugin-foo", "--check"]);
s("plugin flag builtin", { "a.js": ok }, ["--plugin=prettier-plugin-tailwindcss", "--check"]);
s("plugin flag allow", { "a.js": ok }, ["--plugin=prettier-plugin-foo", "--allow-unsupported", "--check"]);
s("plugin flag language", { "a.js": ok }, ["--plugin=prettier-plugin-svelte", "--check"]);

// ---- the command line tests of oxfmt (vendor/bun/test/cli/format/oxfmt-cli/cases.json): `node tools/difftest.ts --oxfmt [name]` ----
if (process.argv.includes("--oxfmt")) {
  scenarios.length = 0;
  const data = JSON.parse(fs.readFileSync(path.join(root, "vendor/bun/test/cli/format/oxfmt-cli/cases.json"), "utf8"));
  for (const it of data.cases) {
    const fx: Record<string, string | { link: string }> = { ...data.fixtures[it.name], ...(it.gitignore ?? {}) };
    const files: Record<string, string> = { ".oxfmtrc.json": "{}\n" };
    const links: string[][] = [];
    for (const [name, v] of Object.entries(fx)) {
      if (typeof v === "string") files["fixtures/" + name] = v;
      else links.push([v.link, "fixtures/" + name]);
    }
    const sc: Scenario = {
      name: `${it.name}/${it.index}`,
      files,
      args: ["--allow-unsupported", ...it.args],
      cwd: "fixtures" + (it.cwd ? "/" + it.cwd : ""),
      links,
      env: it.env ?? undefined,
    };
    if (it.stdin !== undefined) {
      const v = fx[it.stdin];
      sc.stdin = typeof v === "string" ? v : "";
    }
    scenarios.push(sc);
    if (it.stdin === undefined && !it.args.includes("--list-files")) scenarios.push({ ...sc, name: sc.name + " [list]", args: [...sc.args, "--list-files"] });
  }
  if (process.argv.includes("--oxfmt-list")) {
    for (let i = scenarios.length - 1; i >= 0; i--) if (!scenarios[i].name.endsWith("[list]")) scenarios.splice(i, 1);
  }
}

// ---- oxfmt ----
const OXC = { ".oxfmtrc.json": "{}\n" };
const oxTree: Record<string, string> = { ...OXC, ...tree };
s("ox list-files", oxTree, ["--list-files"]);
s("ox list-files dir", oxTree, ["--list-files", "src"]);
s("ox list-files file", oxTree, ["--list-files", "src/a.js", "a.ts", "notes.txt", "README.md"]);
s("ox list-files glob", oxTree, ["--list-files", "src/**/*.js"]);
s("ox list-files glob2", oxTree, ["--list-files", "*.js", "!lib"]);
s("ox list-files lock", oxTree, ["--list-files", "package-lock.json", "yarn.lock"]);
s("ox list-files cwd", oxTree, ["--list-files"], { cwd: "src" });
s("ox list-files dotdot", oxTree, ["--list-files", ".."], { cwd: "src" });
s("ox list-files missing", oxTree, ["--list-files", "nope"]);
s("ox list-files missing glob", oxTree, ["--list-files", "nope/**"]);
s("ox gitignore", { ...oxTree, ".gitignore": "lib/\n*.cjs\n" }, ["--list-files"]);
s("ox gitignore nested", { ...oxTree, "src/.gitignore": "*.js\n!a.js\n" }, ["--list-files"]);
s("ox gitignore nested dir", { ...oxTree, "src/x/.gitignore": "*\n" }, ["--list-files"]);
s("ox gitignore case", { ...oxTree, ".gitignore": "A.JS\nLIB/\n" }, ["--list-files"]);
s("ox gitignore braces", { ...oxTree, ".gitignore": "*.{cjs,ts}\n" }, ["--list-files"]);
s("ox gitignore class", { ...oxTree, ".gitignore": "[ab].js\n" }, ["--list-files"]);
s("ox gitignore anchored", { ...oxTree, ".gitignore": "/a.js\nsub\n" }, ["--list-files"]);
s("ox gitignore double", { ...oxTree, ".gitignore": "lib/**/g.js\n**/x\n" }, ["--list-files"]);
s("ox gitignore bad", { ...oxTree, ".gitignore": "[z-a]\n" }, ["--list-files"]);
s("ox gitignore repo", { ...oxTree, "sub/.gitignore": "*.js\n" }, ["--list-files"], { git: ["git init -q"] });
s("ox gitignore repo parent", { ...oxTree, ".gitignore": "sub\n" }, ["--list-files"], { git: ["git init -q"], cwd: "src" });
s("ox gitignore no repo parent", { ...oxTree, ".gitignore": "src\n" }, ["--list-files"], { cwd: "src" });
s("ox gitignore repo below", { ...oxTree, "src/.gitignore": "x\n" }, ["--list-files"], { cwd: "src", git: ["git init -q src"] });
s("ox info exclude", { ...oxTree }, ["--list-files"], { git: ["git init -q", "mkdir -p .git/info", "echo lib > .git/info/exclude"] });
s("ox prettierignore", { ...oxTree, ".prettierignore": "src\n*.ts\n" }, ["--list-files"]);
s("ox prettierignore braces", { ...oxTree, ".prettierignore": "*.{cjs,ts}\n" }, ["--list-files"]);
s("ox ignore-path", { ...oxTree, "my.ignore": "lib\n" }, ["--list-files", "--ignore-path", "my.ignore"]);
s("ox ignore-path missing", oxTree, ["--list-files", "--ignore-path", "nothere"]);
s("ox ignorePatterns", { ".oxfmtrc.json": '{ "ignorePatterns": ["lib/", "*.cjs", "!lib/f.js"] }\n', ...tree }, ["--list-files"]);
s("ox ignorePatterns nested", { ...oxTree, "src/.oxfmtrc.json": '{ "ignorePatterns": ["x/"] }\n' }, ["--list-files"]);
s("ox ignorePatterns dotdot", { ".oxfmtrc.json": '{ "ignorePatterns": ["../a"] }\n', ...tree }, ["--list-files"]);
s("ox ignorePatterns bad", { ".oxfmtrc.json": '{ "ignorePatterns": ["[z-a]"] }\n', ...tree }, ["--list-files"]);
s("ox bad json", { ".oxfmtrc.json": "{\n", ...tree }, ["--list-files"]);
s("ox bad overrides glob", { ".oxfmtrc.json": '{ "overrides": [{ "files": ["{a"], "options": {} }] }\n', ...tree }, ["--list-files"]);
s("ox bad overrides", { ".oxfmtrc.json": '{ "overrides": 1 }\n', ...tree }, ["--list-files"]);
s("ox both configs", { ".oxfmtrc.json": "{}\n", ".oxfmtrc.jsonc": "{}\n", ...tree }, ["--list-files"]);
s("ox and prettierrc", { ...oxTree, ".prettierrc.json": "{}\n" }, ["--list-files"]);
s("ox config flag", { ...tree, "my.json": '{ "ignorePatterns": ["lib/"] }\n' }, ["--list-files", "--config", "my.json"]);
s("ox config flag missing", { ...oxTree }, ["--list-files", "--config", "nothere.json"]);
s("ox -c flag", { ...tree, "my.json": '{ "ignorePatterns": ["lib/"] }\n' }, ["-c", "my.json", "--list-files"]);
s("ox -c flag check", { ...oxTree, "my.json": "{}\n" }, ["-c", "my.json", "--check"]);
s("ox check", oxTree, ["--check"]);
s("ox check list", oxTree, ["-l"]);
s("ox check both", oxTree, ["--check", "-l"]);
s("ox check check", oxTree, ["--check", "--check"]);
s("ox check write", oxTree, ["--check", "--write"]);
s("ox check init", oxTree, ["--check", "--init"]);
s("ox write", oxTree, []);
s("ox write file", oxTree, ["a.js"]);
s("ox empty", OXC, ["--check"]);
s("ox empty write", OXC, []);
s("ox unknown only", { ...OXC, "a.txt": "x" }, ["--check"]);
s("ox unknown named", { ...OXC, "a.txt": "x" }, ["--check", "a.txt"]);
s("ox log-level", oxTree, ["--check", "--log-level=silent"]);
s("ox log-level error", { ...OXC }, ["--check", "--log-level=error"]);
s("ox svelte", { ...OXC, "a.svelte": "x", "b.js": ok }, ["--check"]);
s("ox svelte on", { ".oxfmtrc.json": '{ "svelte": true }\n', "a.svelte": "x", "b.js": ok }, ["--check"]);
s("ox svelte on list", { ".oxfmtrc.json": '{ "svelte": true }\n', "a.svelte": "x", "b.js": ok }, ["--list-files"]);
s("ox flavor flag", tree, ["--flavor=oxfmt", "--list-files"]);
s("ox flavor flag check", tree, ["--flavor=oxfmt", "--check"]);
s("ox flavor flag prettier", oxTree, ["--flavor=prettier", "--list-files"]);
s("ox deps", { ...tree, "package.json": '{ "devDependencies": { "oxfmt": "^1" } }\n' }, ["--list-files"]);
s("ox deps both", { ...tree, "package.json": '{ "devDependencies": { "oxfmt": "^1", "prettier": "^3" } }\n' }, ["--check"]);
s("ox stdin", OXC, ["--stdin-filepath", "a.js"], { stdin: ok });
s("ox stdin check", OXC, ["--check", "--stdin-filepath", "a.js"], { stdin: ok });
s("ox stdin ignored", { ...OXC, ".prettierignore": "a.js\n" }, ["--stdin-filepath", "a.js"], { stdin: ugly });
s("ox stdin ignorePatterns", { ".oxfmtrc.json": '{ "ignorePatterns": ["a.js"] }\n' }, ["--stdin-filepath", "a.js"], { stdin: ugly });
s("ox stdin unknown", OXC, ["--stdin-filepath", "a.zzz"], { stdin: "x" });
s("ox stdin node_modules", OXC, ["--stdin-filepath", "node_modules/a.js"], { stdin: ok });
s("ox timing", oxTree, ["--check", "--timing"]);
s("ox editorconfig bad width", { ...OXC, ".editorconfig": "[*]\nmax_line_length = 1000\n", "a.js": ok }, ["--check"]);
s("ox bunfig", { ...oxTree, "bunfig.toml": "[fmt]\nignorePatterns = [\"lib\"]\n" }, ["--list-files"]);
s("ox print-width bad", { ...OXC, "a.js": ok }, ["--check", "--print-width=1000"]);
s("ox print-width 0", { ...OXC, "a.js": ok }, ["--check", "--print-width=0"]);
s("ox with-node-modules", oxTree, ["--list-files", "--with-node-modules"]);
s("ox nested config", { ...oxTree, "src/.oxfmtrc.json": "{}\n", "src/x/.oxfmtrc.jsonc": "{}\n" }, ["--check"]);
s("ox nested config both", { ...oxTree, "src/.oxfmtrc.json": "{}\n", "src/.oxfmtrc.jsonc": "{}\n" }, ["--check"]);
s("ox nested bad", { ...oxTree, "src/.oxfmtrc.json": "{\n" }, ["--check"]);
s("ox disable-nested-config", { ...oxTree, "src/.oxfmtrc.json": "{ \"ignorePatterns\": [\"*.js\"] }\n" }, ["--list-files", "--disable-nested-config"]);
s("ox nested ignore", { ...oxTree, "src/.oxfmtrc.json": "{ \"ignorePatterns\": [\"*.js\"] }\n" }, ["--list-files"]);
s("mixed ox nested list", { ...tree, "src/.oxfmtrc.json": "{ \"ignorePatterns\": [\"*.js\"] }\n" }, ["--list-files"]);
s("mixed ox nested check", { ...tree, "src/.oxfmtrc.json": "{}\n" }, ["--check"]);

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function normalize(text: string, dir: string): string {
  let t = text.split(dir).join("<DIR>");
  t = t.replace(/\[\d+(\.\d+)?m?s\]/g, "[Xms]");
  t = t.replace(/(\u001b\[1m)\d+(\.\d+)?m?s(\u001b\[0m)/g, "$1Xms$3");
  t = t.replace(/Finished in \d+ms/g, "Finished in Xms").replace(/ \(\d+ms\)/g, " (Xms)");
  t = t.replace(/wall: [0-9.]+ms finding files and configs, [0-9.]+ms formatting, [0-9.]+ms total/g, "wall: Xms finding files and configs, Xms formatting, Xms total");
  t = t.replace(/\/private\/tmp/g, "/tmp");
  return t;
}

function run(exe: string, sc: Scenario, dir: string): Result {
  const cwd = path.join(dir, sc.cwd ?? "");
  const args = sc.args.map((a) => a.split("<DIR>").join(dir));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), NO_COLOR: "1", ...(sc.env ?? {}) };
  if (sc.env?.FORCE_COLOR === undefined) delete env.FORCE_COLOR;
  const r = spawnSync(exe, exe === bun ? ["fmt", ...args] : args, { cwd, input: sc.stdin ?? "", encoding: "latin1", env });
  return { code: r.status, stdout: normalize(r.stdout, dir), stderr: normalize(r.stderr, dir) };
}

function makeTree(sc: Scenario): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "difftest-")));
  for (const [name, content] of Object.entries(sc.files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "latin1");
  }
  fs.mkdirSync(path.join(dir, sc.cwd ?? ""), { recursive: true });
  for (const cmd of sc.git ?? []) {
    spawnSync("sh", ["-c", cmd], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  }
  if (sc.name === "symlink file") {
    fs.symlinkSync("a.js", path.join(dir, "link.js"));
    fs.symlinkSync(".", path.join(dir, "loop"));
  }
  for (const [target, name] of sc.links ?? []) fs.symlinkSync(target, path.join(dir, name));
  return dir;
}

// Scenarios whose outcome depends on what the formatters do (ours are stubs), or on what Bun cannot be asked: not compared.
const STUB_DEPENDENT = new Set([
  "ox deps both",
  "prettierrc yaml",
  "prettierrc toml",
  "package.json prettier",
  "package.json prettier string",
  "no-config",
  "parser flag",
  "bunfig semi",
  "bunfig overrides",
  "bunfig config false",
  "overrides json",
  "cursor offset",
]);

const verbose = process.argv.includes("-v");
const filter = process.argv.filter((a) => !a.startsWith("-") && !a.endsWith(".ts") && a !== process.argv[0])[0];
let pass = 0;
let fail = 0;
const failed: string[] = [];
for (const sc of scenarios) {
  if (filter !== undefined && !sc.name.includes(filter)) continue;
  if (STUB_DEPENDENT.has(sc.name) && filter === undefined) continue;
  const d1 = makeTree(sc);
  const d2 = makeTree(sc);
  const a = run(bun, sc, d1);
  const b = run(ours, sc, d2);
  const same = a.code === b.code && a.stdout === b.stdout && a.stderr === b.stderr;
  if (same) pass++;
  else {
    fail++;
    failed.push(sc.name);
  }
  if (!same || verbose) {
    console.log((same ? "ok   " : "FAIL ") + sc.name + "  [" + sc.args.join(" ") + "]");
    if (!same || verbose) {
      console.log("  bun : exit=" + a.code + " stdout=" + JSON.stringify(a.stdout.slice(0, 600)) + " stderr=" + JSON.stringify(a.stderr.slice(0, 600)));
      console.log("  ours: exit=" + b.code + " stdout=" + JSON.stringify(b.stdout.slice(0, 600)) + " stderr=" + JSON.stringify(b.stderr.slice(0, 600)));
    }
  }
  fs.rmSync(d1, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
if (failed.length > 0) console.log("failed: " + failed.join(" | "));
