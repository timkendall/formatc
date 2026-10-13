// Port of vendor/bun/src/format/html/tailwind.rs: oxfmt's `sortTailwindcss` in HTML, Vue and Angular.
//
// oxfmt leaves it to `prettier-plugin-tailwindcss`, which rewrites the values of attributes in the tree that Prettier has parsed:
// `transformHtml`. A value is a piece of the text, so the text is rewritten before it is parsed.
//
// TODO(port): not ported. The owner of `src/format/tailwind.ts` (`Tailwind::sorted_between`, `follows_plugin`, the attribute matcher) has to
// provide the class sorter first; `format` in mod.ts calls this where Rust calls `tailwind::with_sorted_classes` when `options.tailwind` is set.
export function withSortedClasses(text: Uint8Array, parser: number, tailwind: number): Uint8Array | null {
  void text;
  void parser;
  void tailwind;
  return null;
}
