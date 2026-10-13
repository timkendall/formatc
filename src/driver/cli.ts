// The command line of `bun fmt`: port of vendor/bun/src/lint/driver/fmt/cli.rs and args.rs.

export const PRECEDENCE_CLI_OVERRIDE = 0;
export const PRECEDENCE_FILE_OVERRIDE = 1;
export const PRECEDENCE_PREFER_FILE = 2;

export const LOG_SILENT = 0;
export const LOG_ERROR = 1;
export const LOG_WARN = 2;
export const LOG_LOG = 3;
export const LOG_DEBUG = 4;

// How a flag takes its value.
const M_FLAG = 0;
const M_VALUE = 1;
const M_OPTIONAL = 2; // `--changed <ref>?`
const M_MANY = 3; // `--ignore-path <path>...`

class Param {
  short: string;
  long: string;
  mode: number;
  valueName: string;
  constructor(short: string, long: string, mode: number, valueName: string) {
    this.short = short;
    this.long = long;
    this.mode = mode;
    this.valueName = valueName;
  }
}

// In the order of the tables of cli.rs (the order decides which flag is suggested for a mistyped one).
const PARAMS: Param[] = [
  new Param("", "config", M_VALUE, "path"),
  new Param("", "no-config", M_FLAG, ""),
  new Param("", "no-editorconfig", M_FLAG, ""),
  new Param("", "init", M_FLAG, ""),
  new Param("", "doctor", M_FLAG, ""),
  new Param("", "print-width", M_VALUE, "n"),
  new Param("", "tab-width", M_VALUE, "n"),
  new Param("", "use-tabs", M_FLAG, ""),
  new Param("", "no-semi", M_FLAG, ""),
  new Param("", "single-quote", M_FLAG, ""),
  new Param("", "jsx-single-quote", M_FLAG, ""),
  new Param("", "quote-props", M_VALUE, "when"),
  new Param("", "trailing-comma", M_VALUE, "where"),
  new Param("", "no-bracket-spacing", M_FLAG, ""),
  new Param("", "bracket-same-line", M_FLAG, ""),
  new Param("", "arrow-parens", M_VALUE, "when"),
  new Param("", "object-wrap", M_VALUE, "how"),
  new Param("", "single-attribute-per-line", M_FLAG, ""),
  new Param("", "html-whitespace-sensitivity", M_VALUE, "how"),
  new Param("", "vue-indent-script-and-style", M_FLAG, ""),
  new Param("", "prose-wrap", M_VALUE, "how"),
  new Param("", "embedded-language-formatting", M_VALUE, "which"),
  new Param("", "end-of-line", M_VALUE, "which"),
  new Param("", "no-insert-final-newline", M_FLAG, ""),
  new Param("", "sort-imports", M_FLAG, ""),
  new Param("", "sort-tailwindcss", M_FLAG, ""),
  new Param("", "sort-package-json", M_FLAG, ""),
  new Param("", "jsdoc", M_FLAG, ""),
  // FILES
  new Param("", "staged", M_FLAG, ""),
  new Param("", "changed", M_OPTIONAL, "ref"),
  new Param("", "stdin-filepath", M_VALUE, "path"),
  new Param("", "ignore-path", M_MANY, "path"),
  new Param("", "ignore-pattern", M_MANY, "pattern"),
  new Param("", "with-node-modules", M_FLAG, ""),
  new Param("", "no-error-on-unmatched-pattern", M_FLAG, ""),
  new Param("u", "ignore-unknown", M_FLAG, ""),
  new Param("", "allow-unsupported", M_FLAG, ""),
  new Param("", "list-files", M_FLAG, ""),
  new Param("", "cwd", M_VALUE, "path"),
  // OUTPUT
  new Param("c", "check", M_FLAG, ""),
  new Param("l", "list-different", M_FLAG, ""),
  new Param("", "log-level", M_VALUE, "level"),
  new Param("f", "format", M_VALUE, "name"),
  new Param("", "color", M_FLAG, ""),
  new Param("", "no-color", M_FLAG, ""),
  new Param("", "timing", M_FLAG, ""),
  // OTHER
  new Param("", "threads", M_VALUE, "n"),
  new Param("", "debug-check", M_FLAG, ""),
  new Param("v", "version", M_FLAG, ""),
  new Param("h", "help", M_FLAG, ""),
  new Param("", "all", M_FLAG, ""),
  new Param("", "help-all", M_FLAG, ""),
  // OF_PRETTIER
  new Param("w", "write", M_FLAG, ""),
  new Param("", "config-precedence", M_VALUE, "which"),
  new Param("", "find-config-path", M_VALUE, "path"),
  new Param("", "parser", M_VALUE, "name"),
  new Param("", "plugin", M_MANY, "name"),
  new Param("", "require-pragma", M_FLAG, ""),
  new Param("", "check-ignore-pragma", M_FLAG, ""),
  new Param("", "insert-pragma", M_FLAG, ""),
  new Param("", "range-start", M_VALUE, "offset"),
  new Param("", "range-end", M_VALUE, "offset"),
  new Param("", "cursor-offset", M_VALUE, "offset"),
  new Param("", "experimental-ternaries", M_FLAG, ""),
  new Param("", "experimental-operator-position", M_VALUE, "where"),
  new Param("", "jsx-bracket-same-line", M_FLAG, ""),
  new Param("", "cache", M_FLAG, ""),
  new Param("", "cache-location", M_VALUE, "path"),
  new Param("", "cache-strategy", M_VALUE, "strategy"),
  new Param("", "experimental-cli", M_FLAG, ""),
  // OF_OXFMT
  new Param("", "flavor", M_VALUE, "which"),
  new Param("", "disable-nested-config", M_FLAG, ""),
  new Param("", "migrate", M_VALUE, "source"),
  new Param("", "lsp", M_FLAG, ""),
  // OPPOSITES
  new Param("", "editorconfig", M_FLAG, ""),
  new Param("", "semi", M_FLAG, ""),
  new Param("", "bracket-spacing", M_FLAG, ""),
  new Param("", "error-on-unmatched-pattern", M_FLAG, ""),
  new Param("", "insert-final-newline", M_FLAG, ""),
];

