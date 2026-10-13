// What the functions of Prettier get as `options` (Rust `html::Options`).
import { FormatOptions } from "../options.ts";

export class HOptions {
  /** Prettier's `parser`: a `P_*` of ast.ts. */
  parser: number;
  /** `originalText`, in which every line break is `\n`. */
  originalText: Uint8Array;
  format: FormatOptions;
  /** The name of the file, if there is one (`filepath`). */
  hasFilepath: boolean;
  filepath: string;
  /** Whether there is a `parentParser`: the text is in a text in another language. */
  hasParentParser: boolean;
  /** Whose output the scripts are: a `FLAVOR_*`. */
  scriptFlavor: number;

  constructor(parser: number, originalText: Uint8Array, format: FormatOptions, hasFilepath: boolean, filepath: string, hasParentParser: boolean, scriptFlavor: number) {
    this.parser = parser;
    this.originalText = originalText;
    this.format = format;
    this.hasFilepath = hasFilepath;
    this.filepath = filepath;
    this.hasParentParser = hasParentParser;
    this.scriptFlavor = scriptFlavor;
  }
}
