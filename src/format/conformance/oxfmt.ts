// Port of vendor/bun/src/format/conformance/oxfmt.rs: the fixtures of oxc's formatter. Next to each input are
// `<input>.snap`, what oxfmt prints, and `<input>.prettier.snap`, what Prettier prints, each for the same sets of
// options:
//
//   ------------------
//   { printWidth: 80 }
//   ------------------
//   <the output>
import { FormatOptions } from "../options.ts";
import { FT_NOT_PORTED, FT_OK } from "./dispatch.ts";
import { Bundle, Count, Flags, failureText, outputLine, replaceAll, runFormat, setMock, trimSet } from "./lib.ts";

const OUTPUT = "==================== Output ====================\n";
const SECOND_PASS = "---------- Not idempotent (second pass) ----------";
const END = "===================== End =====================\n";

// A rule of `-` as long as the options line.
function isRule(line: string, len: number): boolean {
  return line.length === len && len > 0 && trimSet(line, "-").length === 0;
}

function isHeader(lines: string[], at: number): boolean {
  if (at + 3 > lines.length) return false;
  const options = lines[at + 1];
  return options.startsWith("{") && options.endsWith("}") && isRule(lines[at], options.length) && isRule(lines[at + 2], options.length);
}

// The outputs in a snapshot, each with the line that says the options.
class Outputs {
  options: string[] = [];
  outputs: string[] = [];
}

function parse(text: string): Outputs {
  const at = text.lastIndexOf(OUTPUT);
  let body = at < 0 ? text : text.substring(at + OUTPUT.length);
  if (body.endsWith(END)) body = body.substring(0, body.length - END.length);
  const lines = body.split("\n");
  const headers: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isHeader(lines, i)) headers.push(i);
  const out = new Outputs();
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    // The line break at the end of the output is followed by one more.
    let end = i + 1 < headers.length ? headers[i + 1] : lines.length - 1;
    // What oxfmt makes of its own output, where that is something else, is not compared.
    for (let line = header + 3; line < end; line++) {
      if (lines[line] === SECOND_PASS) {
        end = line;
        break;
      }
    }
    const parts: string[] = [];
    for (let line = header + 3; line < end; line++) parts.push(lines[line]);
    out.options.push(lines[header + 1]);
    out.outputs.push(parts.join("\n"));
  }
  return out;
}

// `{ printWidth: 80, semi: false }`. null if there is an option that is not one of Prettier's.
function optionsOf(line: string, flavor: string): FormatOptions | null {
  // `bun fmt` does not format HTML in templates and in blocks of code by itself yet. Here it is judged.
  const options = new FormatOptions();
  options.embeddedHtml = true;
  if (!options.set("flavor", flavor)) return null;
  const items = trimSet(line, "{} ").split(", ");
  for (let i = 0; i < items.length; i++) {
    const option = items[i];
    const colon = option.indexOf(": ");
    if (colon < 0) return null;
    let name = option.substring(0, colon);
    const value = option.substring(colon + 2);
    // Prettier passes over an option that it does not know.
    if (name.startsWith("jsdoc") && flavor === "prettier") continue;
    // Which JSON it is.
    if (name === "variant") name = "parser";
    if (!options.set(name, trimSet(value, '"'))) return null;
  }
  return options;
}

// Prints `FAIL <judge> <input> <options>` for each output that is not the expected one, and how many are, as Prettier
// prints them and, in the flavor of oxfmt, as oxfmt prints them.
export function run(bundle: Bundle, flags: Flags): void {
  const asPrettier = new Count();
  const asOxfmt = new Count();
  let otherOptions = 0;
  let notPorted = 0;
  const suffix = ".prettier.snap";
  let seen = 0;
  for (let p = 0; p < bundle.sorted.length; p++) {
    const snapshot = bundle.sorted[p];
    if (!snapshot.endsWith(suffix)) continue;
    // `skip(first % every).step_by(every)`
    const position = seen;
    seen = seen + 1;
    if (position < flags.first % flags.every || (position - (flags.first % flags.every)) % flags.every !== 0) continue;
    const name = snapshot.substring(0, snapshot.length - suffix.length);
    const input = bundle.read(name);
    if (input === null || !flags.wants(name)) continue;
    for (let j = 0; j < 2; j++) {
      const flavor = j === 0 ? "prettier" : "oxfmt";
      const judged = j === 0 ? snapshot : name + ".snap";
      const count = j === 0 ? asPrettier : asOxfmt;
      const parsed = parse(bundle.readOrEmpty(judged));
      for (let i = 0; i < parsed.options.length; i++) {
        const line = parsed.options[i];
        const expected = parsed.outputs[i];
        const options = optionsOf(line, flavor);
        if (options === null) {
          otherOptions = otherOptions + 1;
          continue;
        }
        setMock(input, expected, true);
        const r = runFormat(name, input, options);
        if (r.status === FT_NOT_PORTED) {
          notPorted = notPorted + 1;
          continue;
        }
        let actual = r.status === FT_OK ? r.output : failureText(r);
        // The library that writes oxfmt's snapshots makes `\n` of every `\r\n`.
        if (flavor === "oxfmt") actual = replaceAll(actual, "\r\n", "\n");
        count.add(actual === expected);
        if (actual !== expected) {
          outputLine("FAIL " + flavor + " " + name + " " + line);
          flags.writeReport(flavor + " " + name + " " + line, expected, actual, input);
        }
      }
    }
  }
  outputLine("as Prettier prints them: " + asPrettier.toString());
  outputLine("as oxfmt prints them, in its flavor: " + asOxfmt.toString());
  if (otherOptions > 0) outputLine("not run: " + otherOptions + ": an option that is not there");
  if (notPorted > 0) outputLine("not run: " + notPorted + ": not ported yet");
}