// The name in a configuration file of the option that a flag sets, or "".
export function optionOf(flag: string): string {
  switch (flag) {
    case "print-width":
      return "printWidth";
    case "tab-width":
      return "tabWidth";
    case "use-tabs":
      return "useTabs";
    case "semi":
      return "semi";
    case "single-quote":
      return "singleQuote";
    case "jsx-single-quote":
      return "jsxSingleQuote";
    case "quote-props":
      return "quoteProps";
    case "trailing-comma":
      return "trailingComma";
    case "bracket-spacing":
      return "bracketSpacing";
    case "bracket-same-line":
      return "bracketSameLine";
    case "arrow-parens":
      return "arrowParens";
    case "object-wrap":
      return "objectWrap";
    case "single-attribute-per-line":
      return "singleAttributePerLine";
    case "end-of-line":
      return "endOfLine";
    case "experimental-ternaries":
      return "experimentalTernaries";
    case "experimental-operator-position":
      return "experimentalOperatorPosition";
    case "embedded-language-formatting":
      return "embeddedLanguageFormatting";
    case "prose-wrap":
      return "proseWrap";
    case "html-whitespace-sensitivity":
      return "htmlWhitespaceSensitivity";
    case "vue-indent-script-and-style":
      return "vueIndentScriptAndStyle";
    case "require-pragma":
      return "requirePragma";
    case "insert-pragma":
      return "insertPragma";
    case "check-ignore-pragma":
      return "checkIgnorePragma";
    case "parser":
      return "parser";
    case "cursor-offset":
      return "cursorOffset";
    case "range-start":
      return "rangeStart";
    case "range-end":
      return "rangeEnd";
    case "jsx-bracket-same-line":
      return "jsxBracketSameLine";
    case "sort-imports":
      return "sortImports";
    case "sort-tailwindcss":
      return "sortTailwindcss";
    case "sort-package-json":
      return "sortPackageJson";
    case "jsdoc":
      return "jsdoc";
    case "insert-final-newline":
      return "insertFinalNewline";
    default:
      return "";
  }
}

