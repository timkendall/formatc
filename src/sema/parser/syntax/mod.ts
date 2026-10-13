// Port of vendor/bun/src/lint/linter/syntax/mod.rs, as far as `bun fmt` goes: `refusal_of_prettier(file, types)`, Prettier's reasons to refuse
// a file. (`goes_to_flow` is in src/lint/linter/syntax/mod.ts, ported by the lint-ast agent. oxfmt's `refusal_of_oxfmt` is not ported.)
//
//     if (refusalOfPrettier(src, len, path, typesAreTolerated)) { refusal.message, refusal.at }
//
// The file is the one in `hir` (src/sema/hir.ts). `refusal.at` is a byte offset into the text.
import { DK_GRAMMAR, DK_JS, DK_PARSE, STMT_EXPORT_AS_NAMESPACE, STMT_MODULE, hir } from "../../hir.ts";
import { diagnosticMessage } from "../../messages.ts";
import { skipTrivia } from "../../check/spans.ts";
import { tokenLen } from "../../../lint/tokens/mod.ts";
import { goesToFlow } from "../../../lint/linter/syntax/mod.ts";
import { check } from "./error.ts";
import { firstError as typescriptEstreeFirstError } from "./typescript_estree.ts";
import { refusalOfBabel } from "./espree.ts";


/** Why Prettier refuses to format a file (`Refusal`). */
export class Refusal {
  message: string = "";
  at: number = 0;
}
export const refusal: Refusal = new Refusal();

function refuseWith(message: string, at: number): boolean {
  refusal.message = message;
  refusal.at = at;
  return true;
}

/** The message of the diagnostic at row `i` of `hir.diagnostics` (`bun_sema::messages::format`). */
export function messageOfRow(i: number): string {
  const code = hir.diagnostics[i + 3] | 0;
  const id = hir.diagnostics[i + 4] | 0;
  return diagnosticMessage(code, id >= 0 ? hir.diagArgs[id] : []);
}

function ofCheck(): boolean {
  return check.has ? refuseWith(check.message, check.at) : false;
}

/**
 * `refusal_of_prettier(file, types)`: whether Prettier refuses the file that is in `hir`, and why. `typesTolerated`: the file goes to
 * `flow`, `babel-flow`, `typescript` or `babel-ts` (`TypesInJavaScript::Tolerated`), else `babel` throws at the syntax of TypeScript.
 */
export function refusalOfPrettier(src: Uint8Array, len: number, path: string, typesTolerated: boolean, isScript: boolean): boolean {
  const n = hir.diagnosticsLen;
  if (hir.hasErrors || hir.hasParseDiagnostics) {
    // `import a from "a" assert { .. }` passes. `typescript` accepts it. `babel` does not, but Prettier's own tests have such JavaScript
    // files formatted, by other parsers, and nobody is served by a refusal.
    let anyParse = false;
    for (let i = 0; i < n; i += 5) {
      if ((hir.diagnostics[i] | 0) !== DK_PARSE) continue;
      anyParse = true;
      if ((hir.diagnostics[i + 3] | 0) !== 2880) return refuseWith(messageOfRow(i), hir.diagnostics[i + 1] | 0);
    }
    if (!anyParse) return refuseWith("Unexpected token", 0);
  }
  if (!hir.isJs) {
    typescriptEstreeFirstError(true);
    return ofCheck();
  }
  if (hir.isFlow || goesToFlow(src, len, path)) {
    refusalOfBabel(isScript);
    return ofCheck();
  }
  // Refused even where types are tolerated: `type A = 1`, `a!`, a function without a body, decorators on both sides of `export`.
  const isStrict = !typesTolerated;
  let bestRow = -1;
  let bestAt = 0;
  for (let i = 0; i < n; i += 5) {
    const kind = hir.diagnostics[i] | 0;
    const code = hir.diagnostics[i + 3] | 0;
    const isIt =
      (isStrict && kind === DK_JS) ||
      ((kind === DK_JS || kind === DK_GRAMMAR) && (code === 1206 || code === 8008 || code === 8013 || code === 8017 || code === 8038));
    if (!isIt) continue;
    const start = hir.diagnostics[i + 1] | 0;
    if (bestRow < 0 || start < bestAt) {
      bestRow = i;
      bestAt = start;
    }
  }
  // `declare module "a" {}`, `declare global {}`, `export as namespace A`: the parser says nothing about them. Babel takes `declare` for a
  // name, and expects the `{` of `export {}`.
  let declMessage = "";
  let declAt = -1;
  if (isStrict) {
    const body = hir.bodyStart | 0;
    const count = hir.bodyLen | 0;
    for (let k = 0; k < count; k++) {
      const stmt = hir.ids[body + k] | 0;
      const tag = hir.stmtTag[stmt] | 0;
      if (tag !== STMT_MODULE && tag !== STMT_EXPORT_AS_NAMESPACE) continue;
      const start = hir.stmtStart[stmt] | 0;
      const afterFirstToken = start + tokenLen(src, len, start);
      if (tag === STMT_MODULE) {
        declMessage = "Missing semicolon.";
        declAt = afterFirstToken;
      } else {
        declMessage = 'Unexpected token, expected "{"';
        declAt = skipTrivia(src, len, afterFirstToken);
      }
      break;
    }
  }
  // Babel throws at once at what it cannot parse. After an early error it goes on, and Prettier throws it at the end.
  let bestMessage = "";
  let at = -1;
  if (bestRow >= 0) {
    bestMessage = messageOfRow(bestRow);
    at = bestAt;
  }
  if (declAt >= 0 && (at < 0 || declAt < at)) {
    bestMessage = declMessage;
    at = declAt;
  }
  if (at >= 0) return refuseWith(bestMessage, at);
  refusalOfBabel(isScript);
  return ofCheck();
}
