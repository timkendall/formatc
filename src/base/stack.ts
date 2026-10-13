// Bun's `format/stack.rs`: how deep something can be nested, as deep as there is stack for.
//
// Rust asks the real stack pointer (`StackCheck::is_safe_to_recurse`). scriptc has no stack-pointer API, so
// here it is a recursion-depth budget: a counter that the recursive "doors" (the function that formats an
// expression, a statement, a type, a JSON value, a node of the parser, ...) enter and leave.
//
// ## The choice of numbers (measured, scratch/ in this repo; scriptc 0.3.0, Apple M5, release build)
//   - scriptc worker threads have 8 MiB stacks. A recursive function with a dozen locals costs ~130 bytes per
//     frame (63,000 frames), a trivial one ~50 bytes (169,000). The real formatter/parser functions have more
//     locals and a "door" (e.g. format expression -> write_x -> format child) is ~6-10 frames, so we
//     budget up to 6 KiB per door: 8 MiB / 6 KiB = ~1,400. The default limit is 1,000 nested doors, leaving
//     a margin of ~25% for the non-recursive frames below and above (driver, worker, printer).
//   - Node's default main-thread stack (984 KB) recurses 4,800 frames of the 130-byte function (10,000 of the
//     trivial one), so under `node` a limit of 1,000 doors can overflow before it triggers. That only matters for
//     development runs on deeply nested input: run them with `node --stack-size=7000` (and `ulimit -s unlimited` /
//     8 MB) or lower the limit with `setDefaultLimit()`. Tests that need the guard to trigger use a small limit.
//   - The IR printer does not recurse per nesting level of the document (it uses explicit queues); only
//     `print_entry` (fill items and best-fitting variants nested in each other) does, and it asks too.
//
// ## Usage (the difference to Rust)
// Rust: `if !stack.has_room() { return }` (no matching exit, the real stack pointer comes back by itself).
// Here a counter has to come back too, so the door brackets its recursion:
//
//     if (!stack.enter()) return;      // false: out of room, `stack.ranOut()` is now true, return anything
//     ...recurse...
//     stack.leave();                   // exactly once per successful enter(), on every path out
//
// or, if the function already has a depth parameter, no state at all: `if (!stack.hasRoomAt(depth)) return;`.
// "One that is told no goes on with anything: whoever started the work asks `ranOut()` at the end and answers
// with `FormatError.NestedTooDeeply`."
export const DEFAULT_LIMIT_INITIAL = 1000;
let defaultLimit = DEFAULT_LIMIT_INITIAL;

// Changes the limit of the stacks created after this call (tests, development under node).
export function setDefaultLimit(limit: number): void {
  defaultLimit = limit;
}

export function getDefaultLimit(): number {
  return defaultLimit;
}

export class Stack {
  depth: number;
  limit: number;
  ranOutFlag: boolean;
  constructor(limit: number) {
    this.depth = 0;
    this.limit = limit;
    this.ranOutFlag = false;
  }
  // Rust `Stack::new()`: for what walks a tree that has been walked.
  static create(): Stack {
    return new Stack(defaultLimit);
  }
  // Rust `Stack::for_tree()`: for what builds a tree that is walked afterwards (the parser), and the first that
  // calls itself for a tree that a loop has built. It leaves room for what comes afterwards: 3/4 of the budget.
  static forTree(): Stack {
    return new Stack(Math.floor((defaultLimit * 3) / 4));
  }
  // Stateless check for functions that thread their own `depth` parameter.
  hasRoomAt(depth: number): boolean {
    if (this.ranOutFlag) return false;
    if (depth >= this.limit) {
      this.ranOutFlag = true;
      return false;
    }
    return true;
  }
  // Rust `has_room()` without entering: false once it has run out.
  hasRoom(): boolean {
    return this.hasRoomAt(this.depth);
  }
  // Enters one level of nesting. On `false` nothing was entered: do not call `leave()`.
  enter(): boolean {
    if (this.ranOutFlag) return false;
    const d = this.depth;
    if (d >= this.limit) {
      this.ranOutFlag = true;
      return false;
    }
    this.depth = d + 1;
    return true;
  }
  leave(): void {
    this.depth = this.depth - 1;
  }
  ranOut(): boolean {
    return this.ranOutFlag;
  }
  // For reuse across files: clears the depth and the "ran out" flag.
  reset(): void {
    this.depth = 0;
    this.ranOutFlag = false;
  }
}