// One entry of `[[fmt.overrides]]`.
export class Override {
  files: string[];
  excluded: string[];
  formatNames: string[];
  formatValues: string[];
  constructor() {
    this.files = [];
    this.excluded = [];
    this.formatNames = [];
    this.formatValues = [];
  }

  // Drops the options that the command-line flag `name` replaces. A flag that only turns a feature on keeps the
  // override's options for it.
  giveWayTo(name: string, value: string): void {
    const names: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < this.formatNames.length; i++) {
      const n = this.formatNames[i];
      const dot = n.indexOf(".");
      const whole = dot < 0 ? n : n.substring(0, dot);
      const isPart = dot >= 0;
      const keep = whole !== name || (value === "true" && (isPart || this.formatValues[i] !== "false"));
      if (keep) {
        names.push(n);
        values.push(this.formatValues[i]);
      }
    }
    this.formatNames = names;
    this.formatValues = values;
  }
}

type cli_Options = Options;

export let usageError = "";

export function clearUsageError(): void {
  usageError = "";
}

export class Options {
  patterns: string[] = [];
  check = false;
  listDifferent = false;
  write = false;
  stdinFilepath: string | null = null;
  config: string | null = null;
  configLookup = true;
  disableNestedConfig = false;
  editorconfig = true;
  configPrecedence = PRECEDENCE_CLI_OVERRIDE;
  ignorePath: string[] | null = null;
  ignorePattern: string[] = [];
  onlyStaged = false;
  onlyChanged = false;
  onlyRef: string | null = null;
  withNodeModules = false;
  errorOnUnmatchedPattern = true;
  ignoreUnknown = false;
  allowUnsupported = false;
  // 0: not set, 1: --flavor oxfmt, 2: --flavor prettier
  isLikeOxfmt = 0;
  init = false;
  doctor = false;
  asJson = false;
  findConfigPath: string | null = null;
  logLevel = LOG_LOG;
  formatNames: string[] = [];
  formatValues: string[] = [];
  overrides: Override[] = [];
  plugins: string[] = [];
  // 0: not set, 1: --color, 2: --no-color
  color = 0;
  version = false;
  help = false;
  all = false;
  threads = 0;
  timing = false;
  cwd: string | null = null;
  debugCheck = false;
  listFiles = false;
  // What follows `-c`, which is `--check` for Prettier and `--config <path>` for oxfmt, and whether `--check` is there too.
  afterShortC: string | null = null;
  afterShortCChecks = false;
  // The flags of which oxfmt takes one, once: as they follow each other on the command line, by their long names.
  modes: string[] = [];
  // Ours: the dev flags.
  compareTo: string | null = null;
  compareList = false;
  dumpOptions = false;
  dumpTo: string | null = null;

  clone(): Options {
    const o = new Options();
    o.patterns = this.patterns.slice();
    o.check = this.check;
    o.listDifferent = this.listDifferent;
    o.write = this.write;
    o.stdinFilepath = this.stdinFilepath;
    o.config = this.config;
    o.configLookup = this.configLookup;
    o.disableNestedConfig = this.disableNestedConfig;
    o.editorconfig = this.editorconfig;
    o.configPrecedence = this.configPrecedence;
    o.ignorePath = this.ignorePath === null ? null : this.ignorePath.slice();
    o.ignorePattern = this.ignorePattern.slice();
    o.onlyStaged = this.onlyStaged;
    o.onlyChanged = this.onlyChanged;
    o.onlyRef = this.onlyRef;
    o.withNodeModules = this.withNodeModules;
    o.errorOnUnmatchedPattern = this.errorOnUnmatchedPattern;
    o.ignoreUnknown = this.ignoreUnknown;
    o.allowUnsupported = this.allowUnsupported;
    o.isLikeOxfmt = this.isLikeOxfmt;
    o.init = this.init;
    o.doctor = this.doctor;
    o.asJson = this.asJson;
    o.findConfigPath = this.findConfigPath;
    o.logLevel = this.logLevel;
    o.formatNames = this.formatNames.slice();
    o.formatValues = this.formatValues.slice();
    o.overrides = this.overrides.slice();
    o.plugins = this.plugins.slice();
    o.color = this.color;
    o.version = this.version;
    o.help = this.help;
    o.all = this.all;
    o.threads = this.threads;
    o.timing = this.timing;
    o.cwd = this.cwd;
    o.debugCheck = this.debugCheck;
    o.listFiles = this.listFiles;
    o.afterShortC = this.afterShortC;
    o.afterShortCChecks = this.afterShortCChecks;
    o.modes = this.modes.slice();
    o.compareTo = this.compareTo;
    o.compareList = this.compareList;
    o.dumpOptions = this.dumpOptions;
    o.dumpTo = this.dumpTo;
    return o;
  }

