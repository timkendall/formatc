// Tokens that every formatter needs (`token("...")` handles; registering the same text again gives the same handle, so a
// file may also register its own copy). Rust writes these as string literals in `write!(f, ["(", ..])`.
//
//     import { LPAREN, RPAREN } from "../ir/tokens.ts";
//     f.token(LPAREN);
import { token } from "./element.ts";

export const LPAREN = token("(");
export const RPAREN = token(")");
export const LBRACE = token("{");
export const RBRACE = token("}");
export const LBRACKET = token("[");
export const RBRACKET = token("]");
export const LANGLE = token("<");
export const RANGLE = token(">");
export const EMPTY_PARENS = token("()");
export const EMPTY_BRACES = token("{}");
export const EMPTY_BRACKETS = token("[]");
export const COMMA = token(",");
export const SEMI = token(";");
export const COLON = token(":");
export const DOT = token(".");
export const ELLIPSIS = token("...");
export const QUESTION = token("?");
export const QUESTION_DOT = token("?.");
export const EQ = token("=");
export const ARROW = token("=>");
export const STAR = token("*");
export const BANG = token("!");
export const PIPE = token("|");
export const AMP = token("&");
export const PLUS = token("+");
export const MINUS = token("-");
export const SLASH = token("/");
export const HASH = token("#");
export const AT = token("@");
export const BACKTICK = token("`");
export const DOUBLE_QUOTE = token("\"");
export const SINGLE_QUOTE = token("'");
/** A space inside a token (`" = "`, `" as "`): not the `space()` element, which is dropped at the start and the end of a line. */
export const SPACE_TOKEN = token(" ");
