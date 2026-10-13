// Port of vendor/bun/src/parsers/yaml.rs, as the formatter uses it: `YAML::parse_as_written`.
//
// What it gives (see docs/PARSERS_API.md): the documents as a tree of what is in what (Rust `&[Expr]`: only null,
// `true` for a scalar, `false` for an alias, arrays and objects) and the tokens (Rust `&[SourceToken]`) as byte ranges
// of the text. What a scalar means is not looked at, so the parts of the Rust parser that build values (scalar
// resolution, anchors, aliases, merge keys, the alias budgets, tags) are gone; everything that decides whether a text
// is YAML, and where an error is, is ported branch for branch.
//
// Storage is per thread (module state), reset - not reallocated - per call. No JS strings for source text.
// A syntax error is a return value (`yamlParseAsWritten` returns the error kind, `yamlErrorPos` says where).

// ---------------------------------------------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------------------------------------------

// Rust `ParseError` (only those that `parse_as_written` can return; `UnresolvedAlias`, `ExcessiveAliasing`,
// `CyclicAlias` and `CyclicMerge` need values and cannot happen).
export const PE_NONE = 0;
export const PE_OUT_OF_MEMORY = 1;
export const PE_UNEXPECTED_TOKEN = 2;
export const PE_UNEXPECTED_EOF = 3;
export const PE_INVALID_DIRECTIVE = 4;
export const PE_UNEXPECTED_CHARACTER = 5;
export const PE_TAB_INDENTATION = 6;
export const PE_UNRESOLVED_TAG_HANDLE = 7;
export const PE_UNRESOLVED_ALIAS = 8;
export const PE_MULTILINE_IMPLICIT_KEY = 9;
export const PE_MULTIPLE_ANCHORS = 10;
export const PE_MULTIPLE_TAGS = 11;
export const PE_UNEXPECTED_DOCUMENT_START = 12;
export const PE_UNEXPECTED_DOCUMENT_END = 13;
export const PE_MULTIPLE_YAML_DIRECTIVES = 14;
export const PE_STACK_OVERFLOW = 15;

export function parseErrorName(e: number): string {
  switch (e) {
    case PE_NONE: return "None";
    case PE_OUT_OF_MEMORY: return "OutOfMemory";
    case PE_UNEXPECTED_TOKEN: return "UnexpectedToken";
    case PE_UNEXPECTED_EOF: return "UnexpectedEof";
    case PE_INVALID_DIRECTIVE: return "InvalidDirective";
    case PE_UNEXPECTED_CHARACTER: return "UnexpectedCharacter";
    case PE_TAB_INDENTATION: return "TabIndentation";
    case PE_UNRESOLVED_TAG_HANDLE: return "UnresolvedTagHandle";
    case PE_UNRESOLVED_ALIAS: return "UnresolvedAlias";
    case PE_MULTILINE_IMPLICIT_KEY: return "MultilineImplicitKey";
    case PE_MULTIPLE_ANCHORS: return "MultipleAnchors";
    case PE_MULTIPLE_TAGS: return "MultipleTags";
    case PE_UNEXPECTED_DOCUMENT_START: return "UnexpectedDocumentStart";
    case PE_UNEXPECTED_DOCUMENT_END: return "UnexpectedDocumentEnd";
    case PE_MULTIPLE_YAML_DIRECTIVES: return "MultipleYamlDirectives";
    case PE_STACK_OVERFLOW: return "StackOverflow";
    default: return "?";
  }
}

// Rust `SourceTokenKind` (same order).
export const TK_COMMENT = 0;
export const TK_DIRECTIVE = 1; // the `%` of a directive
export const TK_DOCUMENT_START = 2;
export const TK_DOCUMENT_END = 3;
export const TK_SEQUENCE_ENTRY = 4;
export const TK_MAPPING_KEY = 5;
export const TK_MAPPING_VALUE = 6;
export const TK_COLLECT_ENTRY = 7;
export const TK_SEQUENCE_START = 8;
export const TK_SEQUENCE_END = 9;
export const TK_MAPPING_START = 10;
export const TK_MAPPING_END = 11;
export const TK_ANCHOR = 12;
export const TK_ALIAS = 13;
export const TK_TAG = 14;
// With its quotes. Of a block scalar: from its `|` or `>` to where the next token can start.
export const TK_SCALAR = 15;
// Internal only (never listed): the end of the text, and `@` / backtick.
const TK_EOF = 16;
const TK_RESERVED = 17;

export function tokenKindName(k: number): string {
  switch (k) {
    case TK_COMMENT: return "Comment";
    case TK_DIRECTIVE: return "Directive";
    case TK_DOCUMENT_START: return "DocumentStart";
    case TK_DOCUMENT_END: return "DocumentEnd";
    case TK_SEQUENCE_ENTRY: return "SequenceEntry";
    case TK_MAPPING_KEY: return "MappingKey";
    case TK_MAPPING_VALUE: return "MappingValue";
    case TK_COLLECT_ENTRY: return "CollectEntry";
    case TK_SEQUENCE_START: return "SequenceStart";
    case TK_SEQUENCE_END: return "SequenceEnd";
    case TK_MAPPING_START: return "MappingStart";
    case TK_MAPPING_END: return "MappingEnd";
    case TK_ANCHOR: return "Anchor";
    case TK_ALIAS: return "Alias";
    case TK_TAG: return "Tag";
    case TK_SCALAR: return "Scalar";
    default: return "?";
  }
}

// Kinds of a node of the tree (Rust `Expr` data): `ENull`, `EBoolean(true)` (a scalar), `EBoolean(false)` (an alias),
// `EObject`, `EArray`.
export const NK_NULL = 0;
export const NK_SCALAR = 1;
export const NK_ALIAS = 2;
export const NK_OBJECT = 3;
export const NK_ARRAY = 4;

// The leaves are shared: node ids 0, 1 and 2.
export const NODE_NULL = 0;
export const NODE_SCALAR = 1;
export const NODE_ALIAS = 2;

// ---------------------------------------------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------------------------------------------

// Rust `Context`
const C_BLOCK_OUT = 0;
const C_BLOCK_IN = 1;
const C_FLOW_IN = 2;
const C_FLOW_KEY = 3;

// Style of the scalar token that has been scanned (Rust `ScalarStyle`, with the `multiline` of `Plain`).
const ST_PLAIN = 0;
const ST_PLAIN_MULTILINE = 1;
const ST_BLOCK = 2;
const ST_QUOTED = 3;

// Rust `BlockIndentedKind`
const BI_SEQ_ENTRY = 0;
const BI_MAP_EXPLICIT_KEY = 1;
const BI_MAP_VALUE = 2;

// Rust `FirstChar`
const FC_POSITIVE = 0;
const FC_NEGATIVE = 1;
const FC_DOT = 2;
const FC_OTHER = 3;

// Rust `Directive`
const DIR_YAML = 1;
const DIR_OTHER = 2;

const DEFAULT_MAX_DEPTH = 1000;

// ---------------------------------------------------------------------------------------------------------------
// Character tables (Rust `chars`, for the `Utf8` encoding)
// ---------------------------------------------------------------------------------------------------------------

// ns-char: 0x21..=0x7E and every byte >= 0x80.
const NS_CHAR = new Uint8Array(256);
// ns-word-char: [0-9A-Za-z-]
const NS_WORD = new Uint8Array(256);
// ns-anchor-char: ns-char minus c-flow-indicator
const NS_ANCHOR = new Uint8Array(256);
// ns-hex-digit
const HEX = new Uint8Array(256);
// A single byte that is an ns-tag-char (except `%`, which is three bytes).
const TAG_CHAR = new Uint8Array(256);
// A single byte that is an ns-uri-char (except `%`).
const URI_CHAR = new Uint8Array(256);
// The bytes that a plain scalar has to look at (everything else is appended).
const PLAIN_SPECIAL = new Uint8Array(256);

function initTables(): void {
  for (let c = 0x21; c <= 0x7e; c++) NS_CHAR[c] = 1;
  for (let c = 0x80; c <= 0xff; c++) NS_CHAR[c] = 1;
  for (let c = 0x30; c <= 0x39; c++) { NS_WORD[c] = 1; HEX[c] = 1; }
  for (let c = 0x41; c <= 0x5a; c++) NS_WORD[c] = 1;
  for (let c = 0x61; c <= 0x7a; c++) NS_WORD[c] = 1;
  NS_WORD[0x2d] = 1;
  for (let c = 0x41; c <= 0x46; c++) HEX[c] = 1;
  for (let c = 0x61; c <= 0x66; c++) HEX[c] = 1;
  for (let c = 0; c < 256; c++) {
    if (NS_CHAR[c] === 1 && c !== 0x2c && c !== 0x5b && c !== 0x5d && c !== 0x7b && c !== 0x7d) NS_ANCHOR[c] = 1;
    if (NS_WORD[c] === 1) { TAG_CHAR[c] = 1; URI_CHAR[c] = 1; }
  }
  // '#' ';' '/' '?' ':' '@' '&' '=' '+' '$' '_' '.' '~' '*' '\'' '(' ')'
  const tagChars = [0x23, 0x3b, 0x2f, 0x3f, 0x3a, 0x40, 0x26, 0x3d, 0x2b, 0x24, 0x5f, 0x2e, 0x7e, 0x2a, 0x27, 0x28, 0x29];
  for (let i = 0; i < tagChars.length; i++) { const tc = tagChars[i] | 0; TAG_CHAR[tc] = 1; URI_CHAR[tc] = 1; }
  // ns-uri-char also has ',' '!' '[' ']'
  URI_CHAR[0x2c] = 1; URI_CHAR[0x21] = 1; URI_CHAR[0x5b] = 1; URI_CHAR[0x5d] = 1;
  // NUL, white space, line breaks, and the bytes that a plain scalar treats on their own.
  const special = [0x00, 0x20, 0x09, 0x0a, 0x0d, 0x3a, 0x23, 0x2c, 0x5b, 0x5d, 0x7b, 0x7d, 0x2d, 0x2e];
  for (let i = 0; i < special.length; i++) PLAIN_SPECIAL[special[i] | 0] = 1;
}
initTables();

// ---------------------------------------------------------------------------------------------------------------
// Per-thread storage
// ---------------------------------------------------------------------------------------------------------------

const EMPTY = new Uint8Array(0);

// Input
let src: Uint8Array = EMPTY;
let n = 0;

// The cursor (Rust `Parser` fields)
let pos = 0;
let lineStartPos = 0;
let lineIndent = 0;
let tabAfterIndent = false;
let line = 1;

// The current token (Rust `Parser::token`): its kind (`TK_*` + `TK_EOF`/`TK_RESERVED`), start, indent, line, and for a
// scalar its style.
let tKind = TK_EOF;
let tStart = 0;
let tIndent = 0;
let tLine = 1;
let tStyle = ST_PLAIN;

// Rust `ContextStack`
let ctxStack = new Uint8Array(256);
let ctxLen = 0;
let ctxTop = C_BLOCK_OUT; // cached top, BLOCK-OUT if empty

// Rust `IndentStack`
let biStack = new Int32Array(256);
let biLen = 0;

// Line of the `---` of the document, or -1.
let explicitDocLine = -1;

// `%TAG` handles of the document: pairs (start, end) of the text.
let thRanges = new Int32Array(32);
let thLen = 0;

// Recursion depth of `parseNode`
let depth = 0;
let maxDepth = DEFAULT_MAX_DEPTH;

// The error
let errKind = PE_NONE;
let errPosValue = 0;

// The state of the plain scalar that is being scanned (Rust `ScalarResolverCtx`, without its value)
let sStarted = false; // `str_builder.len() > 0`
let sResolved = false;
let sLine = 1;
let sIndent = 0;
let sMultiline = false;

// The tokens (Rust `Parser::written`)
let tokKind = new Uint8Array(1024);
let tokStart = new Int32Array(1024);
let tokEnd = new Int32Array(1024);
let tokCount = 0;

// The tree: nodes 0, 1, 2 are the shared leaves. A collection's children are in `pool[nChild[id] ..][0 .. nCount[id]]`
// (for an object: key, value, key, value, ..; `nCount` is the number of properties).
let nodeKind = new Uint8Array(1024);
let nodeLoc = new Int32Array(1024);
let nodeChild = new Int32Array(1024);
let nodeCount = new Int32Array(1024);
let nodeLen = 3;
let pool = new Int32Array(1024);
let poolLen = 0;
// Children of the collections that are being parsed.
let cs = new Int32Array(1024);
let csLen = 0;
// The roots of the documents.
let docs = new Int32Array(16);
let docLen = 0;

nodeKind[NODE_NULL] = NK_NULL;
nodeKind[NODE_SCALAR] = NK_SCALAR;
nodeKind[NODE_ALIAS] = NK_ALIAS;

// ---------------------------------------------------------------------------------------------------------------
// Growable arrays
// ---------------------------------------------------------------------------------------------------------------

function growTokens(): void {
  const cap = tokKind.length * 2;
  const k = new Uint8Array(cap);
  k.set(tokKind);
  tokKind = k;
  const s = new Int32Array(cap);
  s.set(tokStart);
  tokStart = s;
  const e = new Int32Array(cap);
  e.set(tokEnd);
  tokEnd = e;
}

function growNodes(): void {
  const cap = nodeKind.length * 2;
  const k = new Uint8Array(cap);
  k.set(nodeKind);
  nodeKind = k;
  const l = new Int32Array(cap);
  l.set(nodeLoc);
  nodeLoc = l;
  const c = new Int32Array(cap);
  c.set(nodeChild);
  nodeChild = c;
  const m = new Int32Array(cap);
  m.set(nodeCount);
  nodeCount = m;
}

function growPool(need: number): void {
  let cap = pool.length * 2;
  while (cap < need) cap = cap * 2;
  const p = new Int32Array(cap);
  p.set(pool);
  pool = p;
}

function growCs(): void {
  const c = new Int32Array(cs.length * 2);
  c.set(cs);
  cs = c;
}

