// Port of vendor/bun/src/sema/parser/token.rs. Token kinds are small ints in the order of TypeScript's SyntaxKind:
// the parser classifies a token by comparing its kind with the first and the last of a group, so the ORDER IS LOAD
// BEARING. Rust `T::OpenBrace` is `T_OPEN_BRACE`; `T::KeyOf` is `T_KEY_OF`; the keyword `number` is
// `T_NUMBER_KEYWORD` (`T_NUMBER` is a numeric literal), likewise `T_STRING_KEYWORD`, `T_BIG_INT_KEYWORD`.
//
// Groups (all inclusive): reserved words T_BREAK..T_WITH (T_ESCAPED_RESERVED_WORD is inside), strict-mode words
// T_IMPLEMENTS..T_YIELD, assignment operators T_EQUALS..T_CARET_EQUALS, identifier-or-keyword >= T_IDENTIFIER.

export const T_EOF: number = 0;
export const T_INVALID: number = 1;
export const T_CONFLICT_MARKER: number = 2;
export const T_NOT_TEXT: number = 3;
export const T_NUMBER: number = 4;
export const T_BIG_INT: number = 5;
export const T_STRING: number = 6;
export const T_JSX_TEXT: number = 7;
export const T_REGEX: number = 8;
export const T_NO_SUBSTITUTION_TEMPLATE: number = 9;
export const T_TEMPLATE_HEAD: number = 10;
export const T_TEMPLATE_MIDDLE: number = 11;
export const T_TEMPLATE_TAIL: number = 12;
export const T_OPEN_BRACE: number = 13;
export const T_CLOSE_BRACE: number = 14;
export const T_OPEN_PAREN: number = 15;
export const T_CLOSE_PAREN: number = 16;
export const T_OPEN_BRACKET: number = 17;
export const T_CLOSE_BRACKET: number = 18;
export const T_DOT: number = 19;
export const T_DOT_DOT_DOT: number = 20;
export const T_SEMICOLON: number = 21;
export const T_COMMA: number = 22;
export const T_QUESTION_DOT: number = 23;
export const T_LESS_THAN: number = 24;
export const T_LESS_THAN_SLASH: number = 25;
export const T_GREATER_THAN: number = 26;
export const T_LESS_THAN_EQUALS: number = 27;
export const T_GREATER_THAN_EQUALS: number = 28;
export const T_EQUALS_EQUALS: number = 29;
export const T_EXCLAMATION_EQUALS: number = 30;
export const T_EQUALS_EQUALS_EQUALS: number = 31;
export const T_EXCLAMATION_EQUALS_EQUALS: number = 32;
export const T_EQUALS_GREATER_THAN: number = 33;
export const T_PLUS: number = 34;
export const T_MINUS: number = 35;
export const T_ASTERISK: number = 36;
export const T_ASTERISK_ASTERISK: number = 37;
export const T_SLASH: number = 38;
export const T_PERCENT: number = 39;
export const T_PLUS_PLUS: number = 40;
export const T_MINUS_MINUS: number = 41;
export const T_LESS_THAN_LESS_THAN: number = 42;
export const T_GREATER_THAN_GREATER_THAN: number = 43;
export const T_GREATER_THAN_GREATER_THAN_GREATER_THAN: number = 44;
export const T_AMPERSAND: number = 45;
export const T_BAR: number = 46;
export const T_CARET: number = 47;
export const T_EXCLAMATION: number = 48;
export const T_TILDE: number = 49;
export const T_AMPERSAND_AMPERSAND: number = 50;
export const T_BAR_BAR: number = 51;
export const T_QUESTION: number = 52;
export const T_COLON: number = 53;
export const T_AT: number = 54;
export const T_QUESTION_QUESTION: number = 55;
export const T_EQUALS: number = 56;
export const T_PLUS_EQUALS: number = 57;
export const T_MINUS_EQUALS: number = 58;
export const T_ASTERISK_EQUALS: number = 59;
export const T_ASTERISK_ASTERISK_EQUALS: number = 60;
export const T_SLASH_EQUALS: number = 61;
export const T_PERCENT_EQUALS: number = 62;
export const T_LESS_THAN_LESS_THAN_EQUALS: number = 63;
export const T_GREATER_THAN_GREATER_THAN_EQUALS: number = 64;
export const T_GREATER_THAN_GREATER_THAN_GREATER_THAN_EQUALS: number = 65;
export const T_AMPERSAND_EQUALS: number = 66;
export const T_BAR_EQUALS: number = 67;
export const T_BAR_BAR_EQUALS: number = 68;
export const T_AMPERSAND_AMPERSAND_EQUALS: number = 69;
export const T_QUESTION_QUESTION_EQUALS: number = 70;
export const T_CARET_EQUALS: number = 71;
export const T_IDENTIFIER: number = 72;
export const T_PRIVATE_IDENTIFIER: number = 73;
export const T_BREAK: number = 74;
export const T_CASE: number = 75;
export const T_CATCH: number = 76;
export const T_CLASS: number = 77;
export const T_CONST: number = 78;
export const T_CONTINUE: number = 79;
export const T_DEBUGGER: number = 80;
export const T_DEFAULT: number = 81;
export const T_DELETE: number = 82;
export const T_DO: number = 83;
export const T_ELSE: number = 84;
export const T_ENUM: number = 85;
export const T_EXPORT: number = 86;
export const T_EXTENDS: number = 87;
export const T_FALSE: number = 88;
export const T_FINALLY: number = 89;
export const T_FOR: number = 90;
export const T_FUNCTION: number = 91;
export const T_IF: number = 92;
export const T_IMPORT: number = 93;
export const T_IN: number = 94;
export const T_INSTANCE_OF: number = 95;
export const T_NEW: number = 96;
export const T_NULL: number = 97;
export const T_RETURN: number = 98;
export const T_SUPER: number = 99;
export const T_SWITCH: number = 100;
export const T_THIS: number = 101;
export const T_THROW: number = 102;
export const T_TRUE: number = 103;
export const T_TRY: number = 104;
export const T_TYPE_OF: number = 105;
export const T_VAR: number = 106;
export const T_VOID: number = 107;
export const T_WHILE: number = 108;
export const T_ESCAPED_RESERVED_WORD: number = 109;
export const T_WITH: number = 110;
export const T_IMPLEMENTS: number = 111;
export const T_INTERFACE: number = 112;
export const T_LET: number = 113;
export const T_PACKAGE: number = 114;
export const T_PRIVATE: number = 115;
export const T_PROTECTED: number = 116;
export const T_PUBLIC: number = 117;
export const T_STATIC: number = 118;
export const T_YIELD: number = 119;
export const T_ABSTRACT: number = 120;
export const T_ACCESSOR: number = 121;
export const T_AS: number = 122;
export const T_ASSERTS: number = 123;
export const T_ASSERT: number = 124;
export const T_ANY: number = 125;
export const T_ASYNC: number = 126;
export const T_AWAIT: number = 127;
export const T_BOOLEAN: number = 128;
export const T_CONSTRUCTOR: number = 129;
export const T_DECLARE: number = 130;
export const T_GET: number = 131;
export const T_INFER: number = 132;
export const T_INTRINSIC: number = 133;
export const T_IS: number = 134;
export const T_KEY_OF: number = 135;
export const T_MODULE: number = 136;
export const T_NAMESPACE: number = 137;
export const T_NEVER: number = 138;
export const T_OUT: number = 139;
export const T_READONLY: number = 140;
export const T_REQUIRE: number = 141;
export const T_NUMBER_KEYWORD: number = 142;
export const T_OBJECT: number = 143;
export const T_SATISFIES: number = 144;
export const T_SET: number = 145;
export const T_STRING_KEYWORD: number = 146;
export const T_SYMBOL: number = 147;
export const T_TYPE: number = 148;
export const T_UNDEFINED: number = 149;
export const T_UNIQUE: number = 150;
export const T_UNKNOWN: number = 151;
export const T_USING: number = 152;
export const T_FROM: number = 153;
export const T_GLOBAL: number = 154;
export const T_BIG_INT_KEYWORD: number = 155;
export const T_OVERRIDE: number = 156;
export const T_OF: number = 157;
export const T_DEFER: number = 158;
export const T_COUNT: number = 159;

