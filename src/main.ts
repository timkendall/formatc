// `bun fmt`, compiled with scriptc: `scriptc build src/main.ts -o bin/fmt`. Also runs under `node src/main.ts`.
// It never uses a `Worker`: scriptc compiles a program that does with thread-local globals and a check on every typed-array access.
// The threads of `--threads=N` are child processes of this executable (src/driver/pool.ts), which start with CHILD_ARG.
import { CHILD_ARG, runChild } from "./driver/child.ts";
import { main } from "./driver/entry.ts";

if (process.argv.length === 3 && process.argv[2] === CHILD_ARG) runChild();
else main(process.argv.slice(2));