function growCtx(): void {
  const c = new Uint8Array(ctxStack.length * 2);
  c.set(ctxStack);
  ctxStack = c;
}

function growBi(): void {
  const c = new Int32Array(biStack.length * 2);
  c.set(biStack);
  biStack = c;
}

function growDocs(): void {
  const c = new Int32Array(docs.length * 2);
  c.set(docs);
  docs = c;
}

function growTh(): void {
  const c = new Int32Array(thRanges.length * 2);
  c.set(thRanges);
  thRanges = c;
}

// ---------------------------------------------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------------------------------------------

function newCollection(kind: number, loc: number): number {
  if (nodeLen === nodeKind.length) growNodes();
  const id = nodeLen;
  nodeLen = id + 1;
  nodeKind[id] = kind | 0;
  nodeLoc[id] = loc | 0;
  nodeChild[id] = 0;
  nodeCount[id] = 0;
  return id;
}

function push(v: number): void {
  if (csLen === cs.length) growCs();
  cs[csLen] = v | 0;
  csLen = csLen + 1;
}

function pushPair(k: number, v: number): void {
  if (csLen + 2 > cs.length) growCs();
  cs[csLen] = k | 0;
  cs[csLen + 1] = v | 0;
  csLen = csLen + 2;
}

// Moves cs[base ..] into the pool as the children of `id`. `width`: 1 (array) or 2 (object).
function finishCollection(id: number, base: number, width: number): void {
  const count = csLen - base;
  if (poolLen + count > pool.length) growPool(poolLen + count);
  const p = pool;
  const c = cs;
  const at = poolLen;
  for (let i = 0; i < count; i++) p[at + i] = c[base + i] | 0;
  poolLen = at + count;
  nodeChild[id] = at | 0;
  nodeCount[id] = (width === 2 ? count >> 1 : count) | 0;
  csLen = base;
}

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------

