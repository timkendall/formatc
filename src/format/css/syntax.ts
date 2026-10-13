// `css::Parser`: the syntax of a style sheet. The numbers are those of `CSS_*` in src/driver/kinds.ts.
export const SYNTAX_CSS = 0;
export const SYNTAX_LESS = 1;
export const SYNTAX_SCSS = 2;

/** Prettier's `parser` option -> `Parser::from_name`; -1 if it is not a style sheet. */
export function syntaxFromName(name: string): number {
  if (name === "css") return SYNTAX_CSS;
  if (name === "less") return SYNTAX_LESS;
  if (name === "scss") return SYNTAX_SCSS;
  return -1;
}
