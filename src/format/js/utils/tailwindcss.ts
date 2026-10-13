// Port of vendor/bun/src/format/js/utils/tailwindcss.rs. TODO(port): SKELETON (a function that writes a node writes it as it is in the source).
// oxfmt's `sortTailwindcss` is not supported by the driver yet (the option is refused); these answer "no context".
import { Formatter } from "../../ir/formatter.ts";
import { ByteBuf } from "../../../base/bytebuf.ts";

/** `has_white_space(text)` */
export function hasWhiteSpace(text: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const b = text[i] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) return true;
  }
  return false;
}
export function contextOfFunction(callee: number, f: Formatter): number {
  // TODO(port)
  return -1;
  void callee;
  void f;
}

export function contextOfAttribute(name: Uint8Array, nameStart: number, nameEnd: number, f: Formatter): number {
  // TODO(port)
  return -1;
  void name;
  void nameStart;
  void nameEnd;
  void f;
}

export function contextOfString(source: Uint8Array, sourceStart: number, sourceEnd: number, f: Formatter): number {
  // TODO(port)
  return -1;
  void source;
  void sourceStart;
  void sourceEnd;
  void f;
}

export function losesLineBreaks(e: number, f: Formatter): boolean {
  // TODO(port)
  return false;
  void e;
  void f;
}

/**
 * `sorted_string_literal(source, is_jsx, (span, parent), context, f)`: the string literal `text[start, end)` with its classes sorted, appended to
 * `out`. false: nothing to sort. `context`: a packed `TailwindContext` (`TWC_*` of context.ts). TODO(port): oxfmt's `sortTailwindcss` is not supported by the driver.
 */
export function sortedStringLiteral(start: number, end: number, isJsx: boolean, parent: number, context: number, f: Formatter, out: ByteBuf): boolean {
  void start;
  void end;
  void isJsx;
  void parent;
  void context;
  void f;
  void out;
  return false;
}

/** `sorted_template_text(text, (is_first, is_last), context, tailwind)`: a text of a template with its classes sorted, appended to `out`. false: nothing to sort. TODO(port) */
export function sortedTemplateText(start: number, end: number, isFirst: boolean, isLast: boolean, context: number, f: Formatter, out: ByteBuf): boolean {
  void start;
  void end;
  void isFirst;
  void isLast;
  void context;
  void f;
  void out;
  return false;
}
