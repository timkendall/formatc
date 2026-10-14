// Port of the tests of vendor/bun/src/md/unicode.rs. Run: node src/md/unicode.test.ts
import assert from "node:assert";
import { FOLD, caseFold } from "./unicode.ts";

function fold(cp: number): number[] {
  caseFold(cp);
  const FOLD$ = FOLD;
  return [FOLD$.c0, FOLD$.c1, FOLD$.c2].slice(0, FOLD$.n);
}

const tests: [string, () => void][] = [
  ["ascii_case_folding", () => {
    assert.deepStrictEqual(fold(0x41), [0x61]);
    assert.deepStrictEqual(fold(0x5a), [0x7a]);
    assert.deepStrictEqual(fold(0x61), [0x61]);
    assert.deepStrictEqual(fold(0x30), [0x30]);
  }],
  ["latin_1_supplement_case_folding", () => {
    assert.deepStrictEqual(fold(0x00c0), [0x00e0]);
    assert.deepStrictEqual(fold(0x00d6), [0x00f6]);
  }],
  ["greek_case_folding", () => {
    assert.deepStrictEqual(fold(0x0391), [0x03b1]);
  }],
  ["cyrillic_case_folding", () => {
    assert.deepStrictEqual(fold(0x0410), [0x0430]);
  }],
  ["two_codepoint_fold_german_eszett", () => {
    assert.deepStrictEqual(fold(0x00df), [0x73, 0x73]);
  }],
  ["two_codepoint_fold_fi_ligature", () => {
    assert.deepStrictEqual(fold(0xfb01), [0x66, 0x69]);
  }],
  ["three_codepoint_fold_ffi_ligature", () => {
    assert.deepStrictEqual(fold(0xfb03), [0x66, 0x66, 0x69]);
  }],
  ["alternating_range_latin_extended_a", () => {
    assert.deepStrictEqual(fold(0x0100), [0x0101]);
    assert.deepStrictEqual(fold(0x0101), [0x0101]);
    assert.deepStrictEqual(fold(0x0102), [0x0103]);
  }],
  ["no_mapping_already_lowercase_or_not_a_letter", () => {
    assert.deepStrictEqual(fold(0x0600), [0x0600]);
  }],
  ["omega_symbol", () => {
    assert.deepStrictEqual(fold(0x2126), [0x03c9]);
  }],
  ["fullwidth_latin_uppercase", () => {
    assert.deepStrictEqual(fold(0xff21), [0xff41]);
  }],
  ["deseret_alphabet", () => {
    assert.deepStrictEqual(fold(0x10400), [0x10428]);
  }],
  ["micro_sign", () => {
    assert.deepStrictEqual(fold(0x00b5), [0x03bc]);
  }],
  ["kelvin_sign", () => {
    assert.deepStrictEqual(fold(0x212a), [0x006b]);
  }],
];

for (const [name, fn] of tests) {
  fn();
  console.log("ok", name);
}
