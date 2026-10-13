// The hook for what is specific to a language: Rust's `Formatter::context` (`JsFormatContext`).
//
// The IR knows nothing about JavaScript. `Formatter.context` is a field of this concrete base class (never an
// interface type: data fields read through an interface cost 26 ns, docs/SCRIPTC_COOKBOOK.md 4.3). The JavaScript
// formatter declares `class JsFormatContext extends FormatContext { file; comments; ... }`, creates one per file
// and assigns it to `f.context`; code that needs the JS fields does `const cx = f.context as JsFormatContext` (a
// checked class cast, cheap) or keeps its own module-level reference (state is per thread).
import { FormatOptions } from "../options.ts";
import { Stack } from "../../base/stack.ts";

export class FormatContext {
  options: FormatOptions;
  /** Something has not been written because it is nested too deeply (`ran_out_of_stack`). */
  ranOutOfStack: boolean;
  constructor(options: FormatOptions) {
    this.options = options;
    this.ranOutOfStack = false;
  }
}

/** Rust `FormatterBuffers`' stack part: see base/stack.ts. */
export function newStack(): Stack {
  return Stack.create();
}