  setFormat(name: string, value: string): void {
    for (let i = 0; i < this.formatNames.length; i++) {
      if (this.formatNames[i] === name) {
        this.formatNames.splice(i, 1);
        this.formatValues.splice(i, 1);
        i = i - 1;
      }
    }
    this.formatNames.push(name);
    this.formatValues.push(value);
  }

  // Takes in the flag called `name`. `value` is null for a flag that takes none; `isOn`: it is not written `--no-..`.
  // false: a usage error (in `usageError`).
  set(name: string, value: string | null, isOn: boolean): boolean {
    const text = value === null ? "" : value;
    const option = optionOf(name);
    if (option !== "") {
      let isOnAlready = false;
      for (let i = 0; i < this.formatNames.length; i++) {
        if (this.formatNames[i] === option && this.formatValues[i] !== "false") isOnAlready = true;
      }
      if (value === null && isOn && isOnAlready) return true;
      const v = value !== null ? value : isOn ? "true" : "false";
      this.setFormat(option, v);
      return true;
    }
    switch (name) {
      case "check":
        this.check = isOn;
        break;
      case "list-different":
        this.listDifferent = isOn;
        break;
      case "write":
        this.write = isOn;
        break;
      case "stdin-filepath":
        this.stdinFilepath = text;
        break;
      case "config":
        this.config = text;
        break;
      case "disable-nested-config":
        this.disableNestedConfig = isOn;
        break;
      case "list-files":
        this.listFiles = isOn;
        break;
      case "init":
        this.init = isOn;
        break;
      case "doctor":
        this.doctor = isOn;
        break;
      case "format":
        if (text === "json") this.asJson = true;
        else return fail('--format takes json, not "' + text + '"');
        break;
      case "flavor":
        if (text === "oxfmt") this.isLikeOxfmt = 1;
        else if (text === "prettier") this.isLikeOxfmt = 2;
        else return fail('Invalid --flavor value. Expected "oxfmt" or "prettier", but received "' + text + '".');
        break;
      case "migrate":
      case "lsp":
        return fail("bun fmt does not support --" + name);
      case "editorconfig":
        this.editorconfig = isOn;
        break;
      case "config-precedence":
        if (text === "cli-override") this.configPrecedence = PRECEDENCE_CLI_OVERRIDE;
        else if (text === "file-override") this.configPrecedence = PRECEDENCE_FILE_OVERRIDE;
        else if (text === "prefer-file") this.configPrecedence = PRECEDENCE_PREFER_FILE;
        else return fail('Invalid --config-precedence value. Expected "cli-override", "file-override" or "prefer-file", but received "' + text + '".');
        break;
      case "ignore-path":
        if (this.ignorePath === null) this.ignorePath = [];
        this.ignorePath.push(text);
        break;
      case "ignore-pattern":
        this.ignorePattern.push(text);
        break;
      case "staged":
      case "changed": {
        if (!this.setOnly(name, value, isOn)) return false;
        break;
      }
      case "with-node-modules":
        this.withNodeModules = isOn;
        break;
      case "error-on-unmatched-pattern":
        this.errorOnUnmatchedPattern = isOn;
        break;
      case "ignore-unknown":
        this.ignoreUnknown = isOn;
        break;
      case "allow-unsupported":
        this.allowUnsupported = isOn;
        break;
      case "find-config-path":
        this.findConfigPath = text;
        break;
      case "log-level":
        if (text === "silent") this.logLevel = LOG_SILENT;
        else if (text === "error") this.logLevel = LOG_ERROR;
        else if (text === "warn") this.logLevel = LOG_WARN;
        else if (text === "log") this.logLevel = LOG_LOG;
        else if (text === "debug") this.logLevel = LOG_DEBUG;
        else return fail('Invalid --log-level value. Expected "debug", "error", "log", "silent" or "warn", but received "' + text + '".');
        break;
      case "plugin":
        this.plugins.push(text);
        break;
      case "color":
        this.color = isOn ? 1 : 2;
        break;
      case "version":
        this.version = isOn;
        break;
      case "help":
        this.help = isOn;
        break;
      case "all":
        this.all = isOn;
        break;
      case "help-all":
        this.help = isOn;
        this.all = isOn;
        break;
      case "threads": {
        const n = parseDecimal(text);
        if (n > 0) this.threads = n;
        else return fail('--threads takes a number above zero, not "' + text + '"');
        break;
      }
      case "timing":
        this.timing = isOn;
        break;
      case "cwd":
        this.cwd = text;
        break;
      case "debug-check":
        this.debugCheck = isOn;
        break;
      case "compare-to":
        this.compareTo = text;
        break;
      case "compare-list":
        this.compareList = isOn;
        break;
      case "dump-options":
        this.dumpOptions = isOn;
        break;
      default:
        break;
    }
    return true;
  }

