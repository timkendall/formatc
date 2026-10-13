// Port of the options of vendor/bun/src/md/root.rs and the flags of types.rs.

/** Parser flags controlling which extensions are enabled (Rust: `types::Flags`). */
export class Flags {
  collapseWhitespace = false;
  permissiveAtxHeaders = false;
  permissiveUrlAutolinks = false;
  permissiveWwwAutolinks = false;
  permissiveEmailAutolinks = false;
  noIndentedCodeBlocks = false;
  noHtmlBlocks = false;
  noHtmlSpans = false;
  tables = false;
  strikethrough = false;
  tasklists = false;
  latexMath = false;
  wikiLinks = false;
  footnotes = false;
  mathBlocks = false;
  directives = false;
  noSingleTilde = false;
  micromark = false;
  micromarkToTheLetter = false;
  mdx = false;
}

export class RenderOptions {
  tagFilter = false;
  headingIds = false;
  autolinkHeadings = false;
}

/** Rust: `Options` (defaults: tables, strikethrough and tasklists on, the rest off). */
export class Options {
  tables = true;
  strikethrough = true;
  tasklists = true;
  permissiveAutolinks = false;
  permissiveUrlAutolinks = false;
  permissiveWwwAutolinks = false;
  permissiveEmailAutolinks = false;
  hardSoftBreaks = false;
  wikiLinks = false;
  underline = false;
  latexMath = false;
  collapseWhitespace = false;
  permissiveAtxHeaders = false;
  noIndentedCodeBlocks = false;
  noHtmlBlocks = false;
  noHtmlSpans = false;
  /** GFM tag filter: replaces `<` with `&lt;` for disallowed HTML tags. */
  tagFilter = false;
  headingIds = false;
  autolinkHeadings = false;
  /** GFM: `[^label]: ..` is the definition of a footnote. Only for consumers that look at `BLOCK_FOOTNOTE`. */
  footnotes = false;
  /** `$$` is a fence, like three backticks. */
  mathBlocks = false;
  /** `:::name` starts a container that `:::` ends. Only for consumers that look at `BLOCK_DIRECTIVE`. */
  directives = false;
  /** Strikethrough takes two tildes. */
  noSingleTilde = false;
  /** See compat.ts. */
  micromark = false;
  /** See compat.ts: what a parser that follows micromark need not do. */
  micromarkToTheLetter = false;
  mdx = false;

  /** All switches of `Options::NONE`. */
  clearAll(): void {
    this.tables = false;
    this.strikethrough = false;
    this.tasklists = false;
    this.permissiveAutolinks = false;
    this.permissiveUrlAutolinks = false;
    this.permissiveWwwAutolinks = false;
    this.permissiveEmailAutolinks = false;
    this.hardSoftBreaks = false;
    this.wikiLinks = false;
    this.underline = false;
    this.latexMath = false;
    this.collapseWhitespace = false;
    this.permissiveAtxHeaders = false;
    this.noIndentedCodeBlocks = false;
    this.noHtmlBlocks = false;
    this.noHtmlSpans = false;
    this.tagFilter = false;
    this.headingIds = false;
    this.autolinkHeadings = false;
    this.footnotes = false;
    this.mathBlocks = false;
    this.directives = false;
    this.noSingleTilde = false;
    this.micromark = false;
    this.micromarkToTheLetter = false;
    this.mdx = false;
  }

  /** `Options::TERMINAL` */
  static terminal(): Options {
    const o = new Options();
    o.clearAll();
    o.tables = true;
    o.strikethrough = true;
    o.tasklists = true;
    o.permissiveUrlAutolinks = true;
    o.permissiveWwwAutolinks = true;
    o.permissiveEmailAutolinks = true;
    o.wikiLinks = true;
    o.underline = true;
    o.latexMath = true;
    return o;
  }

  toFlags(f: Flags): void {
    f.tables = this.tables;
    f.strikethrough = this.strikethrough;
    f.tasklists = this.tasklists;
    f.permissiveUrlAutolinks = this.permissiveUrlAutolinks || this.permissiveAutolinks;
    f.permissiveWwwAutolinks = this.permissiveWwwAutolinks || this.permissiveAutolinks;
    f.permissiveEmailAutolinks = this.permissiveEmailAutolinks || this.permissiveAutolinks;
    f.wikiLinks = this.wikiLinks;
    f.latexMath = this.latexMath;
    f.collapseWhitespace = this.collapseWhitespace;
    f.permissiveAtxHeaders = this.permissiveAtxHeaders;
    f.noIndentedCodeBlocks = this.noIndentedCodeBlocks;
    f.noHtmlBlocks = this.noHtmlBlocks;
    f.noHtmlSpans = this.noHtmlSpans;
    f.footnotes = this.footnotes;
    f.mathBlocks = this.mathBlocks;
    f.directives = this.directives;
    f.noSingleTilde = this.noSingleTilde;
    f.micromark = this.micromark;
    f.micromarkToTheLetter = this.micromarkToTheLetter;
    f.mdx = this.mdx;
  }

  toRenderOptions(r: RenderOptions): void {
    r.tagFilter = this.tagFilter;
    r.headingIds = this.headingIds;
    r.autolinkHeadings = this.autolinkHeadings;
  }

  /** Sets an option by the camelCase name `Bun.markdown` takes. Returns false for an unknown name. */
  setByName(name: string, v: boolean): boolean {
    switch (name) {
      case "tables": this.tables = v; return true;
      case "strikethrough": this.strikethrough = v; return true;
      case "tasklists": this.tasklists = v; return true;
      case "permissiveAutolinks": this.permissiveAutolinks = v; return true;
      case "permissiveUrlAutolinks": this.permissiveUrlAutolinks = v; return true;
      case "permissiveWwwAutolinks": this.permissiveWwwAutolinks = v; return true;
      case "permissiveEmailAutolinks": this.permissiveEmailAutolinks = v; return true;
      case "hardSoftBreaks": this.hardSoftBreaks = v; return true;
      case "wikiLinks": this.wikiLinks = v; return true;
      case "underline": this.underline = v; return true;
      case "latexMath": this.latexMath = v; return true;
      case "collapseWhitespace": this.collapseWhitespace = v; return true;
      case "permissiveAtxHeaders": this.permissiveAtxHeaders = v; return true;
      case "noIndentedCodeBlocks": this.noIndentedCodeBlocks = v; return true;
      case "noHtmlBlocks": this.noHtmlBlocks = v; return true;
      case "noHtmlSpans": this.noHtmlSpans = v; return true;
      case "tagFilter": this.tagFilter = v; return true;
      case "headingIds": this.headingIds = v; return true;
      case "autolinkHeadings": this.autolinkHeadings = v; return true;
      case "footnotes": this.footnotes = v; return true;
      case "mathBlocks": this.mathBlocks = v; return true;
      case "directives": this.directives = v; return true;
      case "noSingleTilde": this.noSingleTilde = v; return true;
      case "micromark": this.micromark = v; return true;
      case "micromarkToTheLetter": this.micromarkToTheLetter = v; return true;
      case "mdx": this.mdx = v; return true;
      default: return false;
    }
  }
}

/** Parse errors (Rust: `ParserError`; only the input-size error can happen here). 0: none. */
export const ERR_NONE = 0;
export const ERR_INPUT_TOO_LARGE = 3;
