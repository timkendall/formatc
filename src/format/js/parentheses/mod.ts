// Port of vendor/bun/src/format/js/parentheses/mod.rs: parentheses are not part of the syntax tree. Those of the source are dropped, and a
// node is written in parentheses if it needs them where it is: to mean the same, to be valid syntax, or, in a few cases, to be easier to
// read (`(a && b) || c`). See expression.ts and ts_type.ts.
export {};
