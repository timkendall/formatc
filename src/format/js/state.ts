// Leaf state of the JavaScript formatter (no imports: its globals are plain loads, and modules in an import cycle can read it).
// Per thread, like the HIR. Set by `formatFile` (mod.ts) for the file that is being formatted.

export class JsState {
  /**
   * The file is the text `(`, an expression that is in HTML, and `)`: its name starts with a NUL (Rust `File::path().first() == Some(&0)`).
   * The parent of the expression is the `Program` then (Prettier's `JsExpressionRoot` and `NGRoot`).
   */
  expressionRootFile: boolean = false;
  /** The path the file was parsed under (`File::path()`), set by `formatScript`. */
  path: string = "";
}

export const jsState = new JsState();

/** Rust `Formatter::filepath()`: Prettier's `filepath` option, else the path of the file. `optionsFilepath`: `f.options.filepath` ("" for none). */
export function filepathOf(optionsFilepath: string): string {
  return optionsFilepath.length > 0 ? optionsFilepath : jsState.path;
}

/** Goes through the children of a node in order, looking for the one after `me` (siblings.ts). */
export class SiblingsFinder {
  meStart: number = 0;
  meEnd: number = 0;
  isFound: boolean = false;
  /** Where the next sibling starts; -1: not known yet (Rust `None`). */
  following: number = -1;
  /** oxfmt has a node for what Prettier has none. */
  hasAllNodes: boolean = false;
  /** `spans()`: the loop is skipped. */
  skipSpans: boolean = false;
  wasFound: boolean = false;

  begin(start: number, end: number, hasAllNodes: boolean): void {
    this.meStart = start;
    this.meEnd = end;
    this.isFound = false;
    this.following = -1;
    this.hasAllNodes = hasAllNodes;
    this.skipSpans = false;
    this.wasFound = false;
  }

  /** `child.contains(me)` */
  containsMe(start: number, end: number): boolean {
    return start <= this.meStart && this.meEnd <= end;
  }

  /** A child that is there or not. */
  one(has: boolean, start: number, end: number): void {
    if (this.following >= 0) return;
    if (!has) return;
    if (this.isFound) this.following = start;
    else if (this.containsMe(start, end)) this.isFound = true;
  }

  /**
   * A child that Prettier has no node for, like the parentheses around parameters. What is before it is followed by the first thing in
   * it, which starts at `first` (-1: there is none).
   */
  transparent(has: boolean, start: number, end: number, first: number): void {
    if (this.following < 0 && this.isFound && has && first >= 0 && !this.hasAllNodes) this.following = first;
    this.one(has, start, end);
  }

  /** `spans()`: call `spansBegin`, `spansItem` for each, `spansEnd(isOpen)`. */
  spansBegin(): void {
    this.skipSpans = this.following >= 0;
    this.wasFound = this.isFound;
  }
  spansItem(start: number, end: number): void {
    if (this.skipSpans || this.following >= 0) return;
    if (this.isFound) {
      this.following = start;
      return;
    }
    this.isFound = this.containsMe(start, end);
  }
  spansEnd(isOpen: boolean): void {
    if (this.skipSpans || this.following >= 0) return;
    if (this.isFound && !this.wasFound && !isOpen) this.following = 0;
  }
}

export const finder = new SiblingsFinder();

/** Where `formatDocument` put the blanks it took off the document (read by `cursor.ts`): a leaf module, so that `js/mod.ts` need not import `cursor.ts`. */
export class TrimInfo {
  leading: number = 0;
  end: number = -1;
}
export const trimInfo = new TrimInfo();
