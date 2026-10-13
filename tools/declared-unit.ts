// Unit checks of `declared.ts` (redeclaration tracking for oxc's names). node tools/declared-unit.ts
import { declared, declare, openScope, closeScope, openScopeForVars, DECLARES_VAR, DECLARES_LEXICAL, DECLARES_FUNCTION, DECLARES_CLASS, DECLARES_INTERFACE, DECLARES_ALIAS, DECLARES_NAMESPACE, DECLARES_ENUM, DECLARES_IMPORT } from "../src/sema/parser/parser/declared.ts";
import { hir } from "../src/sema/hir.ts";
import { RARE_MAY_REDECLARE } from "../src/sema/hir.ts";

let fails = 0;
function run(name: string, js: boolean, expect: boolean, steps: () => void): void {
  hir.reset();
  declared.begin(1000, true, false, js);
  steps();
  const got = (hir.rareSyntax & RARE_MAY_REDECLARE) !== 0;
  if (got !== expect) {
    fails++;
    console.log("FAIL", name, "expected", expect, "got", got);
  }
}
const A = 100;
const B = 101;
run("let let", false, true, () => { declare(A, DECLARES_LEXICAL); declare(A, DECLARES_LEXICAL); });
run("var var", false, false, () => { declare(A, DECLARES_VAR); declare(A, DECLARES_VAR); });
run("var let", false, true, () => { declare(A, DECLARES_VAR); declare(A, DECLARES_LEXICAL); });
run("let var", false, true, () => { declare(A, DECLARES_LEXICAL); declare(A, DECLARES_VAR); });
run("let a; {let a}", false, false, () => { declare(A, DECLARES_LEXICAL); openScope(); declare(A, DECLARES_LEXICAL); closeScope(); });
run("{let a} let a", false, false, () => { openScope(); declare(A, DECLARES_LEXICAL); closeScope(); declare(A, DECLARES_LEXICAL); });
run("let a; {var a}", false, true, () => { declare(A, DECLARES_LEXICAL); openScope(); declare(A, DECLARES_VAR); closeScope(); });
run("{var a} let a", false, true, () => { openScope(); declare(A, DECLARES_VAR); closeScope(); declare(A, DECLARES_LEXICAL); });
run("function function (ts)", false, false, () => { declare(A, DECLARES_FUNCTION); declare(A, DECLARES_FUNCTION); });
run("class class", false, true, () => { declare(A, DECLARES_CLASS); declare(A, DECLARES_CLASS); });
run("interface interface", false, false, () => { declare(A, DECLARES_INTERFACE); declare(A, DECLARES_INTERFACE); });
run("interface class", false, false, () => { declare(A, DECLARES_INTERFACE); declare(A, DECLARES_CLASS); });
run("alias alias", false, true, () => { declare(A, DECLARES_ALIAS); declare(A, DECLARES_ALIAS); });
run("alias let (ts)", false, false, () => { declare(A, DECLARES_ALIAS); declare(A, DECLARES_LEXICAL); });
run("namespace namespace", false, false, () => { declare(A, DECLARES_NAMESPACE); declare(A, DECLARES_NAMESPACE); });
run("enum enum", false, false, () => { declare(A, DECLARES_ENUM); declare(A, DECLARES_ENUM); });
run("import let (js)", true, true, () => { declare(A, DECLARES_IMPORT); declare(A, DECLARES_LEXICAL); });
run("two names", false, false, () => { declare(A, DECLARES_LEXICAL); declare(B, DECLARES_LEXICAL); });
run("var in function scope", false, false, () => { openScopeForVars(); declare(A, DECLARES_VAR); closeScope(); declare(A, DECLARES_LEXICAL); });
run("js function function", true, true, () => { declare(A, DECLARES_FUNCTION); declare(A, DECLARES_FUNCTION); });
console.log(fails === 0 ? "declared-unit: all passed" : `declared-unit: ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