// Keywords in the order of the Rust table: [text, token]. The text is ASCII.
export const KEYWORDS: [string, number][] = [
["break", T_BREAK],
  ["case", T_CASE],
  ["catch", T_CATCH],
  ["class", T_CLASS],
  ["const", T_CONST],
  ["continue", T_CONTINUE],
  ["debugger", T_DEBUGGER],
  ["default", T_DEFAULT],
  ["delete", T_DELETE],
  ["do", T_DO],
  ["else", T_ELSE],
  ["enum", T_ENUM],
  ["export", T_EXPORT],
  ["extends", T_EXTENDS],
  ["false", T_FALSE],
  ["finally", T_FINALLY],
  ["for", T_FOR],
  ["function", T_FUNCTION],
  ["if", T_IF],
  ["import", T_IMPORT],
  ["in", T_IN],
  ["instanceof", T_INSTANCE_OF],
  ["new", T_NEW],
  ["null", T_NULL],
  ["return", T_RETURN],
  ["super", T_SUPER],
  ["switch", T_SWITCH],
  ["this", T_THIS],
  ["throw", T_THROW],
  ["true", T_TRUE],
  ["try", T_TRY],
  ["typeof", T_TYPE_OF],
  ["var", T_VAR],
  ["void", T_VOID],
  ["while", T_WHILE],
  ["with", T_WITH],
  ["implements", T_IMPLEMENTS],
  ["interface", T_INTERFACE],
  ["let", T_LET],
  ["package", T_PACKAGE],
  ["private", T_PRIVATE],
  ["protected", T_PROTECTED],
  ["public", T_PUBLIC],
  ["static", T_STATIC],
  ["yield", T_YIELD],
  ["abstract", T_ABSTRACT],
  ["accessor", T_ACCESSOR],
  ["as", T_AS],
  ["asserts", T_ASSERTS],
  ["assert", T_ASSERT],
  ["any", T_ANY],
  ["async", T_ASYNC],
  ["await", T_AWAIT],
  ["boolean", T_BOOLEAN],
  ["constructor", T_CONSTRUCTOR],
  ["declare", T_DECLARE],
  ["get", T_GET],
  ["infer", T_INFER],
  ["intrinsic", T_INTRINSIC],
  ["is", T_IS],
  ["keyof", T_KEY_OF],
  ["module", T_MODULE],
  ["namespace", T_NAMESPACE],
  ["never", T_NEVER],
  ["out", T_OUT],
  ["readonly", T_READONLY],
  ["require", T_REQUIRE],
  ["number", T_NUMBER_KEYWORD],
  ["object", T_OBJECT],
  ["satisfies", T_SATISFIES],
  ["set", T_SET],
  ["string", T_STRING_KEYWORD],
  ["symbol", T_SYMBOL],
  ["type", T_TYPE],
  ["undefined", T_UNDEFINED],
  ["unique", T_UNIQUE],
  ["unknown", T_UNKNOWN],
  ["using", T_USING],
  ["from", T_FROM],
  ["global", T_GLOBAL],
  ["bigint", T_BIG_INT_KEYWORD],
  ["override", T_OVERRIDE],
  ["of", T_OF],
  ["defer", T_DEFER],
];

