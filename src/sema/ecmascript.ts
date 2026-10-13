// Port of vendor/bun/src/sema/ecmascript.rs: what is no JavaScript, although TypeScript's parser reads it in a JavaScript file and
// `checkJSSyntax` has nothing to say about it: its checker reports it. A tool that follows acorn or Babel does not run the checker,
// and takes a file without a syntax error for JavaScript. Called at the end of a parse of a JavaScript file (`parser/run.ts`).
import {
  DK_JS,
  FLAG_ACCESSOR,
  FLAG_ASYNC,
  FLAG_DEFAULT,
  FLAG_DEFINITE,
  FLAG_EXPORT,
  FLAG_OPTIONAL,
  FLAG_STATIC,
  MEMBER_CONSTRUCTOR,
  MEMBER_GETTER,
  MEMBER_METHOD,
  MEMBER_PROPERTY,
  MEMBER_SETTER,
  MEMBER_STATIC_BLOCK,
  MODK_DECORATOR,
  MODK_KEYWORD,
  MODNAME_IDENT,
  PAT_IDENT,
  PROP_METHOD,
  STMT_EXPORT_AS_NAMESPACE,
  STMT_MODULE,
  hir,
} from "./hir.ts";
import { A_this } from "./atom.ts";
import { modifierText, pushDiagnosticArgs } from "./hir_util.ts";

/** The modifiers that are JavaScript's (`ModifierFlagsJavaScript`). `checkJSSyntax` reports the others. */
const JAVASCRIPT = FLAG_EXPORT | FLAG_STATIC | FLAG_ACCESSOR | FLAG_ASYNC | FLAG_DEFAULT;
const ALL_FLAGS = -1;

// The errors found, as rows of (position, code) in order; the diagnostics are pushed at the end.
let found: Int32Array = new Int32Array(64);
let foundLen = 0;
/** The argument of each error found (the `{0}` of its message), or "". */
let foundArgs: string[] = [];

function push(pos: number, code: number, arg: string = ""): void {
  foundArgs.push(arg);
  if (foundLen + 2 > found.length) {
    const n = new Int32Array(found.length * 2);
    n.set(found);
    found = n;
  }
  found[foundLen] = pos | 0;
  found[foundLen + 1] = code | 0;
  foundLen = (foundLen + 2) | 0;
}

/**
 * The first of the modifiers (list `start`, `len`) that acorn and Babel do not take for a modifier of something that can have those
 * in `allowed`: another one, one for the second time, `static` after another. Only those in `lookedAt` count.
 */
function misplaced(start: number, len: number, allowed: number, lookedAt: number): void {
  let seen = 0;
  for (let i = 0; i < len; i++) {
    const m = hir.ids[(start + i) | 0] | 0;
    if ((hir.modifierKind[m] | 0) !== MODK_KEYWORD) continue;
    const flag = hir.modifierValue[m] | 0;
    if ((lookedAt & flag) === 0) continue;
    if ((allowed & flag) !== flag || (seen & flag) === flag || (flag === FLAG_STATIC && seen !== 0)) {
      push(hir.modifierPos[m] | 0, 1042, modifierText(flag));
      return;
    }
    seen = seen | flag;
  }
}

/** Where the first `sign` from `from` on is. It follows a name that starts or ends there. */
function positionOf(sign: number, from: number): number {
  const text = hir.text;
  const n = hir.sourceLen;
  for (let i = from; i < n; i++) if ((text[i] | 0) === sign) return i;
  return from;
}

/**
 * The errors of the checker's `checkGrammar..` about syntax that only TypeScript has: a modifier of JavaScript where it cannot be,
 * `!` after the name of a variable or of a property of a class, `?` after the name of an accessor or a constructor, `?` and `!` in an
 * object literal, a parameter `this`, `declare module "a"`, `declare global`, `export as namespace a`.
 */