function fail(kind: number): number {
  errKind = kind | 0;
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------
// Context and indent stacks
// ---------------------------------------------------------------------------------------------------------------

function ctxPush(c: number): void {
  if (ctxLen === ctxStack.length) growCtx();
  ctxStack[ctxLen] = c | 0;
  ctxLen = ctxLen + 1;
  ctxTop = c | 0;
}

function ctxPop(): void {
  ctxLen = ctxLen - 1;
  ctxTop = ctxLen > 0 ? ctxStack[ctxLen - 1] | 0 : C_BLOCK_OUT;
}

function isFlowCtx(): boolean {
  return ctxTop === C_FLOW_IN || ctxTop === C_FLOW_KEY;
}

function biPush(v: number): void {
  if (biLen === biStack.length) growBi();
  biStack[biLen] = v | 0;
  biLen = biLen + 1;
}

function biPop(): void {
  biLen = biLen - 1;
}

// ---------------------------------------------------------------------------------------------------------------
// The tokens that have been scanned (Rust `note_written`)
// ---------------------------------------------------------------------------------------------------------------

// Lists a token from `start` to the cursor, in the place of one that starts there too: that has been scanned again.
// The comment behind the header of a block scalar has been listed before the scalar.
function noteWritten(kind: number, start: number): void {
  const end = pos;
  const count = tokCount;
  if (count === 0 || tokStart[count - 1] < start) {
    if (count === tokKind.length) growTokens();
    tokKind[count] = kind | 0;
    tokStart[count] = start | 0;
    tokEnd[count] = end | 0;
    tokCount = count + 1;
    return;
  }
  let at = tokCount;
  while (at > 0 && tokStart[at - 1] >= start) at = at - 1;
  if (at < tokCount && tokStart[at] === start) {
    tokKind[at] = kind | 0;
    tokEnd[at] = end | 0;
    return;
  }
  if (tokCount === tokKind.length) growTokens();
  if (at < tokCount) {
    tokKind.copyWithin(at + 1, at, tokCount);
    tokStart.copyWithin(at + 1, at, tokCount);
    tokEnd.copyWithin(at + 1, at, tokCount);
  }
  tokKind[at] = kind | 0;
  tokStart[at] = start | 0;
  tokEnd[at] = end | 0;
  tokCount = tokCount + 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------------------------------------------

// Rust `next()`: the unit at the cursor, NUL at the end.
function nx(): number {
  return pos < n ? src[pos] | 0 : 0;
}

// Rust `peek(k)`
function pk(k: number): number {
  const p = pos + k;
  return p < n ? src[p] | 0 : 0;
}

// Rust `inc(k)`
function inc(k: number): void {
  const p = pos + k;
  pos = p < n ? p : n;
}

// Rust `newline()`: every caller is `newline(); inc(1);` with the cursor at the line break.
function newline(): void {
  lineIndent = 0;
  tabAfterIndent = false;
  lineStartPos = pos + 1;
  line = line + 1;
}

function isEof(): boolean {
  return pos >= n;
}

function isAtLineStart(): boolean {
  return pos === lineStartPos;
}

function isSWhite(): boolean {
  if (pos < n) {
    const c = src[pos] | 0;
    return c === 0x20 || c === 0x09;
  }
  return false;
}

function isSWhiteAt(k: number): boolean {
  const p = pos + k;
  if (p < n) {
    const c = src[p] | 0;
    return c === 0x20 || c === 0x09;
  }
  return false;
}

function skipSWhite(): void {
  let p = pos;
  const e = n;
  const s = src;
  while (p < e) {
    const c = s[p] | 0;
    if (c !== 0x20 && c !== 0x09) break;
    p = p + 1;
  }
  pos = p;
}

function isBCharOrEof(): boolean {
  if (pos < n) {
    const c = src[pos] | 0;
    return c === 0x0a || c === 0x0d;
  }
  return true;
}

function isBChar(): boolean {
  if (pos < n) {
    const c = src[pos] | 0;
    return c === 0x0a || c === 0x0d;
  }
  return false;
}

// Rust `is_s_white_or_b_char_or_eof_at`
function isSWhiteOrBCharOrEofAt(k: number): boolean {
  const p = pos + k;
  if (p < n) {
    const c = src[p] | 0;
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
  }
  return true;
}

// Rust `is_s_white_or_b_char_at`
function isSWhiteOrBCharAt(k: number): boolean {
  const p = pos + k;
  if (p < n) {
    const c = src[p] | 0;
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
  }
  return false;
}

// Rust `is_any_or_eof_at(" \t\n\r", k)`
function isWhiteOrBreakOrEofAt(k: number): boolean {
  return isSWhiteOrBCharOrEofAt(k);
}

function isNsChar(): boolean {
  return pos < n && NS_CHAR[src[pos] | 0] === 1;
}

function isNsWordChar(): boolean {
  return pos < n && NS_WORD[src[pos] | 0] === 1;
}

function isNsAnchorChar(): boolean {
  return pos < n && NS_ANCHOR[src[pos] | 0] === 1;
}

function isNsDecDigit(): boolean {
  if (pos < n) {
    const c = src[pos] | 0;
    return c >= 0x30 && c <= 0x39;
  }
  return false;
}

function isChar(c: number): boolean {
  return pos < n && (src[pos] | 0) === c;
}

// Rust `chars::is_ns_tag_char(remain)`: the length of the ns-tag-char at the cursor, 0 if there is none.
function isNsTagChar(): number {
  if (pos >= n) return 0;
  const c0 = src[pos] | 0;
  if (TAG_CHAR[c0] === 1) return 1;
  if (c0 === 0x25 && n - pos > 2 && HEX[src[pos + 1] | 0] === 1 && HEX[src[pos + 2] | 0] === 1) return 3;
  return 0;
}

// Rust `chars::is_ns_uri_char(remain)`
function isNsUriChar(): boolean {
  if (pos >= n) return false;
  const c0 = src[pos] | 0;
  if (URI_CHAR[c0] === 1) return true;
  return c0 === 0x25 && n - pos > 2 && HEX[src[pos + 1] | 0] === 1 && HEX[src[pos + 2] | 0] === 1;
}

function skipNsUriChars(): void {
  while (isNsUriChar()) inc(1);
}

function skipNsTagChars(): void {
  for (;;) {
    const len = isNsTagChar();
    if (len === 0) return;
    inc(len);
  }
}

function skipNsChars(): void {
  let p = pos;
  const e = n;
  const s = src;
  while (p < e && NS_CHAR[s[p] | 0] === 1) p = p + 1;
  pos = p;
}

// The `try_*` helpers return true if they succeeded; on false the error is set.
function trySkipChar(c: number): boolean {
  if (!isChar(c)) { fail(PE_UNEXPECTED_CHARACTER); return false; }
  inc(1);
  return true;
}

function trySkipSWhite(): boolean {
  if (!isSWhite()) { fail(PE_UNEXPECTED_CHARACTER); return false; }
  skipSWhite();
  return true;
}

function trySkipNsDecDigits(): boolean {
  if (!isNsDecDigit()) { fail(PE_UNEXPECTED_CHARACTER); return false; }
  while (isNsDecDigit()) inc(1);
  return true;
}

function trySkipNsWordChars(): boolean {
  if (!isNsWordChar()) { fail(PE_UNEXPECTED_CHARACTER); return false; }
  while (isNsWordChar()) inc(1);
  return true;
}

function trySkipNsChars(): boolean {
  if (!isNsChar()) { fail(PE_UNEXPECTED_CHARACTER); return false; }
  skipNsChars();
  return true;
}

function trySkipNsTagChars(): boolean {
  const first = isNsTagChar();
  if (first === 0) { fail(PE_UNEXPECTED_CHARACTER); return false; }
  inc(first);
  skipNsTagChars();
  return true;
}

function trySkipNsAnchorChars(): boolean {
  if (!isNsAnchorChar()) { fail(PE_UNEXPECTED_CHARACTER); return false; }
  inc(1);
  while (isNsAnchorChar()) inc(1);
  return true;
}

// Rust `try_skip_to_new_line` (s-l-comments): positions the cursor on the next line break, or the end.
function trySkipToNewLine(): boolean {
  let whitespace = false;
  if (isSWhite()) {
    whitespace = true;
    skipSWhite();
  }
  if (isChar(0x23)) {
    if (!whitespace) { fail(PE_UNEXPECTED_CHARACTER); return false; }
    const start = pos;
    inc(1);
    if (!skipCommentBody()) return false;
    noteWritten(TK_COMMENT, start);
  }
  if (pos < n && !isChar(0x0a) && !isChar(0x0d)) { fail(PE_UNEXPECTED_CHARACTER); return false; }
  return true;
}

// Skips to the line break, or the end. false (error set) at a NUL that is not the end.
function skipCommentBody(): boolean {
  let p = pos;
  const e = n;
  const s = src;
  while (p < e) {
    const c = s[p] | 0;
    if (c === 0x0a || c === 0x0d) break;
    if (c === 0) { pos = p; fail(PE_UNEXPECTED_CHARACTER); return false; }
    p = p + 1;
  }
  pos = p;
  return true;
}

// Rust `fold_lines`
function foldLines(): number {
  let total = 0;
  let p = pos;
  const e = n;
  const s = src;
  for (;;) {
    const c = p < e ? s[p] | 0 : 0;
    if (c === 0x0a || c === 0x0d) {
      // (a CRLF is one line break)
      if (c === 0x0d && p + 1 < e && (s[p + 1] | 0) === 0x0a) p = p + 1;
      total = total + 1;
      // newline(); inc(1)
      lineIndent = 0;
      tabAfterIndent = false;
      lineStartPos = p + 1;
      line = line + 1;
      p = p + 1;
    } else if (c === 0x20) {
      let indent = 1;
      p = p + 1;
      while (p < e && (s[p] | 0) === 0x20) {
        p = p + 1;
        indent = indent + 1;
      }
      lineIndent = indent;
      if (p < e && (s[p] | 0) === 0x09) tabAfterIndent = true;
      while (p < e) {
        const d = s[p] | 0;
        if (d !== 0x20 && d !== 0x09) break;
        p = p + 1;
      }
    } else if (c === 0x09) {
      // there's no indentation, but we still skip the white space
      tabAfterIndent = true;
      p = p + 1;
      while (p < e) {
        const d = s[p] | 0;
        if (d !== 0x20 && d !== 0x09) break;
        p = p + 1;
      }
    } else {
      pos = p;
      return total;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scalars: numbers (which decide whether a plain scalar has `resolved`)
// ---------------------------------------------------------------------------------------------------------------

// Rust `ScalarResolverCtx::check_append`
function checkAppend(): void {
  if (!sStarted) {
    sIndent = lineIndent;
    sLine = line;
  } else if (sLine !== line) {
    sMultiline = true;
  }
}

// Rust `ctx.append_source`
function appendSource(): void {
  checkAppend();
  sStarted = true;
}

// Rust `ctx.resolve`: the text has been seen to be a scalar of its own (`null`, `true`, `.inf`, ..).
function resolveMark(): void {
  sStarted = true;
  sResolved = true;
}

// Rust `is_core_schema_number`: `[-+]? ( \. [0-9]+ | [0-9]+ ( \. [0-9]* )? ) ( [eE] [-+]? [0-9]+ )?` of src[s, e).
function isCoreSchemaNumber(s: number, e: number, fc: number): boolean {
  let i = s;
  const len = e;
  let sawLeadingDot = fc === FC_DOT;
  if (!sawLeadingDot && i < len && (src[i] | 0) === 0x2e) {
    i = i + 1;
    sawLeadingDot = true;
  }
  if (sawLeadingDot) {
    if (i >= len || !isDigit(src[i] | 0)) return false;
    while (i < len && isDigit(src[i] | 0)) i = i + 1;
  } else {
    if (i >= len || !isDigit(src[i] | 0)) return false;
    while (i < len && isDigit(src[i] | 0)) i = i + 1;
    if (i < len && (src[i] | 0) === 0x2e) {
      i = i + 1;
      while (i < len && isDigit(src[i] | 0)) i = i + 1;
    }
  }
  if (i < len) {
    const c = src[i] | 0;
    if (c === 0x65 || c === 0x45) {
      i = i + 1;
      if (i < len) {
        const d = src[i] | 0;
        if (d === 0x2b || d === 0x2d) i = i + 1;
      }
      if (i >= len || !isDigit(src[i] | 0)) return false;
      while (i < len && isDigit(src[i] | 0)) i = i + 1;
    }
  }
  return i === len;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

// Rust `parse_unsigned_radix0::<u64>`: Zig's `parseUnsigned(u64, s, 0)`. Whether src[s, e) is a u64.
function isUnsignedRadix0(s: number, e: number): boolean {
  if (s >= e) return false;
  let i = s;
  let neg = false;
  const c0 = src[i] | 0;
  if (c0 === 0x2b) i = i + 1;
  else if (c0 === 0x2d) {
    neg = true;
    i = i + 1;
  }
  if (i >= e) return false;
  let base = 10;
  if (e - i > 2 && (src[i] | 0) === 0x30) {
    const p = (src[i + 1] | 0) | 0x20;
    if (p === 0x62) { base = 2; i = i + 2; }
    else if (p === 0x6f) { base = 8; i = i + 2; }
    else if (p === 0x78) { base = 16; i = i + 2; }
  }
  // x = hi * 2^32 + lo, as long as it fits 64 bits
  let hi = 0;
  let lo = 0;
  for (; i < e; i++) {
    const c = src[i] | 0;
    let d = 99;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x7a) d = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x5a) d = c - 0x41 + 10;
    if (d >= base) return false;
    if (neg) {
      // 0 - digit underflows unless it is 0 all along
      if (hi !== 0 || lo !== 0 || d !== 0) return false;
      continue;
    }
    const t = lo * base + d;
    const carry = Math.floor(t / 4294967296);
    lo = t - carry * 4294967296;
    hi = hi * base + carry;
    if (hi >= 4294967296) return false;
  }
  return true;
}

// Rust `ScalarResolverCtx::try_resolve_number`. The cursor is at the first byte of the body (the sign has been
// consumed by the caller). Moves the cursor over what looks like a number and says whether it resolved.
function tryResolveNumber(fc: number): void {
  if (fc === FC_DOT) {
    const c = nx();
    if (c === 0x6e) {
      inc(1);
      if (pk(0) === 0x61 && pk(1) === 0x6e) {
        resolveMark();
        inc(2);
        return;
      }
      appendSource();
      return;
    } else if (c === 0x4e) {
      inc(1);
      if ((pk(0) === 0x61 && pk(1) === 0x4e) || (pk(0) === 0x41 && pk(1) === 0x4e)) {
        resolveMark();
        inc(2);
        return;
      }
      appendSource();
      return;
    } else if (c === 0x69) {
      inc(1);
      if (pk(0) === 0x6e && pk(1) === 0x66) {
        resolveMark();
        inc(2);
        return;
      }
      appendSource();
      return;
    } else if (c === 0x49) {
      inc(1);
      if ((pk(0) === 0x6e && pk(1) === 0x66) || (pk(0) === 0x4e && pk(1) === 0x46)) {
        resolveMark();
        inc(2);
        return;
      }
      appendSource();
      return;
    }
  } else if (fc === FC_NEGATIVE || fc === FC_POSITIVE) {
    if (nx() === 0x2e && (pk(1) === 0x69 || pk(1) === 0x49)) {
      appendSource();
      inc(1);
      const c = nx();
      if (c === 0x69) {
        inc(1);
        if (pk(0) === 0x6e && pk(1) === 0x66) {
          resolveMark();
          inc(2);
          return;
        }
        appendSource();
        return;
      } else if (c === 0x49) {
        inc(1);
        if ((pk(0) === 0x6e && pk(1) === 0x66) || (pk(0) === 0x4e && pk(1) === 0x46)) {
          resolveMark();
          inc(2);
          return;
        }
        appendSource();
        return;
      }
      return;
    }
  }

  const start = pos;
  let decimal = nx() === 0x2e;
  let x = false;
  let o = false;
  let hex = false;
  let e = false;
  let minus = false;
  if ((fc !== FC_NEGATIVE && fc !== FC_POSITIVE) || decimal) inc(1);
  let first = true;
  let valid = false;
  let end = pos;
  // labeled-switch loop
  for (;;) {
    const c = nx();
    if (c === 0x20 || c === 0x09 || c === 0 || c === 0x0a || c === 0x0d || c === 0x3a) {
      // can only be valid if it ends on a space, a tab, the end, a line break or ':'
      end = pos;
      valid = !(first && (fc === FC_POSITIVE || fc === FC_NEGATIVE));
      break;
    } else if (c === 0x2c || c === 0x5d || c === 0x7d) {
      end = pos;
      // it's valid for ',' ']' '}' to end the scalar in flow context
      valid = ctxTop === C_FLOW_IN || ctxTop === C_FLOW_KEY;
      break;
    } else if (c === 0x30) {
      const wasFirst = first;
      first = false;
      inc(1);
      if (wasFirst) {
        const d = nx();
        if (d === 0x62 || d === 0x42) {
          end = pos;
          valid = false;
          break;
        }
      }
    } else if (c >= 0x31 && c <= 0x39) {
      first = false;
      inc(1);
    } else if (c === 0x65 || c === 0x45) {
      first = false;
      if (e) hex = true;
      e = true;
      inc(1);
    } else if ((c >= 0x61 && c <= 0x64) || c === 0x66 || (c >= 0x41 && c <= 0x44) || c === 0x46) {
      hex = true;
      if (first) {
        if (c === 0x62 || c === 0x42) {
          end = pos;
          valid = false;
          break;
        }
      }
      first = false;
      inc(1);
    } else if (c === 0x78) {
      first = false;
      if (x) {
        end = pos;
        valid = false;
        break;
      }
      x = true;
      inc(1);
    } else if (c === 0x6f) {
      first = false;
      if (o) {
        end = pos;
        valid = false;
        break;
      }
      o = true;
      inc(1);
    } else if (c === 0x2e) {
      first = false;
      if (decimal) {
        end = pos;
        valid = false;
        break;
      }
      decimal = true;
      inc(1);
    } else if (c === 0x2b) {
      first = false;
      if (x) {
        end = pos;
        valid = false;
        break;
      }
      inc(1);
    } else if (c === 0x2d) {
      first = false;
      if (minus) {
        end = pos;
        valid = false;
        break;
      }
      minus = true;
      inc(1);
    } else {
      end = pos;
      valid = false;
      break;
    }
  }

  // append_unknown_source_slice: the first byte that is not white space starts the scalar
  if (end > start) appendSource();
  if (!valid) return;
  if (x || o || hex) {
    if (!isUnsignedRadix0(start, end)) return;
  } else if (!isCoreSchemaNumber(start, end, fc)) {
    return;
  }
  sResolved = true;
}

// ---------------------------------------------------------------------------------------------------------------
// Scanning plain scalars
// ---------------------------------------------------------------------------------------------------------------

// Rust `scan_plain_scalar`. Sets the token. The cursor is at its first byte. The cursor and the state of the scalar
// (Rust `ScalarResolverCtx`) are in locals; the number scanner takes them from the module variables `s*` and gives them
// back.
function scanPlainScalar(): number {
  const s = src;
  const e = n;
  const t = PLAIN_SPECIAL;
  const start = pos;
  let p = start;
  let started = false; // `str_builder.len() > 0`
  let resolved = false;
  let multiline = false;
  let cLine = line;
  let cIndent = lineIndent;
  const flow = ctxTop === C_FLOW_IN || ctxTop === C_FLOW_KEY;

  for (;;) {
    // The bytes that need no care are appended in one go.
    if (started && p < e && t[s[p] | 0] === 0) {
      // check_append once: the line cannot change in the run
      if (cLine !== line) multiline = true;
      p = p + 1;
      while (p < e && t[s[p] | 0] === 0) p = p + 1;
    }
    const c = p < e ? s[p] | 0 : 0;
    switch (c) {
      case 0: {
        pos = p;
        if (p < e) return fail(PE_UNEXPECTED_CHARACTER);
        return doneScalar(start, cIndent, cLine, multiline);
      }
      case 0x2d: { // '-'
        // [203] c-directives-end is line-starting at column 0.
        if (p === lineStartPos && lineIndent === 0 && (s[p + 1] | 0) === 0x2d && (s[p + 2] | 0) === 0x2d && (p + 3 >= e || isWsOrBreak(s[p + 3] | 0))) {
          pos = p;
          return doneScalar(start, cIndent, cLine, multiline);
        }
        // append_source
        if (!started) {
          cIndent = lineIndent;
          cLine = line;
        } else if (cLine !== line) {
          multiline = true;
        }
        const first = !resolved && !started;
        started = true;
        p = p + 1;
        if (first) {
          pos = p;
          sStarted = true; sResolved = false; sMultiline = multiline; sLine = cLine; sIndent = cIndent;
          tryResolveNumber(FC_NEGATIVE);
          p = pos; resolved = sResolved; multiline = sMultiline; cLine = sLine; cIndent = sIndent;
        }
        continue;
      }
      case 0x2e: { // '.'
        if (p === lineStartPos && lineIndent === 0 && (s[p + 1] | 0) === 0x2e && (s[p + 2] | 0) === 0x2e && (p + 3 >= e || isWsOrBreak(s[p + 3] | 0))) {
          pos = p;
          return doneScalar(start, cIndent, cLine, multiline);
        }
        if (!resolved && !started) {
          const d = p + 1 < e ? s[p + 1] | 0 : 0;
          let fc = FC_OTHER;
          if (d === 0x6e || d === 0x4e || d === 0x69 || d === 0x49) {
            // append_source, then the cursor moves on
            cIndent = lineIndent;
            cLine = line;
            started = true;
            p = p + 1;
            fc = FC_DOT;
          }
          pos = p;
          sStarted = started; sResolved = false; sMultiline = multiline; sLine = cLine; sIndent = cIndent;
          tryResolveNumber(fc);
          p = pos; started = sStarted; resolved = sResolved; multiline = sMultiline; cLine = sLine; cIndent = sIndent;
          continue;
        }
        if (!started) {
          cIndent = lineIndent;
          cLine = line;
        } else if (cLine !== line) {
          multiline = true;
        }
        started = true;
        p = p + 1;
        continue;
      }
      case 0x3a: { // ':'
        if (p + 1 >= e || isWsOrBreak(s[p + 1] | 0)) {
          pos = p;
          return doneScalar(start, cIndent, cLine, multiline);
        }
        if (flow) {
          const d = s[p + 1] | 0;
          // [130] `:` is ns-plain-char only when followed by ns-plain-safe(c); in flow context that excludes
          // c-flow-indicator.
          if (d === 0x2c || d === 0x5b || d === 0x5d || d === 0x7b || d === 0x7d) {
            pos = p;
            return doneScalar(start, cIndent, cLine, multiline);
          }
        }
        if (!started) {
          cIndent = lineIndent;
          cLine = line;
        } else if (cLine !== line) {
          multiline = true;
        }
        started = true;
        p = p + 1;
        continue;
      }
      case 0x23: { // '#'
        const prev = p > 0 ? s[p - 1] | 0 : 0;
        if (p === lineStartPos || prev === 0x20 || prev === 0x09 || prev === 0x0d || prev === 0x0a) {
          pos = p;
          return doneScalar(start, cIndent, cLine, multiline);
        }
        if (!started) {
          cIndent = lineIndent;
          cLine = line;
        } else if (cLine !== line) {
          multiline = true;
        }
        started = true;
        p = p + 1;
        continue;
      }
      case 0x2c: case 0x5b: case 0x5d: case 0x7b: case 0x7d: { // , [ ] { }
        if (flow) {
          pos = p;
          return doneScalar(start, cIndent, cLine, multiline);
        }
        if (!started) {
          cIndent = lineIndent;
          cLine = line;
        } else if (cLine !== line) {
          multiline = true;
        }
        started = true;
        p = p + 1;
        continue;
      }
      case 0x20: case 0x09: {
        // white space is kept until something follows it
        p = p + 1;
        while (p < e) {
          const d = s[p] | 0;
          if (d !== 0x20 && d !== 0x09) break;
          p = p + 1;
        }
        continue;
      }
      case 0x0d: case 0x0a: {
        if (c === 0x0d && p + 1 < e && (s[p + 1] | 0) === 0x0a) p = p + 1;
        // newline(); inc(1)
        lineIndent = 0;
        tabAfterIndent = false;
        lineStartPos = p + 1;
        line = line + 1;
        pos = p + 1;
        foldLines();
        p = pos;
        if (biLen > 0) {
          // Less | Equal: end here. this is the start of a new value.
          if (lineIndent <= (biStack[biLen - 1] | 0)) return doneScalar(start, cIndent, cLine, multiline);
        }
        continue;
      }
      default: {
        if (resolved || started) {
          p = p + 1;
          continue;
        }
        // first non-whitespace
        switch (c) {
          case 0x6e: { // 'n'
            p = p + 1;
            if ((s[p] | 0) === 0x75 && (s[p + 1] | 0) === 0x6c && (s[p + 2] | 0) === 0x6c) {
              started = true;
              resolved = true;
              p = p + 3;
              continue;
            }
            cIndent = lineIndent;
            cLine = line;
            started = true;
            continue;
          }
          case 0x4e: { // 'N'
            p = p + 1;
            if (((s[p] | 0) === 0x75 && (s[p + 1] | 0) === 0x6c && (s[p + 2] | 0) === 0x6c) || ((s[p] | 0) === 0x55 && (s[p + 1] | 0) === 0x4c && (s[p + 2] | 0) === 0x4c)) {
              started = true;
              resolved = true;
              p = p + 3;
              continue;
            }
            cIndent = lineIndent;
            cLine = line;
            started = true;
            continue;
          }
          case 0x7e: { // '~'
            p = p + 1;
            started = true;
            resolved = true;
            continue;
          }
          case 0x74: { // 't'
            p = p + 1;
            if ((s[p] | 0) === 0x72 && (s[p + 1] | 0) === 0x75 && (s[p + 2] | 0) === 0x65) {
              started = true;
              resolved = true;
              p = p + 3;
              continue;
            }
            cIndent = lineIndent;
            cLine = line;
            started = true;
            continue;
          }
          case 0x54: { // 'T'
            p = p + 1;
            if (((s[p] | 0) === 0x72 && (s[p + 1] | 0) === 0x75 && (s[p + 2] | 0) === 0x65) || ((s[p] | 0) === 0x52 && (s[p + 1] | 0) === 0x55 && (s[p + 2] | 0) === 0x45)) {
              started = true;
              resolved = true;
              p = p + 3;
              continue;
            }
            cIndent = lineIndent;
            cLine = line;
            started = true;
            continue;
          }
          case 0x66: { // 'f'
            p = p + 1;
            if ((s[p] | 0) === 0x61 && (s[p + 1] | 0) === 0x6c && (s[p + 2] | 0) === 0x73 && (s[p + 3] | 0) === 0x65) {
              started = true;
              resolved = true;
              p = p + 4;
              continue;
            }
            cIndent = lineIndent;
            cLine = line;
            started = true;
            continue;
          }
          case 0x46: { // 'F'
            p = p + 1;
            if (((s[p] | 0) === 0x61 && (s[p + 1] | 0) === 0x6c && (s[p + 2] | 0) === 0x73 && (s[p + 3] | 0) === 0x65) || ((s[p] | 0) === 0x41 && (s[p + 1] | 0) === 0x4c && (s[p + 2] | 0) === 0x53 && (s[p + 3] | 0) === 0x45)) {
              started = true;
              resolved = true;
              p = p + 4;
              continue;
            }
            cIndent = lineIndent;
            cLine = line;
            started = true;
            continue;
          }
          case 0x2b: { // '+'
            cIndent = lineIndent;
            cLine = line;
            started = true;
            p = p + 1;
            pos = p;
            sStarted = true; sResolved = false; sMultiline = multiline; sLine = cLine; sIndent = cIndent;
            tryResolveNumber(FC_POSITIVE);
            p = pos; resolved = sResolved; multiline = sMultiline; cLine = sLine; cIndent = sIndent;
            continue;
          }
          case 0x30: case 0x31: case 0x32: case 0x33: case 0x34:
          case 0x35: case 0x36: case 0x37: case 0x38: case 0x39: {
            pos = p;
            sStarted = false; sResolved = false; sMultiline = multiline; sLine = cLine; sIndent = cIndent;
            tryResolveNumber(FC_OTHER);
            p = pos; started = sStarted; resolved = sResolved; multiline = sMultiline; cLine = sLine; cIndent = sIndent;
            continue;
          }
          default: {
            p = p + 1;
            cIndent = lineIndent;
            cLine = line;
            started = true;
            continue;
          }
        }
      }
    }
  }
}

// ws or a line break
function isWsOrBreak(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function doneScalar(start: number, indent: number, scalarLine: number, multiline: boolean): number {
  tKind = TK_SCALAR;
  tStart = start;
  tIndent = indent;
  tLine = scalarLine;
  tStyle = multiline ? ST_PLAIN_MULTILINE : ST_PLAIN;
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Scanning block scalars
// ---------------------------------------------------------------------------------------------------------------

// Rust `scan_block_header`. Returns the indentation indicator (0 if none), or -1 (error set). The chomping indicator
// does not matter for the syntax.
function scanBlockHeader(): number {
  let indentIndicator = 0;
  let chomp = false;
  for (;;) {
    const c = nx();
    if (c === 0) {
      if (!isEof()) return fail(PE_UNEXPECTED_CHARACTER);
      return indentIndicator;
    } else if (c >= 0x31 && c <= 0x39) {
      if (indentIndicator !== 0) return fail(PE_UNEXPECTED_CHARACTER);
      indentIndicator = c - 0x30;
      inc(1);
    } else if (c === 0x2d || c === 0x2b) {
      if (chomp) return fail(PE_UNEXPECTED_CHARACTER);
      chomp = true;
      inc(1);
    } else if (c === 0x20 || c === 0x09) {
      inc(1);
      skipSWhite();
      if (nx() === 0x23) {
        const start = pos;
        inc(1);
        if (!skipCommentBody()) return -1;
        noteWritten(TK_COMMENT, start);
      }
    } else if (c === 0x0d || c === 0x0a) {
      if (c === 0x0d && pk(1) === 0x0a) inc(1);
      // the first newline is always excluded from a literal
      newline();
      inc(1);
      if (nx() === 0x09) return fail(PE_TAB_INDENTATION); // tab for indentation
      return indentIndicator;
    } else {
      return fail(PE_UNEXPECTED_CHARACTER);
    }
  }
}

// Rust `scan_auto_indented_literal_scalar`, for the syntax: the text is not built. Sets the token (start is the
// byte behind the indicator, the caller moves it).
function scanAutoIndentedLiteralScalar(indentIndicator: number, start: number, startLine: number): number {
  let parent = 0;
  let explicitIndent = -1;
  if (indentIndicator !== 0) {
    parent = biLen > 0 ? biStack[biLen - 1] | 0 : 0;
    explicitIndent = parent + indentIndicator;
  }
  let contentIndent = explicitIndent >= 0 ? explicitIndent : 0;
  let maxLeadingIndent = 0;
  let textEmpty = true;

  // Phase 1: find content_indent and first non-ws char
  let first = 0;
  phase1: for (;;) {
    const c = nx();
    switch (c) {
      case 0: {
        if (!isEof()) return fail(PE_UNEXPECTED_CHARACTER);
        // trailing indentation at EOF counts as one trailing empty line for chomping (not a syntax matter)
        if (explicitIndent < 0) contentIndent = lineIndent;
        return doneBlock(start, startLine, contentIndent);
      }
      case 0x0d: case 0x0a: {
        if (c === 0x0d && pk(1) === 0x0a) inc(1);
        newline();
        inc(1);
        if (nx() === 0x09) return fail(PE_TAB_INDENTATION);
        continue;
      }
      case 0x20: {
        let indent = 1;
        inc(1);
        if (explicitIndent >= 0) {
          while (indent < explicitIndent && nx() === 0x20) {
            indent = indent + 1;
            inc(1);
          }
          lineIndent = indent;
          const d = nx();
          if (d === 0 || d === 0x0a || d === 0x0d) continue;
          contentIndent = explicitIndent;
          first = d;
          break phase1;
        }
        while (nx() === 0x20) {
          indent = indent + 1;
          inc(1);
        }
        if (maxLeadingIndent < indent) maxLeadingIndent = indent;
        lineIndent = indent;
        continue;
      }
      default: {
        contentIndent = explicitIndent >= 0 ? explicitIndent : lineIndent;
        first = c;
        break phase1;
      }
    }
  }
  if (first === 0x09) tabAfterIndent = true;

  // A line is part of the body iff its indentation is >= content_indent and strictly > the parent block's indent.
  const minIndent = biLen > 0 ? Math.max(contentIndent, (biStack[biLen - 1] | 0) + 1) : contentIndent;

  // Phase 2: scan body
  let c = first;
  for (;;) {
    if (c === 0) {
      if (!isEof()) return fail(PE_UNEXPECTED_CHARACTER);
      return doneBlock(start, startLine, contentIndent);
    } else if (c === 0x0d || c === 0x0a) {
      if (c === 0x0d && pk(1) === 0x0a) inc(1);
      newline();
      inc(1);
      // nested newlines: switch
      for (;;) {
        const nc = nx();
        if (nc === 0x0d || nc === 0x0a) {
          if (nc === 0x0d && pk(1) === 0x0a) inc(1);
          newline();
          inc(1);
          if (nx() === 0x09) return fail(PE_TAB_INDENTATION);
          continue;
        } else if (nc === 0x20) {
          let indent = 0;
          while (indent < contentIndent && nx() === 0x20) {
            indent = indent + 1;
            inc(1);
          }
          lineIndent = indent;
          const d = nx();
          if (d === 0x09) tabAfterIndent = true;
          c = d;
          break;
        } else {
          if (nc === 0x09) tabAfterIndent = true;
          c = nc;
          break;
        }
      }
      continue;
    } else {
      if (c === 0x2d) {
        if (isAtLineStart() && lineIndent === 0 && pk(1) === 0x2d && pk(2) === 0x2d && isWhiteOrBreakOrEofAt(3)) {
          return doneBlock(start, startLine, contentIndent);
        }
      } else if (c === 0x2e) {
        if (isAtLineStart() && lineIndent === 0 && pk(1) === 0x2e && pk(2) === 0x2e && isWhiteOrBreakOrEofAt(3)) {
          return doneBlock(start, startLine, contentIndent);
        }
      }
      if (lineIndent < minIndent) return doneBlock(start, startLine, contentIndent);
      // append: the first character of the text
      if (textEmpty) {
        if (explicitIndent < 0 && contentIndent < maxLeadingIndent) return fail(PE_UNEXPECTED_CHARACTER);
        textEmpty = false;
      }
      inc(1);
      // The rest of the line is text too: only a line break or the end ends it.
      let p = pos;
      const e = n;
      const s = src;
      while (p < e) {
        const d = s[p] | 0;
        if (d === 0x0a || d === 0x0d || d === 0) break;
        p = p + 1;
      }
      pos = p;
      c = nx();
    }
  }
}

function doneBlock(start: number, startLine: number, contentIndent: number): number {
  tKind = TK_SCALAR;
  tStart = start;
  tIndent = contentIndent;
  tLine = startLine;
  tStyle = ST_BLOCK;
  return 0;
}

// Rust `scan_literal_scalar` / `scan_folded_scalar` (the same for the syntax). The cursor is behind `|` / `>`.
function scanBlockScalar(): number {
  const start = pos;
  const startLine = line;
  const indicator = scanBlockHeader();
  if (indicator < 0) return -1;
  return scanAutoIndentedLiteralScalar(indicator, start, startLine);
}

// ---------------------------------------------------------------------------------------------------------------
// Scanning quoted scalars
// ---------------------------------------------------------------------------------------------------------------

function doneQuoted(start: number, scalarLine: number, scalarIndent: number): number {
  tKind = TK_SCALAR;
  tStart = start;
  tIndent = scalarIndent;
  tLine = scalarLine;
  tStyle = ST_QUOTED;
  return 0;
}

// Rust `scan_single_quoted_scalar`. The cursor is behind the quote.
function scanSingleQuotedScalar(): number {
  const start = pos;
  const scalarLine = line;
  const scalarIndent = lineIndent;
  for (;;) {
    const c = nx();
    switch (c) {
      case 0: return fail(PE_UNEXPECTED_CHARACTER);
      case 0x2e: { // '.'
        if (isAtLineStart() && pk(1) === 0x2e && pk(2) === 0x2e && isSWhiteOrBCharAt(3)) return fail(PE_UNEXPECTED_DOCUMENT_END);
        inc(1);
        continue;
      }
      case 0x2d: { // '-'
        if (isAtLineStart() && pk(1) === 0x2d && pk(2) === 0x2d && isSWhiteOrBCharAt(3)) return fail(PE_UNEXPECTED_DOCUMENT_START);
        inc(1);
        continue;
      }
      case 0x0d: case 0x0a: {
        newline();
        inc(1);
        foldLines();
        if (biLen > 0 && lineIndent <= (biStack[biLen - 1] | 0)) return fail(PE_UNEXPECTED_CHARACTER);
        continue;
      }
      case 0x20: case 0x09: {
        inc(1);
        skipSWhite();
        continue;
      }
      case 0x27: { // '\''
        inc(1);
        if (nx() === 0x27) {
          inc(1);
          continue;
        }
        return doneQuoted(start, scalarLine, scalarIndent);
      }
      default: {
        // the run of bytes that need no care
        let p = pos + 1;
        const e = n;
        const s = src;
        while (p < e) {
          const d = s[p] | 0;
          if (d === 0 || d === 0x2e || d === 0x2d || d === 0x0d || d === 0x0a || d === 0x20 || d === 0x09 || d === 0x27) break;
          p = p + 1;
        }
        pos = p;
        continue;
      }
    }
  }
}

// Rust `scan_double_quoted_scalar`. The cursor is behind the quote.
function scanDoubleQuotedScalar(): number {
  const start = pos;
  const scalarLine = line;
  const scalarIndent = lineIndent;
  for (;;) {
    const c = nx();
    switch (c) {
      case 0: return fail(PE_UNEXPECTED_CHARACTER);
      case 0x2e: { // '.'
        if (isAtLineStart() && pk(1) === 0x2e && pk(2) === 0x2e && isSWhiteOrBCharAt(3)) return fail(PE_UNEXPECTED_DOCUMENT_END);
        inc(1);
        continue;
      }
      case 0x2d: { // '-'
        if (isAtLineStart() && pk(1) === 0x2d && pk(2) === 0x2d && isSWhiteOrBCharAt(3)) return fail(PE_UNEXPECTED_DOCUMENT_START);
        inc(1);
        continue;
      }
      case 0x0d: case 0x0a: {
        newline();
        inc(1);
        foldLines();
        if (biLen > 0 && lineIndent <= (biStack[biLen - 1] | 0)) return fail(PE_UNEXPECTED_CHARACTER);
        continue;
      }
      case 0x20: case 0x09: {
        inc(1);
        skipSWhite();
        continue;
      }
      case 0x22: { // '"'
        inc(1);
        return doneQuoted(start, scalarLine, scalarIndent);
      }
      case 0x5c: { // '\\'
        inc(1);
        const e = nx();
        switch (e) {
          case 0x0d: case 0x0a: {
            newline();
            inc(1);
            foldLines();
            if (biLen > 0 && lineIndent <= (biStack[biLen - 1] | 0)) return fail(PE_UNEXPECTED_CHARACTER);
            skipSWhite();
            continue;
          }
          // escaped white space
          case 0x20: case 0x09:
          case 0x30: case 0x61: case 0x62: case 0x74: case 0x6e: case 0x76: case 0x66: case 0x72: case 0x65:
          case 0x22: case 0x2f: case 0x5c:
          case 0x4e: case 0x5f: case 0x4c: case 0x50:
            break;
          case 0x78: if (!decodeHexCodePoint(2)) return -1; break; // 'x'
          case 0x75: if (!decodeHexCodePoint(4)) return -1; break; // 'u'
          case 0x55: if (!decodeHexCodePoint(8)) return -1; break; // 'U'
          default: return fail(PE_UNEXPECTED_CHARACTER);
        }
        inc(1);
        continue;
      }
      default: {
        let p = pos + 1;
        const e = n;
        const s = src;
        while (p < e) {
          const d = s[p] | 0;
          if (d === 0 || d === 0x2e || d === 0x2d || d === 0x0d || d === 0x0a || d === 0x20 || d === 0x09 || d === 0x22 || d === 0x5c) break;
          p = p + 1;
        }
        pos = p;
        continue;
      }
    }
  }
}

// Rust `decode_hex_code_point` (`parse_as_written`: it is not decoded, so a surrogate is half of a pair). The cursor
// is at `x`, `u` or `U`; it is left on the last digit.
function decodeHexCodePoint(count: number): boolean {
  let value = 0;
  for (let i = 0; i < count; i++) {
    inc(1);
    const d = nx();
    let v = -1;
    if (d >= 0x30 && d <= 0x39) v = d - 0x30;
    else if (d >= 0x61 && d <= 0x66) v = d - 0x61 + 10;
    else if (d >= 0x41 && d <= 0x46) v = d - 0x41 + 10;
    if (v < 0) { fail(PE_UNEXPECTED_CHARACTER); return false; }
    value = value * 16 + v;
  }
  if (value > 0x10ffff) { fail(PE_UNEXPECTED_CHARACTER); return false; }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Scanning tags
// ---------------------------------------------------------------------------------------------------------------

function tagToken(start: number): number {
  tKind = TK_TAG;
  tStart = start;
  tIndent = lineIndent;
  tLine = line;
  return 0;
}

function hasTagHandle(s: number, e: number): boolean {
  const len = e - s;
  for (let i = 0; i < thLen; i += 2) {
    const hs = thRanges[i] | 0;
    const he = thRanges[i + 1] | 0;
    if (he - hs !== len) continue;
    let same = true;
    for (let k = 0; k < len; k++) {
      if ((src[hs + k] | 0) !== (src[s + k] | 0)) { same = false; break; }
    }
    if (same) return true;
  }
  return false;
}

function putTagHandle(s: number, e: number): void {
  if (thLen + 2 > thRanges.length) growTh();
  thRanges[thLen] = s | 0;
  thRanges[thLen + 1] = e | 0;
  thLen = thLen + 2;
}

// Rust `scan_tag_property` (c-ns-tag-property). The cursor is at the `!`.
function scanTagProperty(): number {
  const start = pos;
  inc(1);
  const c = nx();
  switch (c) {
    case 0: case 0x20: case 0x09: case 0x0a: case 0x0d:
      // c-non-specific-tag / primary tag handle
      return tagToken(start);
    case 0x3c: { // '<': c-verbatim-tag
      inc(1);
      if (nx() === 0x21) {
        inc(1);
        skipNsUriChars();
      } else {
        const len = isNsTagChar();
        if (len === 0) return fail(PE_UNEXPECTED_CHARACTER);
        inc(len);
        skipNsUriChars();
      }
      if (!trySkipChar(0x3e)) return -1;
      return tagToken(start);
    }
    case 0x21: { // '!': c-ns-shorthand-tag / secondary tag handle
      inc(1);
      if (!trySkipNsTagChars()) return -1;
      // s-separate
      const d = nx();
      if (d === 0 || d === 0x20 || d === 0x09 || d === 0x0d || d === 0x0a) {
        // ok
      } else if (d === 0x2c || d === 0x5b || d === 0x5d || d === 0x7b || d === 0x7d) {
        if (ctxTop === C_BLOCK_OUT || ctxTop === C_BLOCK_IN) return fail(PE_UNEXPECTED_CHARACTER);
      } else {
        return fail(PE_UNEXPECTED_CHARACTER);
      }
      return tagToken(start);
    }
    default: {
      // c-ns-shorthand-tag / named tag handle
      const off = pos;
      if (!trySkipNsWordChars()) return -1;
      const handleEnd = pos;
      if (nx() === 0x21) {
        inc(1);
        if (!hasTagHandle(off, handleEnd)) {
          pos = off;
          return fail(PE_UNRESOLVED_TAG_HANDLE);
        }
        if (!trySkipNsTagChars()) return -1;
        return tagToken(start);
      }
      // primary
      skipNsTagChars();
      return tagToken(start);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------------------------------------------

function simpleToken(kind: number, start: number): void {
  tKind = kind;
  tStart = start;
  tIndent = lineIndent;
  tLine = line;
}

// Rust `scan`. `addIndent`: `additional_parent_indent`, -1 if none. Returns 0, or -1 (error set).
function scan(addIndent: number, firstScan: boolean, outside: boolean): number {
  let countIndentation = firstScan || addIndent >= 0;
  // Whether we are still in leading white space (after a line break or after an indicator with
  // additional_parent_indent), so that a tab can taint `tab_after_indent`.
  let inIndentPosition = countIndentation;
  if (inIndentPosition) tabAfterIndent = false;
  let additional = addIndent;
  const previousTokenLine = tLine;
  const sIn = src;
  const eIn = n;

  next: for (;;) {
    const c = pos < eIn ? sIn[pos] | 0 : 0;
    switch (c) {
      case 0: {
        // [1] c-printable excludes U+0000. `nx()` returns NUL as the EOF sentinel, so a literal NUL in the input
        // has to be rejected here.
        if (!isEof()) return fail(PE_UNEXPECTED_CHARACTER);
        simpleToken(TK_EOF, pos);
        break next;
      }
      case 0x2d: { // '-'
        const start = pos;
        // [203] c-directives-end is line-starting at column 0.
        if (isAtLineStart() && lineIndent === 0 && pk(1) === 0x2d && pk(2) === 0x2d && isSWhiteOrBCharOrEofAt(3)) {
          inc(3);
          simpleToken(TK_DOCUMENT_START, start);
          break next;
        }
        const d = pk(1);
        if (d === 0 || d === 0x0a || d === 0x0d || d === 0x20 || d === 0x09) {
          inc(1);
          if (isFlowCtx()) {
            tStart = start;
            return fail(PE_UNEXPECTED_TOKEN);
          }
          simpleToken(TK_SEQUENCE_ENTRY, start);
          break next;
        } else if (d === 0x2c || d === 0x5d || d === 0x5b || d === 0x7d || d === 0x7b) {
          if (isFlowCtx()) {
            inc(1);
            simpleToken(TK_SEQUENCE_ENTRY, start);
            return fail(PE_UNEXPECTED_TOKEN);
          }
        }
        if (scanPlainScalar() < 0) return -1;
        break next;
      }
      case 0x2e: { // '.'
        const start = pos;
        if (isAtLineStart() && lineIndent === 0 && pk(1) === 0x2e && pk(2) === 0x2e && isSWhiteOrBCharOrEofAt(3)) {
          inc(3);
          simpleToken(TK_DOCUMENT_END, start);
          break next;
        }
        if (scanPlainScalar() < 0) return -1;
        break next;
      }
      case 0x3f: { // '?'
        const start = pos;
        const d = pk(1);
        if (d === 0 || d === 0x20 || d === 0x09 || d === 0x0a || d === 0x0d) {
          inc(1);
          simpleToken(TK_MAPPING_KEY, start);
          break next;
        } else if (d === 0x2c || d === 0x5d || d === 0x5b || d === 0x7d || d === 0x7b) {
          if (isFlowCtx()) {
            inc(1);
            simpleToken(TK_MAPPING_KEY, start);
            break next;
          }
        }
        if (scanPlainScalar() < 0) return -1;
        break next;
      }
      case 0x3a: { // ':'
        const start = pos;
        const d = pk(1);
        if (d === 0 || d === 0x20 || d === 0x09 || d === 0x0a || d === 0x0d) {
          inc(1);
          simpleToken(TK_MAPPING_VALUE, start);
          break next;
        } else if (d === 0x2c || d === 0x5d || d === 0x5b || d === 0x7d || d === 0x7b) {
          if (isFlowCtx()) {
            inc(1);
            simpleToken(TK_MAPPING_VALUE, start);
            break next;
          }
        } else if (ctxTop === C_FLOW_KEY) {
          inc(1);
          simpleToken(TK_MAPPING_VALUE, start);
          break next;
        }
        if (scanPlainScalar() < 0) return -1;
        break next;
      }
      case 0x2c: { // ','
        const start = pos;
        if (isFlowCtx()) {
          inc(1);
          simpleToken(TK_COLLECT_ENTRY, start);
          break next;
        }
        if (scanPlainScalar() < 0) return -1;
        break next;
      }
      case 0x5b: { // '['
        const start = pos;
        inc(1);
        simpleToken(TK_SEQUENCE_START, start);
        break next;
      }
      case 0x5d: { // ']'
        const start = pos;
        inc(1);
        simpleToken(TK_SEQUENCE_END, start);
        break next;
      }
      case 0x7b: { // '{'
        const start = pos;
        inc(1);
        simpleToken(TK_MAPPING_START, start);
        break next;
      }
      case 0x7d: { // '}'
        const start = pos;
        inc(1);
        simpleToken(TK_MAPPING_END, start);
        break next;
      }
      case 0x23: { // '#'
        const start = pos;
        if (!isAtLineStart()) {
          const prev = src[start - 1] | 0;
          if (prev !== 0x20 && prev !== 0x09 && prev !== 0x0a && prev !== 0x0d) {
            // TODO(upstream): prove this is unreachable
            return fail(PE_UNEXPECTED_CHARACTER);
          }
        }
        inc(1);
        if (!skipCommentBody()) return -1;
        noteWritten(TK_COMMENT, start);
        continue;
      }
      case 0x26: { // '&'
        const start = pos;
        inc(1);
        if (!trySkipNsAnchorChars()) return -1;
        const d = nx();
        if (d === 0 || d === 0x20 || d === 0x09 || d === 0x0a || d === 0x0d) {
          simpleToken(TK_ANCHOR, start);
          break next;
        } else if (d === 0x2c || d === 0x5d || d === 0x5b || d === 0x7d || d === 0x7b) {
          if (isFlowCtx()) {
            simpleToken(TK_ANCHOR, start);
            break next;
          }
        }
        return fail(PE_UNEXPECTED_CHARACTER);
      }
      case 0x2a: { // '*'
        const start = pos;
        inc(1);
        if (!trySkipNsAnchorChars()) return -1;
        const d = nx();
        if (d === 0 || d === 0x20 || d === 0x09 || d === 0x0a || d === 0x0d) {
          simpleToken(TK_ALIAS, start);
          break next;
        } else if (d === 0x2c || d === 0x5d || d === 0x5b || d === 0x7d || d === 0x7b) {
          if (isFlowCtx()) {
            simpleToken(TK_ALIAS, start);
            break next;
          }
        }
        return fail(PE_UNEXPECTED_CHARACTER);
      }
      case 0x21: { // '!'
        if (scanTagProperty() < 0) return -1;
        break next;
      }
      case 0x7c: case 0x3e: { // '|' '>'
        const start = pos;
        if (!isFlowCtx()) {
          const indicatorIndent = lineIndent;
          inc(1);
          if (scanBlockScalar() < 0) return -1;
          // Token.indent for a block scalar is the indicator's s-indent, not the auto-detected content indent
          tIndent = indicatorIndent;
          break next;
        }
        tStart = start;
        return fail(PE_UNEXPECTED_TOKEN);
      }
      case 0x27: { // '\''
        inc(1);
        if (scanSingleQuotedScalar() < 0) return -1;
        break next;
      }
      case 0x22: { // '"'
        inc(1);
        if (scanDoubleQuotedScalar() < 0) return -1;
        break next;
      }
      case 0x25: { // '%'
        const start = pos;
        inc(1);
        simpleToken(TK_DIRECTIVE, start);
        break next;
      }
      case 0x40: case 0x60: { // '@' '`'
        const start = pos;
        inc(1);
        simpleToken(TK_RESERVED, start);
        return fail(PE_UNEXPECTED_TOKEN);
      }
      // white space
      case 0x0d: {
        if (pk(1) === 0x0a) inc(1);
        countIndentation = true;
        inIndentPosition = true;
        additional = -1;
        newline();
        inc(1);
        continue;
      }
      case 0x0a: {
        countIndentation = true;
        inIndentPosition = true;
        additional = -1;
        newline();
        inc(1);
        continue;
      }
      case 0x20: {
        let total = 1;
        let p = pos + 1;
        const e = n;
        const s = src;
        while (p < e && (s[p] | 0) === 0x20) {
          p = p + 1;
          total = total + 1;
        }
        pos = p;
        if (countIndentation) {
          lineIndent = total + (additional >= 0 ? additional : 0);
        }
        countIndentation = false;
        continue;
      }
      case 0x09: {
        if (countIndentation && additional < 0 && ctxTop === C_BLOCK_IN) return fail(PE_TAB_INDENTATION);
        if (inIndentPosition) {
          // [63] s-indent is spaces only. A tab here is s-separate-in-line - valid before [197] flow-in-block
          // content, but not before a [185] compact construct or a sibling block entry.
          tabAfterIndent = true;
          additional = -1;
        }
        countIndentation = false;
        inc(1);
        continue;
      }
      default: {
        if (scanPlainScalar() < 0) return -1;
        break next;
      }
    }
  }

  // The token is listed (Rust `note_written_token`), with what it means taken from it.
  if (tKind !== TK_EOF && tKind !== TK_RESERVED) {
    let start = tStart;
    if (tKind === TK_SCALAR && tStyle >= ST_BLOCK) start = start - 1;
    noteWritten(tKind, start);
  }

  if (ctxTop === C_FLOW_IN || ctxTop === C_FLOW_KEY) {
    if (biLen > 0) {
      if (!outside && tLine !== previousTokenLine && tIndent <= (biStack[biLen - 1] | 0) && tKind !== TK_SEQUENCE_END && tKind !== TK_MAPPING_END) {
        return fail(PE_UNEXPECTED_TOKEN);
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Properties of a node (Rust `NodeProperties`): anchors and tags only matter for where they are
// ---------------------------------------------------------------------------------------------------------------
//
// The state is in local variables of `parseNode` (an anchor is `start`, `line`; -1 if there is none).

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

function maybeSetJsonKey(allowed: boolean): boolean {
  if (allowed && ctxTop === C_FLOW_IN) {
    ctxPush(C_FLOW_KEY);
    return true;
  }
  return false;
}

function unsetJsonKey(wasSet: boolean): void {
  if (wasSet) ctxPop();
}

// Rust `parse_directive`. Returns DIR_YAML / DIR_OTHER, or -1.
function parseDirective(): number {
  if (tIndent !== 0) return fail(PE_INVALID_DIRECTIVE);

  // yaml directive
  if (pk(0) === 0x59 && pk(1) === 0x41 && pk(2) === 0x4d && pk(3) === 0x4c && isSWhiteAt(4)) {
    inc(4);
    if (!trySkipSWhite()) return -1;
    if (!trySkipNsDecDigits()) return -1;
    if (!trySkipChar(0x2e)) return -1;
    if (!trySkipNsDecDigits()) return -1;
    if (!trySkipToNewLine()) return -1;
    return DIR_YAML;
  }

  // tag directive
  if (pk(0) === 0x54 && pk(1) === 0x41 && pk(2) === 0x47 && isSWhiteAt(3)) {
    inc(3);
    if (!trySkipSWhite()) return -1;
    if (!trySkipChar(0x21)) return -1;

    // primary tag handle
    if (isSWhite()) {
      skipSWhite();
      if (!parseDirectiveTagPrefix()) return -1;
      if (!trySkipToNewLine()) return -1;
      return DIR_OTHER;
    }

    // secondary tag handle
    if (isChar(0x21)) {
      inc(1);
      if (!trySkipSWhite()) return -1;
      if (!parseDirectiveTagPrefix()) return -1;
      if (!trySkipToNewLine()) return -1;
      return DIR_OTHER;
    }

    // named tag handle
    const handleStart = pos;
    if (!trySkipNsWordChars()) return -1;
    const handleEnd = pos;
    if (!trySkipChar(0x21)) return -1;
    if (!trySkipSWhite()) return -1;
    putTagHandle(handleStart, handleEnd);
    if (!parseDirectiveTagPrefix()) return -1;
    if (!trySkipToNewLine()) return -1;
    return DIR_OTHER;
  }

  // reserved directive
  if (!trySkipNsChars()) return -1;
  skipSWhite();
  while (isNsChar()) {
    skipNsChars();
    skipSWhite();
  }
  if (!trySkipToNewLine()) return -1;
  return DIR_OTHER;
}

function parseDirectiveTagPrefix(): boolean {
  // local tag prefix
  if (isChar(0x21)) {
    inc(1);
    skipNsUriChars();
    return true;
  }
  // global tag prefix
  const len = isNsTagChar();
  if (len !== 0) {
    inc(len);
    skipNsUriChars();
    return true;
  }
  fail(PE_INVALID_DIRECTIVE);
  return false;
}

// Rust `parse_document`. Returns the root, or -1.
function parseDocument(): number {
  thLen = 0;
  let hasDirectives = false;
  let hasYamlDirective = false;

  while (tKind === TK_DIRECTIVE) {
    const d = parseDirective();
    if (d < 0) return -1;
    if (d === DIR_YAML) {
      if (hasYamlDirective) return fail(PE_MULTIPLE_YAML_DIRECTIVES);
      hasYamlDirective = true;
    }
    hasDirectives = true;
    if (scan(-1, false, false) < 0) return -1;
  }

  explicitDocLine = -1;

  if (tKind === TK_DOCUMENT_START) {
    explicitDocLine = tLine;
    if (scan(-1, false, false) < 0) return -1;
  } else if (hasDirectives) {
    // if there's directives they must end with '---'
    return fail(PE_UNEXPECTED_TOKEN);
  }

  const root = parseNode(-1, false, false, -1, -1, -1, -1);
  if (root < 0) return -1;

  // If document_start it needs to create a new document. If document_end, consume as many as possible. They should
  // not create new documents.
  if (tKind === TK_EOF || tKind === TK_DOCUMENT_START) {
    // ok
  } else if (tKind === TK_DOCUMENT_END) {
    let documentEndLine = tLine;
    if (scan(-1, false, false) < 0) return -1;
    // consume all bare documents
    while (tKind === TK_DOCUMENT_END) {
      documentEndLine = tLine;
      if (scan(-1, false, false) < 0) return -1;
    }
    if (tLine === documentEndLine && tKind !== TK_EOF) return fail(PE_UNEXPECTED_TOKEN);
  } else {
    return fail(PE_UNEXPECTED_TOKEN);
  }
  return root;
}

// Rust `parse_flow_explicit_key`: [142]/[143] consumes the `?` and parses the flow explicit-entry key.
function parseFlowExplicitKey(): number {
  const start = tStart;
  // The post-`?` scan stays in the enclosing flow-in context
  if (scan(-1, false, false) < 0) return -1;
  if (tKind === TK_MAPPING_VALUE || tKind === TK_COLLECT_ENTRY || tKind === TK_MAPPING_END || tKind === TK_SEQUENCE_END) {
    return NODE_NULL;
  }
  // [143] the explicit key after `?` is ns-flow-map-implicit-entry, whose own key is a ns-flow-yaml-node /
  // c-flow-json-node - neither admits another `?`.
  if (tKind === TK_MAPPING_KEY) return fail(PE_UNEXPECTED_TOKEN);

  // Consume c-ns-properties here (still in flow-in)
  let tagStart = -1;
  let tagLine = -1;
  let anchorStart = -1;
  let anchorLine = -1;
  for (;;) {
    if (tKind === TK_ANCHOR && anchorStart < 0) {
      anchorStart = tStart;
      anchorLine = tLine;
    } else if (tKind === TK_TAG && tagStart < 0) {
      tagStart = tStart;
      tagLine = tLine;
    } else {
      break;
    }
    if (scan(-1, false, false) < 0) return -1;
    if ((tKind as number) === TK_MAPPING_VALUE || (tKind as number) === TK_COLLECT_ENTRY || (tKind as number) === TK_MAPPING_END || (tKind as number) === TK_SEQUENCE_END) {
      return NODE_NULL; // props_to_e_node
    }
  }
  void start;

  ctxPush(C_FLOW_KEY);
  const k = parseNode(-1, true, false, tagStart, tagLine, anchorStart, anchorLine);
  ctxPop();
  return k;
}

// Rust `parse_flow_sequence` + `parse_flow_sequence_entries`
function parseFlowSequence(): number {
  const id = newCollection(NK_ARRAY, tStart);
  const base = csLen;

  ctxPush(C_FLOW_IN);
  if (scan(-1, false, false) < 0) return -1;
  while (tKind !== TK_SEQUENCE_END) {
    let item: number;
    if (tKind === TK_MAPPING_KEY) {
      // [150] ns-flow-pair ::= '?' s-separate ns-flow-map-explicit-entry
      const pairStart = tStart;
      const key = parseFlowExplicitKey();
      if (key < 0) return -1;
      let value: number;
      if ((tKind as number) === TK_MAPPING_VALUE) {
        if (scan(-1, false, false) < 0) return -1;
        if ((tKind as number) === TK_COLLECT_ENTRY || (tKind as number) === TK_SEQUENCE_END) {
          value = NODE_NULL;
        } else {
          // [147] the value is ns-flow-node; threading the value's own indent as current_mapping_indent makes the
          // Scalar arm's cmi==scalar_indent check return the bare scalar instead of consuming a trailing `: ...`
          // as a nested mapping.
          value = parseNode(tIndent, false, false, -1, -1, -1, -1);
          if (value < 0) return -1;
        }
      } else {
        value = NODE_NULL;
      }
      const obj = newCollection(NK_OBJECT, pairStart);
      const b = csLen;
      pushPair(key, value);
      finishCollection(obj, b, 2);
      item = obj;
    } else {
      item = parseNode(-1, false, true, -1, -1, -1, -1);
      if (item < 0) return -1;
    }
    push(item);

    if (tKind === TK_SEQUENCE_END) break;
    if (tKind !== TK_COLLECT_ENTRY) return fail(PE_UNEXPECTED_TOKEN);
    if (scan(-1, false, false) < 0) return -1;
  }
  ctxPop();
  // The post-`]` scan happens after `FlowIn` is popped
  if (scan(-1, false, false) < 0) return -1;
  finishCollection(id, base, 1);
  return id;
}

// Rust `parse_flow_mapping` + `parse_flow_mapping_entries`
function parseFlowMapping(): number {
  const id = newCollection(NK_OBJECT, tStart);
  const base = csLen;

  ctxPush(C_FLOW_IN);
  if (scan(-1, false, false) < 0) return -1;

  while (tKind !== TK_MAPPING_END) {
    // [142] `? ...` and bare `:` are handled here so the key parse never reaches parse_node's MappingKey arm
    let key: number;
    if (tKind === TK_MAPPING_KEY) {
      key = parseFlowExplicitKey();
      if (key < 0) return -1;
    } else if (tKind === TK_MAPPING_VALUE) {
      // [147] e-node key followed by `:`
      key = NODE_NULL;
    } else {
      ctxPush(C_FLOW_KEY);
      key = parseNode(-1, false, false, -1, -1, -1, -1);
      ctxPop();
      if (key < 0) return -1;
    }

    if (tKind === TK_COLLECT_ENTRY) {
      pushPair(key, NODE_NULL);
      if (scan(-1, false, false) < 0) return -1;
      continue;
    } else if (tKind === TK_MAPPING_END) {
      pushPair(key, NODE_NULL);
      continue;
    } else if (tKind !== TK_MAPPING_VALUE) {
      return fail(PE_UNEXPECTED_TOKEN);
    }

    if (scan(-1, false, false) < 0) return -1;

    if ((tKind as number) === TK_MAPPING_END || (tKind as number) === TK_COLLECT_ENTRY) {
      pushPair(key, NODE_NULL);
    } else {
      // [147] the value is ns-flow-node; threading the value's own indent as current_mapping_indent makes the
      // Scalar arm's cmi==scalar_indent check return the bare scalar instead of consuming a trailing `: ...` as a
      // nested mapping (`{a: b: c}`).
      const value = parseNode(tIndent, false, false, -1, -1, -1, -1);
      if (value < 0) return -1;
      pushPair(key, value);
    }

    // [140] ns-s-flow-map-entries: after an entry, only `,` or `}`.
    if ((tKind as number) === TK_COLLECT_ENTRY) {
      if (scan(-1, false, false) < 0) return -1;
    } else if ((tKind as number) === TK_MAPPING_END) {
      // ok
    } else {
      return fail(PE_UNEXPECTED_TOKEN);
    }
  }
  ctxPop();
  if (scan(-1, false, false) < 0) return -1;
  finishCollection(id, base, 2);
  return id;
}

// Rust `parse_block_sequence` + `parse_block_sequence_entries`
function parseBlockSequence(): number {
  const id = newCollection(NK_ARRAY, tStart);
  const base = csLen;
  const sequenceIndent = tIndent;

  // [200] s-l+block-collection requires s-l-comments (a line break) before l+block-sequence; same-line content
  // after `---` can only be a flow node via s-separate-in-line.
  if (explicitDocLine >= 0 && tLine === explicitDocLine) return fail(PE_UNEXPECTED_TOKEN);

  biPush(sequenceIndent);
  let prevLine = 0;
  while (tKind === TK_SEQUENCE_ENTRY && tIndent === sequenceIndent) {
    // [184] each `-` sits at s-indent(n) (spaces only).
    if (tabAfterIndent) return fail(PE_TAB_INDENTATION);
    const entryLine = tLine;
    const entryStart = tStart;

    // only the first entry can be another sequence entry on the same line
    if (csLen > base && prevLine === entryLine) break;
    prevLine = entryLine;

    if (scan(sequenceIndent + 1, false, false) < 0) return -1;
    const item = parseBlockIndented(sequenceIndent, entryLine, entryStart + 2, BI_SEQ_ENTRY, false);
    if (item < 0) return -1;
    push(item);
  }
  biPop();
  finishCollection(id, base, 1);
  return id;
}

// Rust `parse_block_explicit_key`: [190] c-l-block-map-explicit-key. The current token is the `?`.
function parseBlockExplicitKey(mappingStart: number, mappingIndent: number, mappingLine: number): number {
  biPush(mappingIndent);
  if (scan(mappingIndent + 1, false, false) < 0) return -1;
  const key = parseBlockIndented(mappingIndent, mappingLine, mappingStart, BI_MAP_EXPLICIT_KEY, false);
  if (key < 0) return -1;
  biPop();
  return key;
}

// Rust `parse_block_mapping`: `firstKey` is parsed, the current token is the one behind it.
function parseBlockMapping(firstKey: number, mappingStart: number, mappingIndent: number, mappingLine: number, flowPairAllowed: boolean): number {
  const id = newCollection(NK_OBJECT, mappingStart);
  const base = csLen;
  if (parseBlockMappingEntries(firstKey, mappingIndent, mappingLine, flowPairAllowed) < 0) return -1;
  finishCollection(id, base, 2);
  return id;
}

// Rust `parse_block_mapping_entries`: pushes the pairs to `cs`. Returns 0 or -1.
function parseBlockMappingEntries(firstKey: number, mappingIndent: number, mappingLine: number, flowPairAllowed: boolean): number {
  if (explicitDocLine >= 0 && mappingLine === explicitDocLine) {
    // TODO(upstream): more specific error
    return fail(PE_UNEXPECTED_TOKEN);
  }

  // The block_indents stack drives scan()'s flow-context indent guard (continuation lines in a flow collection must
  // be at indent > the enclosing block's). When reached via the implicit-pair path from a flow collection
  // (`["a": b]`), the key's column is not a block boundary.
  const pushedBlockIndent = !isFlowCtx();
  if (pushedBlockIndent) biPush(mappingIndent);

  let firstEntryEndLine = mappingLine;

  {
    // get the first value
    const mappingValueStart = tStart;
    const mappingValueLine = tLine;
    let value: number;
    if (tKind === TK_MAPPING_KEY) {
      // it's a !!set entry
      if (tLine === mappingLine) return fail(PE_UNEXPECTED_TOKEN);
      value = NODE_NULL;
    } else if (tKind === TK_MAPPING_VALUE) {
      firstEntryEndLine = mappingValueLine;
      value = -2;
      // [191] l-block-map-explicit-value(n) ::= s-indent(n) ':' ... The `:` must be at exactly the `?` indent
      // (block ctx).
      if (mappingValueLine !== mappingLine && !isFlowCtx() && (tIndent !== mappingIndent || tabAfterIndent)) {
        if (tIndent < mappingIndent) {
          // [189] e-node - `:` belongs to an outer construct; this entry has no value.
          value = NODE_NULL;
        } else {
          return fail(tabAfterIndent ? PE_TAB_INDENTATION : PE_UNEXPECTED_TOKEN);
        }
      }
      if (value === -2) {
        // [191] explicit `:` is on a new line at mapping_indent; a same-line `- ` after it is a compact sequence
        // whose indent is column-based, not line-based.
        const parentIndent = mappingValueLine !== mappingLine ? mappingIndent + 1 : -1;
        if (scan(parentIndent, false, false) < 0) return -1;
        value = parseBlockIndented(mappingIndent, mappingValueLine, mappingValueStart, BI_MAP_VALUE, flowPairAllowed);
        if (value < 0) return -1;
      }
    } else {
      // [189] explicit-value is optional; the current token is the next entry (or end of mapping).
      value = NODE_NULL;
    }
    pushPair(firstKey, value);
  }

  if (ctxTop === C_FLOW_IN) {
    if (pushedBlockIndent) biPop();
    return 0;
  }

  ctxPush(C_BLOCK_IN);
  let previousLine = firstEntryEndLine;

  while (
    tKind !== TK_EOF && tKind !== TK_DOCUMENT_START && tKind !== TK_DOCUMENT_END &&
    tIndent === mappingIndent && tLine !== previousLine
  ) {
    // [192]/[195] each entry sits at s-indent(n) (spaces only).
    if (tabAfterIndent) return fail(PE_TAB_INDENTATION);
    const keyLine = tLine;
    previousLine = keyLine;
    const explicitKey = tKind === TK_MAPPING_KEY;

    const key = parseNode(mappingIndent, false, false, -1, -1, -1, -1);
    if (key < 0) return -1;

    if (tKind === TK_EOF) {
      if (explicitKey) {
        pushPair(key, NODE_NULL);
        continue;
      }
      return fail(PE_UNEXPECTED_TOKEN);
    } else if (tKind === TK_MAPPING_VALUE) {
      if (explicitKey) {
        // [191] l-block-map-explicit-value ::= s-indent(n) ':' ...
        if (tIndent !== mappingIndent || tabAfterIndent) {
          if (tIndent < mappingIndent) {
            // [189] e-node - `:` belongs to an outer construct; this entry has no value.
            pushPair(key, NODE_NULL);
            continue;
          }
          return fail(tabAfterIndent ? PE_TAB_INDENTATION : PE_UNEXPECTED_TOKEN);
        }
      } else if (keyLine !== tLine) {
        return fail(PE_MULTILINE_IMPLICIT_KEY);
      }
    } else if (tKind === TK_MAPPING_KEY) {
      // ok
    } else {
      if (explicitKey) {
        // [189] explicit-value is optional; the current token is the next entry's key.
        pushPair(key, NODE_NULL);
        continue;
      }
      return fail(PE_UNEXPECTED_TOKEN);
    }

    const mappingValueLine = tLine;
    const mappingValueStart = tStart;
    // Mirrors first_entry_end_line: when this entry has an explicit `:`, the next entry must start on a later line.
    if (tKind === TK_MAPPING_VALUE) previousLine = mappingValueLine;

    let value: number;
    if (tKind === TK_MAPPING_KEY) {
      // it's a !!set entry
      if (tLine === keyLine) return fail(PE_UNEXPECTED_TOKEN);
      value = NODE_NULL;
    } else {
      const parentIndent = mappingValueLine !== keyLine ? mappingIndent + 1 : -1;
      if (scan(parentIndent, false, false) < 0) return -1;
      value = parseBlockIndented(mappingIndent, mappingValueLine, mappingValueStart, BI_MAP_VALUE, false);
      if (value < 0) return -1;
    }
    pushPair(key, value);
  }

  ctxPop();
  if (pushedBlockIndent) biPop();
  return 0;
}

// Rust `parse_block_indented`: [185] `s-l+block-indented(n, c)` dispatch shared by the block-mapping value (`:`),
// explicit key (`?`), and block-sequence item (`-`) paths. The current token is the post-indicator token.
function parseBlockIndented(nIndent: number, indicatorLine: number, indicatorStart: number, kind: number, flowPairAllowed: boolean): number {
  let valueTagStart = -1;
  let valueTagLine = -1;
  let valueAnchorStart = -1;
  let valueAnchorLine = -1;
  void indicatorStart;

  // The [196] indent dispatch below is block-semantics; in flow context it does not apply.
  const inFlow = isFlowCtx();

  for (;;) {
    // [196] s-l+block-node(n) reaches content via [197] flow-in-block (s-separate-lines(n+1)) or [200]
    // block-collection. Either way a token on a later line at indent <= n belongs to the parent - properties
    // collected so far attach to e-scalar per [161]. [201] seq-space: a nested block sequence may sit at indent n in
    // BLOCK-OUT, but needs n+1 in BLOCK-IN.
    if (!inFlow && tLine !== indicatorLine) {
      const belongsToParent = (tKind === TK_SEQUENCE_ENTRY && kind !== BI_SEQ_ENTRY) ? tIndent < nIndent : tIndent <= nIndent;
      if (belongsToParent) {
        // The post-property re-scan baked `value_tag` into a plain scalar's resolution; if that scalar is now
        // abandoned to the parent, rewind to its start and re-scan tag-neutral.
        if (valueTagStart >= 0 && tKind === TK_SCALAR && tStyle === ST_PLAIN) {
          pos = tStart;
          line = tLine;
          lineIndent = tIndent;
          // tab_after_indent is preserved
          if (scan(-1, false, false) < 0) return -1;
        }
        return NODE_NULL; // props_to_e_node
      }
    }

    if (tKind === TK_ANCHOR && valueAnchorStart < 0) {
      valueAnchorStart = tStart;
      valueAnchorLine = tLine;
    } else if (tKind === TK_TAG && valueTagStart < 0) {
      valueTagStart = tStart;
      valueTagLine = tLine;
    } else if (
      (tKind === TK_SEQUENCE_ENTRY || tKind === TK_MAPPING_KEY) && tLine === indicatorLine &&
      (tIndent <= nIndent || tabAfterIndent)
    ) {
      // [185] a compact construct on the indicator's line must be at indent >= n+1 via s-indent (spaces only)
      return fail(tabAfterIndent ? PE_TAB_INDENTATION : PE_UNEXPECTED_TOKEN);
    } else if (
      (tKind === TK_COLLECT_ENTRY || tKind === TK_SEQUENCE_END) && kind === BI_MAP_VALUE && flowPairAllowed && isFlowCtx()
    ) {
      // [149] e-node pair value in flow (`"a":,` / `"a":]`).
      return NODE_NULL; // props_to_e_node
    } else {
      return parseNode(nIndent, kind === BI_MAP_EXPLICIT_KEY, false, valueTagStart, valueTagLine, valueAnchorStart, valueAnchorLine);
    }

    // recorded a property - re-dispatch on what follows
    if (scan(-1, false, false) < 0) return -1;
  }
}

// Rust `parse_node`. `cmi`: `current_mapping_indent`, -1 if none. `scTagStart`/`scTagLine`, `scAnchorStart`/
// `scAnchorLine`: `scanned_tag`, `scanned_anchor` (-1 if none). Returns a node, or -1.
function parseNode(cmi: number, explicitKey: boolean, flowPairAllowed: boolean, scTagStart: number, scTagLine: number, scAnchorStart: number, scAnchorLine: number): number {
  if (depth >= maxDepth) return fail(PE_STACK_OVERFLOW);
  depth = depth + 1;
  const r = parseNodeInner(cmi, explicitKey, flowPairAllowed, scTagStart, scTagLine, scAnchorStart, scAnchorLine);
  depth = depth - 1;
  return r;
}

function parseNodeInner(cmi: number, explicitKey: boolean, flowPairAllowed: boolean, scTagStart: number, scTagLine: number, scAnchorStart: number, scAnchorLine: number): number {
  // c-ns-properties: Rust `NodeProperties`
  let anchorStart = -1; // has_anchor
  let anchorLine = -1;
  let mapAnchorStart = -1; // has_mapping_anchor
  let tagStart = -1; // has_tag
  let tagLine = -1;
  let mapTagStart = -1; // has_mapping_tag

  if (scTagStart >= 0) {
    // set_tag
    tagStart = scTagStart;
    tagLine = scTagLine;
  }
  if (scAnchorStart >= 0) {
    // set_anchor
    anchorStart = scAnchorStart;
    anchorLine = scAnchorLine;
  }

  let node = -1;

  loop: for (;;) {
    switch (tKind) {
      case TK_EOF: case TK_DOCUMENT_START: case TK_DOCUMENT_END: {
        node = NODE_NULL;
        break loop;
      }

      case TK_ANCHOR: {
        // set_anchor
        if (anchorStart >= 0) {
          if (anchorLine === tLine || mapAnchorStart >= 0) return fail(PE_MULTIPLE_ANCHORS);
          mapAnchorStart = anchorStart;
        }
        anchorStart = tStart;
        anchorLine = tLine;
        if (scan(-1, false, false) < 0) return -1;
        continue;
      }

      case TK_TAG: {
        // set_tag
        if (tagStart >= 0) {
          if (tagLine === tLine) return fail(PE_MULTIPLE_TAGS);
          mapTagStart = tagStart;
        }
        tagStart = tStart;
        tagLine = tLine;
        if (scan(-1, false, false) < 0) return -1;
        continue;
      }

      case TK_ALIAS: {
        const aliasStart = tStart;
        const aliasIndent = tIndent;
        const aliasLine = tLine;
        const aliasTabAfterIndent = tabAfterIndent;

        if (anchorStart >= 0 && anchorLine === aliasLine) return fail(PE_UNEXPECTED_TOKEN);
        if (tagStart >= 0 && tagLine === aliasLine) return fail(PE_UNEXPECTED_TOKEN);

        const copy = NODE_ALIAS;

        if (scan(-1, false, false) < 0) return -1;

        if ((tKind as number) === TK_MAPPING_VALUE) {
          if (tIndent < aliasIndent || (explicitKey && aliasLine !== tLine && tIndent <= aliasIndent)) {
            node = copy;
            break loop;
          }
          if (ctxTop === C_FLOW_KEY) return copy;
          // [192] implicit key sits at s-indent(n) (spaces only).
          if (aliasTabAfterIndent && (ctxTop === C_BLOCK_OUT || ctxTop === C_BLOCK_IN)) return fail(PE_TAB_INDENTATION);

          if (cmi >= 0 && cmi === aliasIndent) return copy;

          // [154] ns-s-implicit-yaml-key uses s-separate-in-line (same line only); [145] in flow-map uses s-separate
          // (spans lines), handled by the FlowKey return above.
          if (aliasLine !== tLine && !explicitKey) return fail(PE_MULTILINE_IMPLICIT_KEY);

          // [147] flow-map value is ns-flow-node, not a pair.
          if (ctxTop === C_FLOW_IN && !flowPairAllowed) return copy;

          // take_block_mapping_anchor
          if (checkImplicitKeyAnchors(anchorStart, anchorLine, mapAnchorStart, aliasLine) < 0) return -1;
          anchorStart = -1; mapAnchorStart = -1;
          return parseBlockMapping(copy, aliasStart, aliasIndent, aliasLine, flowPairAllowed);
        }

        node = copy;
        break loop;
      }

      case TK_SEQUENCE_START: {
        const sequenceStart = tStart;
        const sequenceIndent = tIndent;
        const sequenceLine = tLine;
        const sequenceTabAfterIndent = tabAfterIndent;
        // take_flow_node_anchor
        if (anchorStart >= 0 && anchorLine === sequenceLine) anchorStart = -1;
        const jsonKey = maybeSetJsonKey(flowPairAllowed);
        const seq = parseFlowSequence();
        unsetJsonKey(jsonKey);
        if (seq < 0) return -1;

        if ((tKind as number) === TK_MAPPING_VALUE) {
          if (tIndent < sequenceIndent || (explicitKey && sequenceLine !== tLine && tIndent <= sequenceIndent)) {
            node = seq;
            break loop;
          }
          if (ctxTop === C_FLOW_KEY) {
            node = seq;
            break loop;
          }
          // [192] implicit key sits at s-indent(n) (spaces only).
          if (sequenceTabAfterIndent && (ctxTop === C_BLOCK_OUT || ctxTop === C_BLOCK_IN)) return fail(PE_TAB_INDENTATION);

          if (cmi >= 0 && cmi === sequenceIndent) {
            node = seq;
            break loop;
          }

          if (sequenceLine !== tLine && !explicitKey) return fail(PE_MULTILINE_IMPLICIT_KEY);

          // [147] flow-map value is ns-flow-node, not a pair.
          if (ctxTop === C_FLOW_IN && !flowPairAllowed) {
            node = seq;
            break loop;
          }

          if (checkImplicitKeyAnchors(anchorStart, anchorLine, mapAnchorStart, sequenceLine) < 0) return -1;
          anchorStart = -1; mapAnchorStart = -1;
          return parseBlockMapping(seq, sequenceStart, sequenceIndent, sequenceLine, flowPairAllowed);
        }

        node = seq;
        break loop;
      }

      case TK_COLLECT_ENTRY: case TK_SEQUENCE_END: case TK_MAPPING_END: {
        if (anchorStart >= 0 || tagStart >= 0) {
          node = NODE_NULL;
          break loop;
        }
        return fail(PE_UNEXPECTED_TOKEN);
      }

      case TK_SEQUENCE_ENTRY: {
        if (anchorStart >= 0 && anchorLine === tLine) return fail(PE_UNEXPECTED_TOKEN);
        if (tagStart >= 0 && tagLine === tLine) return fail(PE_UNEXPECTED_TOKEN);
        anchorStart = -1; // has_anchor.take()
        node = parseBlockSequence();
        if (node < 0) return -1;
        break loop;
      }

      case TK_MAPPING_START: {
        const mappingStart = tStart;
        const mappingIndent = tIndent;
        const mappingLine = tLine;
        const mappingTabAfterIndent = tabAfterIndent;
        if (anchorStart >= 0 && anchorLine === mappingLine) anchorStart = -1;

        const jsonKey = maybeSetJsonKey(flowPairAllowed);
        const map = parseFlowMapping();
        unsetJsonKey(jsonKey);
        if (map < 0) return -1;

        if ((tKind as number) === TK_MAPPING_VALUE) {
          if (tIndent < mappingIndent || (explicitKey && mappingLine !== tLine && tIndent <= mappingIndent)) {
            node = map;
            break loop;
          }
          if (ctxTop === C_FLOW_KEY) {
            node = map;
            break loop;
          }
          // [192] implicit key sits at s-indent(n) (spaces only).
          if (mappingTabAfterIndent && (ctxTop === C_BLOCK_OUT || ctxTop === C_BLOCK_IN)) return fail(PE_TAB_INDENTATION);

          if (cmi >= 0 && cmi === mappingIndent) {
            node = map;
            break loop;
          }

          if (mappingLine !== tLine && !explicitKey) return fail(PE_MULTILINE_IMPLICIT_KEY);

          // [147] flow-map value is ns-flow-node, not a pair.
          if (ctxTop === C_FLOW_IN && !flowPairAllowed) {
            node = map;
            break loop;
          }

          if (checkImplicitKeyAnchors(anchorStart, anchorLine, mapAnchorStart, mappingLine) < 0) return -1;
          anchorStart = -1; mapAnchorStart = -1;
          const parentMap = parseBlockMapping(map, mappingStart, mappingIndent, mappingLine, flowPairAllowed);
          if (parentMap < 0) return -1;
          node = parentMap;
          break loop;
        }
        node = map;
        break loop;
      }

      case TK_MAPPING_KEY: {
        if (isFlowCtx()) {
          // Only reachable when a flow `?` appears in a position where ns-flow-pair is not allowed (e.g. as a
          // flow-map value, or after another `?`).
          return fail(PE_UNEXPECTED_TOKEN);
        }
        // [195] each `?` sits at s-indent(n) (spaces only).
        if (tabAfterIndent) return fail(PE_TAB_INDENTATION);

        const mappingStart = tStart;
        const mappingIndent = tIndent;
        const mappingLine = tLine;

        // A subsequent key of the enclosing mapping, which takes it from the `:`.
        if (cmi >= 0 && cmi === mappingIndent) {
          return parseBlockExplicitKey(mappingStart, mappingIndent, mappingLine);
        }

        // The first key of a new mapping. The mapping's node exists before its key is parsed so the key may alias it.
        anchorStart = -1; // has_anchor.take()
        const id = newCollection(NK_OBJECT, mappingStart);
        const base = csLen;
        const key = parseBlockExplicitKey(mappingStart, mappingIndent, mappingLine);
        if (key < 0) return -1;
        if (parseBlockMappingEntries(key, mappingIndent, mappingLine, flowPairAllowed) < 0) return -1;
        finishCollection(id, base, 2);
        node = id;
        break loop;
      }

      case TK_MAPPING_VALUE: {
        if (ctxTop === C_FLOW_KEY) {
          node = NODE_NULL;
          break loop;
        }
        // [195] block `:` (e-node key) sits at s-indent(n) only.
        if (tabAfterIndent && ctxTop !== C_FLOW_IN) return fail(PE_TAB_INDENTATION);
        if (cmi >= 0 && cmi === tIndent) {
          node = NODE_NULL;
          break loop;
        }
        // [200]/[193] split: a property on the `:` line is the e-node key's; on a prior line it is the [200]
        // block-collection's. Only the key's tag affects resolution.
        const colonLine = tLine;
        if (tagStart >= 0 && tagLine === colonLine) {
          tagStart = -1; // take_tag
        }
        if (checkImplicitKeyAnchors(anchorStart, anchorLine, mapAnchorStart, colonLine) < 0) return -1;
        anchorStart = -1; mapAnchorStart = -1;
        const mapping = parseBlockMapping(NODE_NULL, tStart, tIndent, colonLine, flowPairAllowed);
        if (mapping < 0) return -1;
        node = mapping;
        break loop;
      }

      case TK_SCALAR: {
        const scalarStart = tStart;
        const scalarIndent = tIndent;
        const scalarLine = tLine;
        const scalarTabAfterIndent = tabAfterIndent;

        const jsonKey = tStyle === ST_QUOTED ? maybeSetJsonKey(flowPairAllowed) : false;
        const r = scan(-1, false, true);
        unsetJsonKey(jsonKey);
        if (r < 0) return -1;

        if ((tKind as number) === TK_MAPPING_VALUE) {
          // this might be the start of a new object with an implicit key
          if (tIndent < scalarIndent || (explicitKey && scalarLine !== tLine && tIndent <= scalarIndent)) {
            // `:` belongs to an outer construct (e.g. the explicit-value indicator after `? - a` or `? sky\n: blue`).
            // This scalar is not a key.
            node = NODE_SCALAR;
            break loop;
          }
          // [192] ns-l-block-map-implicit-entry: the key is at s-indent(n) (spaces only). A tab between s-indent and
          // the key means it cannot be a sibling block-map entry; in compact position ([185]) it cannot be the
          // compact mapping's first key either.
          if (scalarTabAfterIndent && (ctxTop === C_BLOCK_OUT || ctxTop === C_BLOCK_IN)) return fail(PE_TAB_INDENTATION);
          if (cmi >= 0 && cmi === scalarIndent) {
            node = NODE_SCALAR;
            break loop;
          }

          if (ctxTop === C_FLOW_KEY) {
            node = NODE_SCALAR;
            break loop;
          }
          // FlowIn | BlockOut | BlockIn
          if (scalarLine !== tLine && !explicitKey) return fail(PE_MULTILINE_IMPLICIT_KEY);

          // [147] flow-map value is ns-flow-node, not a pair. Return the bare scalar; the leftover `:` reaches the
          // caller's [140] check.
          if (ctxTop === C_FLOW_IN && !flowPairAllowed) {
            node = NODE_SCALAR;
            break loop;
          }

          if (checkImplicitKeyAnchors(anchorStart, anchorLine, mapAnchorStart, scalarLine) < 0) return -1;
          anchorStart = -1; mapAnchorStart = -1;
          return parseBlockMapping(NODE_SCALAR, scalarStart, scalarIndent, scalarLine, flowPairAllowed);
        }

        node = NODE_SCALAR;
        break loop;
      }

      case TK_DIRECTIVE: return fail(PE_UNEXPECTED_TOKEN);
      case TK_RESERVED: return fail(PE_UNEXPECTED_TOKEN);
      default: return fail(PE_UNEXPECTED_TOKEN);
    }
  }

  // Whatever was not claimed above belongs to `node`.
  if (mapAnchorStart >= 0) {
    // for the error position
    tStart = mapAnchorStart;
    return fail(PE_MULTIPLE_ANCHORS);
  }
  if (mapTagStart >= 0) {
    tStart = mapTagStart;
    return fail(PE_MULTIPLE_TAGS);
  }
  void anchorLine;
  return node;
}

// Rust `NodeProperties::take_implicit_key_anchors`, for the error it gives: the anchors it returns are dropped (the
// caller clears the state it takes). Returns 0 or -1.
function checkImplicitKeyAnchors(anchorStart: number, anchorLine: number, mapAnchorStart: number, implicitKeyLine: number): number {
  // Two anchors recorded: the outer anchors the [200] block collection; the inner anchors the implicit first key. The
  // key's c-ns-properties are in BLOCK-KEY context (s-separate-in-line), so the inner anchor must share the key's
  // line.
  if (mapAnchorStart >= 0 && anchorStart >= 0 && anchorLine !== implicitKeyLine) return fail(PE_MULTIPLE_ANCHORS);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

// Parses `input[0 .. length)` as Rust `YAML::parse_as_written` does. Returns 0, or the `PE_*` of the error. The
// result is read with the functions below, until the next call. The text must not have NUL bytes in it for Bun to
// treat them as characters: the caller (format/yaml) replaces them.
export function yamlParseAsWritten(input: Uint8Array, length: number): number {
  src = input;
  n = length;
  errKind = PE_NONE;
  errPosValue = 0;
  // [206] l-document-prefix ::= c-byte-order-mark? l-comment*
  const start = n >= 3 && (src[0] | 0) === 0xef && (src[1] | 0) === 0xbb && (src[2] | 0) === 0xbf ? 3 : 0;
  pos = start;
  lineStartPos = start;
  lineIndent = 0;
  tabAfterIndent = false;
  line = 1;
  tKind = TK_EOF;
  tStart = 0;
  tIndent = 0;
  tLine = 1;
  tStyle = ST_PLAIN;
  ctxLen = 0;
  ctxTop = C_BLOCK_OUT;
  biLen = 0;
  explicitDocLine = -1;
  thLen = 0;
  depth = 0;
  tokCount = 0;
  nodeLen = 3;
  poolLen = 0;
  csLen = 0;
  docLen = 0;

  let ok = true;
  try {
    ok = parseStream();
  } catch (e) {
    // The native stack ran out before the budget did.
    fail(PE_STACK_OVERFLOW);
    ok = false;
  }
  if (!ok) {
    switch (errKind) {
      case PE_UNEXPECTED_CHARACTER:
      case PE_UNRESOLVED_TAG_HANDLE:
      case PE_UNEXPECTED_DOCUMENT_START:
      case PE_UNEXPECTED_DOCUMENT_END:
        errPosValue = pos;
        break;
      default:
        errPosValue = tStart;
        break;
    }
    src = EMPTY;
    return errKind;
  }
  src = EMPTY;
  return 0;
}

function parseStream(): boolean {
  if (scan(-1, true, false) < 0) return false;
  // we want one null document if eof, not zero documents.
  let first = true;
  while (first || tKind !== TK_EOF) {
    first = false;
    const root = parseDocument();
    if (root < 0) return false;
    if (docLen === docs.length) growDocs();
    docs[docLen] = root | 0;
    docLen = docLen + 1;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------------------------------------------

// Where `parse_as_written` says the error is (a byte of the text).
export function yamlErrorPos(): number {
  return errPosValue;
}

// Changes how many nested nodes are parsed before `PE_STACK_OVERFLOW` (Rust: as deep as there is stack for).
export function yamlSetMaxDepth(d: number): void {
  maxDepth = d;
}

export function yamlMaxDepth(): number {
  return maxDepth;
}

// The documents (Rust `&[Expr]`)
export function yamlDocCount(): number {
  return docLen;
}

export function yamlDocRoot(i: number): number {
  return docs[i] | 0;
}

// A node (Rust `Expr`): `NK_*`.
export function yamlNodeKind(id: number): number {
  return nodeKind[id] | 0;
}

// `Expr::loc`: where it starts, of an array and an object only (the others are shared and have no place).
export function yamlNodeLoc(id: number): number {
  return nodeLoc[id] | 0;
}

// Number of items of an array, of properties of an object.
export function yamlNodeCount(id: number): number {
  return nodeCount[id] | 0;
}

// The i-th item of an array.
export function yamlItem(id: number, i: number): number {
  return pool[(nodeChild[id] | 0) + i] | 0;
}

// The key and the value of the i-th property of an object.
export function yamlPropKey(id: number, i: number): number {
  return pool[(nodeChild[id] | 0) + 2 * i] | 0;
}

export function yamlPropValue(id: number, i: number): number {
  return pool[(nodeChild[id] | 0) + 2 * i + 1] | 0;
}

// The tokens (Rust `&[SourceToken]`), in the order of the text
export function yamlTokenCount(): number {
  return tokCount;
}

export function yamlTokenKind(i: number): number {
  return tokKind[i] | 0;
}

export function yamlTokenStart(i: number): number {
  return tokStart[i] | 0;
}

export function yamlTokenEnd(i: number): number {
  return tokEnd[i] | 0;
}

// The arrays themselves, for loops (valid until the next parse; read the first `yamlTokenCount()` entries).
export function yamlTokenKinds(): Uint8Array {
  return tokKind;
}

export function yamlTokenStarts(): Int32Array {
  return tokStart;
}

export function yamlTokenEnds(): Int32Array {
  return tokEnd;
}