/** `T::is_reserved_word` */
export function isReservedWord(t: number): boolean {
  return t >= T_BREAK && t <= T_WITH;
}
/** `T::is_identifier_or_keyword` (true of a private name too) */
export function isIdentifierOrKeyword(t: number): boolean {
  return t >= T_IDENTIFIER;
}
/** `T::ends_expression` */
export function endsExpression(t: number): boolean {
  return (
    t === T_COMMA || t === T_CLOSE_PAREN || t === T_CLOSE_BRACKET || t === T_CLOSE_BRACE ||
    t === T_SEMICOLON || t === T_COLON || t === T_EOF
  );
}
/** `T::can_follow_member_expression` */
export function canFollowMemberExpression(t: number): boolean {
  return (
    t === T_DOT || t === T_OPEN_BRACE || t === T_OPEN_PAREN || t === T_OPEN_BRACKET || t === T_EXCLAMATION ||
    t === T_QUESTION_DOT || t === T_NO_SUBSTITUTION_TEMPLATE || t === T_TEMPLATE_HEAD || t === T_LESS_THAN ||
    t === T_LESS_THAN_LESS_THAN
  );
}
/** `T::is_assignment_operator` */
export function isAssignmentOperator(t: number): boolean {
  return t >= T_EQUALS && t <= T_CARET_EQUALS;
}
/** `T::is_modifier` */
export function isModifier(t: number): boolean {
  return (
    t === T_ABSTRACT || t === T_ACCESSOR || t === T_ASYNC || t === T_CONST || t === T_DECLARE || t === T_DEFAULT ||
    t === T_EXPORT || t === T_IN || t === T_PUBLIC || t === T_PRIVATE || t === T_PROTECTED || t === T_READONLY ||
    t === T_STATIC || t === T_OUT || t === T_OVERRIDE
  );
}