  setOnly(name: string, value: string | null, isOn: boolean): boolean {
    const isStaged = name === "staged";
    if (!isOn) {
      if (isStaged) this.onlyStaged = false;
      else this.onlyChanged = false;
      return true;
    }
    if ((isStaged && this.onlyChanged) || (!isStaged && this.onlyStaged)) return fail("--staged and --changed cannot be used together");
    if (isStaged) this.onlyStaged = true;
    else {
      this.onlyChanged = true;
      this.onlyRef = value !== null && value.length > 0 ? value : null;
    }
    return true;
  }

  // True for `bun fmt --parser x` with no paths: standard input, which has no file name.
  formatsUnnamedStdin(): boolean {
    const onlyReports = this.doctor || this.listFiles;
    if (this.patterns.length !== 0) return false;
    if (this.stdinFilepath !== null && this.stdinFilepath.length > 0) return false;
    if (onlyReports) return false;
    for (let i = 0; i < this.formatNames.length; i++) if (this.formatNames[i] === "parser") return true;
    return false;
  }

  hasOnly(): boolean {
    return this.onlyStaged || this.onlyChanged;
  }

  onlyFlag(): string {
    return this.onlyStaged ? "--staged" : "--changed";
  }

  // Why the tool refuses the flags that say what the run does, in its words. "" if it does not.
  refusalOfModes(isOxfmt: boolean): string {
    const ofDebugCheck = this.write && this.debugCheck ? "Cannot use --write and --debug-check together." : "";
    if (!isOxfmt) {
      if (this.check && this.listDifferent) return "Cannot use --check and --list-different together.";
      return ofDebugCheck;
    }
    // The second is what oxfmt stops at, whatever follows.
    if (this.modes.length < 2) return ofDebugCheck;
    const first = this.modes[0];
    const second = this.modes[1];
    if (first === second) return "argument `--" + second + "` cannot be used multiple times in this context";
    return "`--" + second + "` cannot be used at the same time as `--" + first + "`";
  }

  // The same command line as oxfmt reads it, if that is another way: `-c <path>` is `--config <path>`.
  asOxfmtReadsIt(): cli_Options | null {
    if (this.afterShortC === null) return null;
    const o = this.clone();
    const at = o.patterns.indexOf(this.afterShortC);
    if (at < 0) return null;
    o.config = o.patterns.splice(at, 1)[0];
    o.check = this.afterShortCChecks;
    return o;
  }