export function reportSyntaxOfTypescript(): void {
  foundLen = 0;
  if (foundArgs.length > 0) foundArgs = [];
  for (let i = 0; i < hir.nStmts; i++) {
    const tag = hir.stmtTag[i] | 0;
    if (tag === STMT_MODULE && (hir.moduleNameKind[hir.stmtA[i] | 0] | 0) !== MODNAME_IDENT) {
      push(hir.stmtStart[i] | 0, 8006, "module");
    } else if (tag === STMT_EXPORT_AS_NAMESPACE) {
      push(hir.stmtStart[i] | 0, 8006, "export as namespace");
    } else if ((hir.stmtModLen[i] | 0) !== 0) {
      misplaced(hir.stmtModStart[i] | 0, hir.stmtModLen[i] | 0, JAVASCRIPT, JAVASCRIPT);
    }
  }
  for (let i = 0; i < hir.nVarDecls; i++) {
    if (((hir.varDeclFlags[i] | 0) & FLAG_DEFINITE) !== 0) {
      const nameEnd = hir.patEnd[hir.varDeclPat[i] | 0] | 0;
      push(positionOf(33 /* ! */, nameEnd), 1255);
    }
  }
  for (let i = 0; i < hir.nParams; i++) {
    const pat = hir.paramPat[i] | 0;
    if (pat >= 0 && (hir.patTag[pat] | 0) === PAT_IDENT && (hir.patA[pat] | 0) === A_this) push(hir.patPos[pat] | 0, 1003);
  }
  for (let i = 0; i < hir.nMembers; i++) {
    const kind = hir.memberKind[i] | 0;
    let allowed: number;
    if (kind === MEMBER_METHOD || kind === MEMBER_CONSTRUCTOR) allowed = FLAG_STATIC | FLAG_ASYNC;
    else if (kind === MEMBER_PROPERTY) allowed = FLAG_STATIC | FLAG_ACCESSOR;
    else if (kind === MEMBER_GETTER || kind === MEMBER_SETTER) allowed = FLAG_STATIC;
    else if (kind === MEMBER_STATIC_BLOCK) allowed = 0;
    else continue;
    const flags = hir.memberFlags[i] | 0;
    if ((flags & FLAG_DEFINITE) !== 0) push(positionOf(33, hir.memberNamePos[i] | 0), 1255);
    // `checkJSSyntax` reports that of a property and of a method.
    if ((flags & FLAG_OPTIONAL) !== 0 && kind !== MEMBER_PROPERTY && kind !== MEMBER_METHOD) {
      push(positionOf(63 /* ? */, hir.memberNamePos[i] | 0), 8009, "?");
    }
    const modStart = hir.memberModStart[i] | 0;
    const modLen = hir.memberModLen[i] | 0;
    misplaced(modStart, modLen, allowed, JAVASCRIPT);
    if (kind === MEMBER_STATIC_BLOCK) {
      for (let k = 0; k < modLen; k++) {
        const m = hir.ids[(modStart + k) | 0] | 0;
        if ((hir.modifierKind[m] | 0) === MODK_DECORATOR) {
          push(hir.modifierPos[m] | 0, 1206);
          break;
        }
      }
    }
  }
  for (let i = 0; i < hir.nProps; i++) {
    const postfix = hir.propPostfixToken[i] | 0;
    if (postfix === 0) continue;
    if ((hir.text[postfix] | 0) === 33) push(postfix, 1255);
    // `checkJSSyntax` reports that of a method.
    else if ((hir.propKind[i] | 0) !== PROP_METHOD) push(postfix, 1162);
  }
  // `modifiers_of_props`: the props that have modifiers.
  for (let i = 0; i < hir.nProps; i++) {
    const modLen = hir.propModLen[i] | 0;
    if (modLen === 0) continue;
    // `checkJSSyntax` looks at the modifiers of a method only.
    if ((hir.propKind[i] | 0) === PROP_METHOD) misplaced(hir.propModStart[i] | 0, modLen, FLAG_ASYNC, JAVASCRIPT);
    else misplaced(hir.propModStart[i] | 0, modLen, 0, ALL_FLAGS);
  }
  for (let k = 0; k < foundLen; k += 2) pushDiagnosticArgs(DK_JS, found[k] | 0, 0, found[k + 1] | 0, foundArgs[k >> 1] === "" ? [] : [foundArgs[k >> 1]]);
}