/** `GetBinaryOperatorPrecedence`: 0 for a token that is not a binary operator. Index with a token kind. */
export const PRECEDENCE = new Uint8Array(T_COUNT);
PRECEDENCE[T_QUESTION_QUESTION] = 1;
PRECEDENCE[T_BAR_BAR] = 2;
PRECEDENCE[T_AMPERSAND_AMPERSAND] = 3;
PRECEDENCE[T_BAR] = 4;
PRECEDENCE[T_CARET] = 5;
PRECEDENCE[T_AMPERSAND] = 6;
PRECEDENCE[T_EQUALS_EQUALS] = 7;
PRECEDENCE[T_EXCLAMATION_EQUALS] = 7;
PRECEDENCE[T_EQUALS_EQUALS_EQUALS] = 7;
PRECEDENCE[T_EXCLAMATION_EQUALS_EQUALS] = 7;
PRECEDENCE[T_LESS_THAN] = 8;
PRECEDENCE[T_GREATER_THAN] = 8;
PRECEDENCE[T_LESS_THAN_EQUALS] = 8;
PRECEDENCE[T_GREATER_THAN_EQUALS] = 8;
PRECEDENCE[T_INSTANCE_OF] = 8;
PRECEDENCE[T_IN] = 8;
PRECEDENCE[T_AS] = 8;
PRECEDENCE[T_SATISFIES] = 8;
PRECEDENCE[T_LESS_THAN_LESS_THAN] = 9;
PRECEDENCE[T_GREATER_THAN_GREATER_THAN] = 9;
PRECEDENCE[T_GREATER_THAN_GREATER_THAN_GREATER_THAN] = 9;
PRECEDENCE[T_PLUS] = 10;
PRECEDENCE[T_MINUS] = 10;
PRECEDENCE[T_ASTERISK] = 11;
PRECEDENCE[T_SLASH] = 11;
PRECEDENCE[T_PERCENT] = 11;
PRECEDENCE[T_ASTERISK_ASTERISK] = 12;

/** `T::binary_precedence` */
export function binaryPrecedence(t: number): number {
  return PRECEDENCE[t] | 0;
}

const PUNCT_TEXT: [number, string][] = [
  [T_OPEN_BRACE, "{"], [T_CLOSE_BRACE, "}"], [T_OPEN_PAREN, "("], [T_CLOSE_PAREN, ")"],
  [T_OPEN_BRACKET, "["], [T_CLOSE_BRACKET, "]"], [T_DOT, "."], [T_DOT_DOT_DOT, "..."], [T_SEMICOLON, ";"],
  [T_COMMA, ","], [T_LESS_THAN, "<"], [T_GREATER_THAN, ">"], [T_EQUALS_GREATER_THAN, "=>"], [T_BAR, "|"],
  [T_QUESTION, "?"], [T_COLON, ":"], [T_AT, "@"], [T_EQUALS, "="],
];

/** `T::text`: the text of a keyword or of the punctuators above, "" otherwise. Debug/diagnostic use only (makes a string). */
export function tokenText(t: number): string {
  for (let i = 0; i < PUNCT_TEXT.length; i++) {
    if (PUNCT_TEXT[i][0] === t) return PUNCT_TEXT[i][1];
  }
  for (let i = 0; i < KEYWORDS.length; i++) {
    if (KEYWORDS[i][1] === t) return KEYWORDS[i][0];
  }
  return "";
}