  // `args`: what follows `fmt` on the command line. Applies them to this. false on a usage error.
  apply(args: string[]): boolean {
    const filtered: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--no-config") this.configLookup = false;
      else filtered.push(args[i]);
    }
    const rewritten: string[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const arg = filtered[i];
      if (arg.startsWith("-c=")) rewritten.push("--config=" + arg.substring(3));
      else if (arg === "-V") rewritten.push("--version");
      else rewritten.push(arg);
    }
    // `-c` is `--check` for Prettier and `--config` for oxfmt, which takes `-c=path`.
    const cAt = rewritten.indexOf("-c");
    if (cAt >= 0 && cAt + 1 < rewritten.length && !rewritten[cAt + 1].startsWith("-")) {
      this.afterShortC = rewritten[cAt + 1];
      this.afterShortCChecks = rewritten.indexOf("--check") >= 0;
    }
    this.modes = [];
    for (let i = 0; i < rewritten.length; i++) {
      const arg = rewritten[i];
      if (arg === "--") break;
      if (arg === "-c" && i + 1 < rewritten.length && !rewritten[i + 1].startsWith("-")) continue;
      if (arg === "--check" || arg === "-c") this.modes.push("check");
      else if (arg === "--list-different" || arg === "-l") this.modes.push("list-different");
      else if (arg === "--write" || arg === "-w") this.modes.push("write");
      else if (arg === "--init") this.modes.push("init");
      else if (arg === "--stdin-filepath" || arg.startsWith("--stdin-filepath=")) this.modes.push("stdin-filepath");
    }
    if (!parseArgs(this, rewritten)) return false;
    if (this.all && !this.help) return fail("--all has no effect without --help");
    return true;
  }

  static parse(args: string[]): Options | null {
    const o = new Options();
    if (!o.apply(args)) return null;
    return o;
  }

  // The same, where a flag that is not there is as `defaults` says (bunfig.toml).
  static parseOver(defaults: Options, args: string[]): Options | null {
    const alone = Options.parse(args);
    if (alone === null) return null;
    if (alone.config !== null || !alone.configLookup) {
      defaults.config = null;
      defaults.configLookup = true;
    }
    for (let i = 0; i < alone.formatNames.length; i++) {
      for (let k = 0; k < defaults.overrides.length; k++) defaults.overrides[k].giveWayTo(alone.formatNames[i], alone.formatValues[i]);
    }
    if (!defaults.apply(args)) return null;
    return defaults;
  }
}

function fail(message: string): boolean {
  usageError = message;
  return false;
}

export function parseDecimal(text: string): number {
  if (text.length === 0 || text.length > 15) return -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) return -1;
  }
  return Number(text);
}

function findLong(name: string): Param | null {
  for (let i = 0; i < PARAMS.length; i++) if (PARAMS[i].long === name) return PARAMS[i];
  // our dev flags
  if (name === "compare-to") return DEV_COMPARE_TO;
  if (name === "compare-list") return DEV_COMPARE_LIST;
  if (name === "dump-options") return DEV_DUMP;
  return null;
}

const DEV_COMPARE_TO = new Param("", "compare-to", M_VALUE, "dir");
const DEV_COMPARE_LIST = new Param("", "compare-list", M_FLAG, "");
const DEV_DUMP = new Param("", "dump-options", M_FLAG, "");

function findShort(c: string): Param | null {
  for (let i = 0; i < PARAMS.length; i++) if (PARAMS[i].short === c) return PARAMS[i];
  return null;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev.push(j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j - 1] + cost;
      if (prev[j] + 1 < v) v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      cur.push(v);
    }
    prev = cur;
  }
  return prev[n];
}

function unknown(written: string, name: string): boolean {
  let best = "";
  let bestD = 1000000;
  for (let i = 0; i < PARAMS.length; i++) {
    const d = editDistance(name, PARAMS[i].long);
    if (d < bestD) {
      bestD = d;
      best = PARAMS[i].long;
    }
  }
  if (best.length > 0) return fail("Invalid option '" + written + "' - perhaps you meant '--" + best + "'?");
  return fail("Invalid option '" + written + "'.");
}

function isAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAlnum(c: number): boolean {
  return isAlpha(c) || (c >= 48 && c <= 57);
}

function booleanOf(name: string, value: string): number {
  if (value === "true") return 1;
  if (value === "false") return 0;
  usageError = "Invalid value for option '" + name + "' - expected type Boolean, received value: " + value + ".";
  return -1;
}

function give(options: Options, p: Param, value: string | null, isOn: boolean): boolean {
  return options.set(p.long, value, isOn);
}

function parseArgs(options: Options, args: string[]): boolean {
  let awaited: Param | null = null;
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    i = i + 1;
    if (arg === "--") {
      while (i < args.length) {
        rest.push(args[i]);
        i = i + 1;
      }
      break;
    }
    // /^(--?)([a-zA-Z][-a-zA-Z0-9]*)(=)?(.*)?$/
    let dashes = 0;
    while (dashes < arg.length && arg.charCodeAt(dashes) === 45 && dashes < 2) dashes = dashes + 1;
    const body = arg.substring(dashes);
    let nameLen = 0;
    while (nameLen < body.length && (isAlnum(body.charCodeAt(nameLen)) || body.charCodeAt(nameLen) === 45)) nameLen = nameLen + 1;
    if (dashes > 0 && body.length > 0 && isAlpha(body.charCodeAt(0))) {
      if (awaited !== null) return fail("Value for '" + awaited.long + "' of type '" + awaited.valueName + "' required.");
      const name = body.substring(0, nameLen);
      const after = body.substring(nameLen);
      const hasValue = after.startsWith("=");
      const value = hasValue ? after.substring(1) : "";
      if (dashes === 1) {
        for (let at = 0; at < name.length; at++) {
          const s = name.charAt(at);
          const p = findShort(s);
          if (p === null) return unknown("-" + s, s);
          const last = at + 1 === name.length;
          const isFlag = p.mode === M_FLAG;
          if (last && isFlag && hasValue) {
            const b = booleanOf(p.long, value);
            if (b < 0) return false;
            if (!give(options, p, null, b === 1)) return false;
          } else if (last && !isFlag && hasValue) {
            if (!give(options, p, value, true)) return false;
          } else if (last && !isFlag) {
            awaited = p;
          } else if (isFlag) {
            if (!give(options, p, null, true)) return false;
          } else {
            return fail("Can't set argument '" + s + "' when not last flag in a group of short flags.");
          }
        }
        continue;
      }
      let positive = name;
      let isNegated = false;
      if (name.startsWith("no-") && name.length > 3) {
        positive = name.substring(3);
        isNegated = true;
      }
      const p = findLong(positive);
      if (p === null) return unknown("--" + positive, positive);
      const isFlag = p.mode === M_FLAG;
      if (isFlag && hasValue) {
        const b = booleanOf(positive, value);
        if (b < 0) return false;
        if (!give(options, p, null, (b === 1) !== isNegated)) return false;
      } else if (isFlag) {
        if (!give(options, p, null, !isNegated)) return false;
      } else if (isNegated) {
        return fail("Only use 'no-' prefix for Boolean options, not with '" + positive + "'.");
      } else if (hasValue) {
        if (!give(options, p, value, true)) return false;
      } else if (p.mode === M_OPTIONAL) {
        if (!give(options, p, null, true)) return false;
      } else {
        awaited = p;
      }
    } else if (arg.charCodeAt(0) === 45 && /^-[0-9][0-9.]*[0-9]$|^-[0-9]$/.test(arg) && arg.split(".").length <= 2) {
      return fail("No -NUM option defined.");
    } else if (awaited !== null) {
      const p = awaited;
      awaited = null;
      if (!give(options, p, arg, true)) return false;
    } else {
      options.patterns.push(arg);
    }
  }
  if (awaited !== null) return fail("Value for '" + awaited.long + "' of type '" + awaited.valueName + "' required.");
  for (let k = 0; k < rest.length; k++) options.patterns.push(rest[k]);
  return true;
}
