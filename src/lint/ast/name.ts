// Port of vendor/bun/src/lint/ast/name.rs: `Name` and `Ident`.
//
// A `Name` (the text of an identifier, a property name or a string) is its ATOM: an Int32 of the file's atom table, interned, so
// two names of a file compare with `===` (`Name == Name`). `NONE` is `-1` (`Option<Name>::None`). The text is read through
// `nameBuf(a)` / `nameStart(a)` / `nameLen(a)`: the bytes `nameBuf(a)[nameStart(a) .. nameStart(a) + nameLen(a))` (UTF-8; the
// escapes of the source are resolved: `a` is `a`).
//
// An `Ident` (a name where it is written) is TWO numbers: `(atom, start)`. A function that takes one takes both.
import { hir } from "../../sema/hir.ts";
import { SP } from "../span.ts";
import { tokenEnd } from "../../sema/check/spans.ts";
import { F } from "./state.ts";

/** The buffer that has the text of `atom`: the source, or the file's table of decoded texts. */
export function nameBuf(atom: number): Uint8Array {
  return F.names.textBuf(atom);
}
export function nameStart(atom: number): number {
  return F.names.textStart(atom);
}
/** `Name::len` */
export function nameLen(atom: number): number {
  return atom < 0 ? 0 : F.names.textLen(atom);
}

/** `Name::is(text)`: the name is the ASCII text `lit`. Not for hot paths with a constant: compare with a known atom (`A_*`) instead. */
export function nameIs(atom: number, lit: string): boolean {
  return F.names.atomIs(atom, lit);
}

/** Whether the text of `atom` equals `buf[start, start + len)`. */
export function nameEqualsBytes(atom: number, buf: Uint8Array, start: number, len: number): boolean {
  const F$ = F;
  if (atom < 0 || F$.names.textLen(atom) !== len) return false;
  const b = F$.names.textBuf(atom);
  const o = F$.names.textStart(atom);
  for (let i = 0; i < len; i++) if ((b[(o + i) | 0] | 0) !== (buf[(start + i) | 0] | 0)) return false;
  return true;
}

/** The atom of the bytes `buf[start, end)` (interned if new). */
export function nameIntern(buf: Uint8Array, start: number, end: number): number {
  return F.names.atomOfBytes(buf, start, end);
}

/** `Name::bytes() == []`: the empty name. */
export function nameIsEmpty(atom: number): boolean {
  return nameLen(atom) === 0;
}

// ───────────────────────────── Ident ─────────────────────────────

/** `Ident::is_string`: it is written as a string: `import { "a b" as c }`, `declare module "m"`. */
export function identIsString(start: number): boolean {
  const hir$ = hir;
  if (start >= hir$.sourceLen) return false;
  const c = hir$.text[start] | 0;
  return c === 34 || c === 39;
}

/** `Ident::span().end`: where the name that is written at `start` ends. */
export function identEndOf(atom: number, start: number): number {
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  const F$ = F;
  if (atom >= 0 && start < len) {
    const n = F$.names.textLen(atom);
    const c0 = text[start] | 0;
    // `written_len`: it is written as it is, or it has escapes or is in quotes.
    if (n !== 0 && c0 !== 34 && c0 !== 39 && start + n <= len) {
      const b = F$.names.textBuf(atom);
      const o = F$.names.textStart(atom);
      if (b === text && o === start) return (start + n) | 0;
      let same = true;
      for (let i = 0; i < n; i++) {
        if ((b[(o + i) | 0] | 0) !== (text[(start + i) | 0] | 0)) {
          same = false;
          break;
        }
      }
      if (same) return (start + n) | 0;
    }
  }
  return tokenEnd(text, len, start, false);
}

/** `Ident::span` into `SP`. */
export function identSpan(atom: number, start: number): void {
  SP[0] = start | 0;
  SP[1] = identEndOf(atom, start);
}

// ───────────────────────────── EntityName ─────────────────────────────
// `A`, `A.B.C`: a name in a type that is not an expression. A list `(start, len)` of NameIds in `hir.ids`; the part `i`
// is the Ident `(entityAtom(start, i), entityPos(start, i))`.

/** The atom of the part `i` (counted from the left) of the entity name `(start, len)`. */
export function entityAtom(start: number, i: number): number {
  const hir$ = hir;
  return hir$.nameText[hir$.ids[(start + i) | 0] | 0] | 0;
}
/** Where the part `i` starts. */
export function entityPos(start: number, i: number): number {
  const hir$ = hir;
  return hir$.namePos[hir$.ids[(start + i) | 0] | 0] | 0;
}
/** `EntityName::span` into `SP` (an empty entity gives `(0, 0)`). */
export function entitySpan(start: number, len: number): void {
  if (len <= 0) {
    SP[0] = 0;
    SP[1] = 0;
    return;
  }
  SP[0] = entityPos(start, 0);
  identSpan(entityAtom(start, len - 1), entityPos(start, len - 1));
  const end = SP[1] | 0;
  SP[0] = entityPos(start, 0);
  SP[1] = end;
}
/** `EntityName::is(name)`: it is the single name `lit`. */
export function entityIs(start: number, len: number, lit: string): boolean {
  return len === 1 && F.names.atomIs(entityAtom(start, 0), lit);
}
