// Port of vendor/bun/src/sema/parser/parser/declared.rs.
// Spots, while a file is parsed, a name that may be declared twice in one scope. Only oxc's names need it (`Dialect::oxc_names`):
// for the formatter's dialects `declared.isOn` is false, `openScope`/`closeScope` only count `unopened`, and `declare` is a test.
//
// Rust's `Entry` (u64: scope id in the upper half, depth in the next 16 bits, `flag::*` in the low 16) is a pair of Int32 here:
// `tableScope[place]` and `tableInfo[place]` (= depth << 16 | flags). Rust's `Level`, `log` and `carried` are parallel arrays / rows.
import {
  FLAG_DEFAULT,
  FLAG_EXPORT,
  PAT_IDENT,
  RARE_MAY_REDECLARE,
  RARE_ODD_EXPORT,
  STMT_CLASS,
  STMT_EXPORT_DEFAULT,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_FN,
  STMT_VAR,
  hir,
} from "../../hir.ts";
import { A_default, KNOWN_TEXTS } from "../../atom.ts";
import { hasFailed, lx, p } from "./mod.ts";

// ───────────────────────────── flags ─────────────────────────────
/** oxc's `SymbolFlags`, as far as its `..Excludes` tell them apart. */
const F_VAR = 1 << 0;
const F_LEXICAL = 1 << 1;
const F_CLASS = 1 << 2;
const F_FUNCTION = 1 << 3;
const F_IMPORT = 1 << 4;
const F_ALIAS = 1 << 5;
const F_INTERFACE = 1 << 6;
const F_ENUM = 1 << 7;
const F_CONST_ENUM = 1 << 8;
const F_ENUM_MEMBER = 1 << 9;
const F_TYPE_PARAMETER = 1 << 10;
/** Every namespace counts as one that has values. */
const F_NAMESPACE = 1 << 11;
/** In JavaScript, a function that a block in the scope declares. */
const F_FUNCTION_IN_BLOCK = 1 << 12;

const F_VALUE = F_VAR | F_LEXICAL | F_CLASS | F_FUNCTION | F_ENUM | F_CONST_ENUM | F_ENUM_MEMBER | F_NAMESPACE | F_FUNCTION_IN_BLOCK;
const F_TYPE = F_CLASS | F_INTERFACE | F_ENUM | F_CONST_ENUM | F_ENUM_MEMBER | F_TYPE_PARAMETER | F_ALIAS;

// ───────────────────────────── Declares ─────────────────────────────
/** What a declaration declares its name as. */
export const DECLARES_VAR: number = 0;
/** Also the `e` of `catch (e)`. */
export const DECLARES_PARAMETER: number = 1;
export const DECLARES_LEXICAL: number = 2;
export const DECLARES_FUNCTION: number = 3;
export const DECLARES_CLASS: number = 4;
export const DECLARES_IMPORT: number = 5;
export const DECLARES_ALIAS: number = 6;
export const DECLARES_INTERFACE: number = 7;
export const DECLARES_TYPE_PARAMETER: number = 8;
export const DECLARES_ENUM: number = 9;
export const DECLARES_CONST_ENUM: number = 10;
export const DECLARES_ENUM_MEMBER: number = 11;
export const DECLARES_NAMESPACE: number = 12;

// RULES[kind] = (flag, excludes in TypeScript, excludes in JavaScript), three consecutive ints.
const RULES: Int32Array = new Int32Array([
  F_VAR, F_VALUE & ~(F_VAR | F_FUNCTION), (F_VALUE & ~F_VAR) | F_IMPORT,
  F_VAR, 0, 0,
  F_LEXICAL, F_VALUE, F_VALUE | F_IMPORT,
  F_FUNCTION, F_VALUE & ~(F_FUNCTION | F_NAMESPACE | F_CLASS), F_VALUE | F_IMPORT,
  F_CLASS, (F_VALUE | F_TYPE) & ~(F_NAMESPACE | F_FUNCTION | F_INTERFACE), F_VALUE | F_IMPORT,
  F_IMPORT, F_IMPORT, F_VALUE | F_IMPORT,
  F_ALIAS, F_TYPE, F_TYPE,
  F_INTERFACE, F_TYPE & ~(F_INTERFACE | F_CLASS), F_TYPE,
  F_TYPE_PARAMETER, F_TYPE & ~F_TYPE_PARAMETER, F_TYPE,
  F_ENUM, (F_VALUE | F_TYPE) & ~(F_ENUM | F_NAMESPACE), F_VALUE | F_TYPE,
  F_CONST_ENUM, (F_VALUE | F_TYPE) & ~F_CONST_ENUM, F_VALUE | F_TYPE,
  F_ENUM_MEMBER, F_ENUM_MEMBER, F_ENUM_MEMBER,
  F_NAMESPACE, F_VALUE & ~(F_FUNCTION | F_CLASS | F_ENUM | F_NAMESPACE), F_VALUE,
]);

/** How deep scopes are told apart. In a scope that is deeper the answer is "maybe". */
const DEPTHS = 256;
/** In `Declared.log`, with the place: the name goes up to the function. What is beside it are its flags. */
const HOISTED = 1 << 31;

/** Where a speculative parse began: `Declared.markInto` writes these five ints, `rollbackFrom` reads them. */
export const DECLARED_MARK_INTS = 5;

export class Declared {
  /** Off unless `Dialect::oxc_names`, and once the answer is "maybe". */
  isOn: boolean = false;
  isJavascript: boolean = false;
  /** How many of the innermost scopes have no level yet. */
  unopened: number = 0;
  mask: number = 0;
  /** The stamp (scope, depth << 16) of the innermost scope that has a level. */
  stampScope: number = 0;
  stampInfo: number = 0;
  /** The innermost open scope that a `var` declares in. */
  holdsVars: number = 0;
  /** The id that was given out last. */
  last: number = 0;
  tableScope: Int32Array = new Int32Array(0);
  tableInfo: Int32Array = new Int32Array(0);
  levelId: Int32Array = new Int32Array(0);
  levelLog: Int32Array = new Int32Array(0);
  levelHoldsVars: Int32Array = new Int32Array(0);
  /** Rows (place [| HOISTED], scope, info). */
  log: Int32Array = new Int32Array(96);
  logLen: number = 0;
  /** Rows (place, flags). */
  carried: Int32Array = new Int32Array(32);
  carriedLen: number = 0;
  /** The parameters of the function whose block comes next: (typeParams start, len), (params start, len). */
  paramTypesStart: number = 0;
  paramTypesLen: number = 0;
  paramValuesStart: number = 0;
  paramValuesLen: number = 0;

  /** `has_table`: `noteOddExports` will be called. */
  begin(textLen: number, isOn: boolean, hasTable: boolean, isJavascript: boolean): void {
    this.isOn = isOn;
    this.isJavascript = isJavascript;
    this.unopened = 0;
    if (!isOn && !hasTable) return;
    // A file that has its own atoms numbers them from 0. Beyond a million names some share a place.
    let places = 1;
    const want = (KNOWN_TEXTS.length + (textLen >>> 2)) | 0;
    while (places < want) places = places * 2;
    if (places > 1 << 20) places = 1 << 20;
    if (this.tableScope.length < places) {
      this.tableScope = new Int32Array(places);
      this.tableInfo = new Int32Array(places);
    }
    this.mask = (places - 1) | 0;
    if (this.last > 0x3fffffff) {
      this.tableScope.fill(0);
      this.tableInfo.fill(0);
      this.last = 0;
    }
    // The last file has closed its scopes, unless it was given up.
    if (this.levelId.length !== DEPTHS || (this.stampInfo >>> 16) !== 0) {
      this.levelId = new Int32Array(DEPTHS);
      this.levelLog = new Int32Array(DEPTHS);
      this.levelHoldsVars = new Int32Array(DEPTHS);
    }
    this.last = ((this.last | 0) + 1) | 0;
    this.holdsVars = this.last;
    this.stampScope = this.last;
    this.stampInfo = 0;
    this.levelId[0] = this.last;
    this.logLen = 0;
    this.paramTypesStart = 0;
    this.paramTypesLen = 0;
    this.paramValuesStart = 0;
    this.paramValuesLen = 0;
  }

  isOpen(scope: number, depth: number): boolean {
    return depth < this.levelId.length && (this.levelId[depth] | 0) === scope;
  }

  private logPush(place: number, scope: number, info: number): void {
    const n = this.logLen;
    if (n + 3 > this.log.length) {
      const nl = new Int32Array(this.log.length * 2);
      nl.set(this.log);
      this.log = nl;
    }
    const d = this.log;
    d[n] = place | 0;
    d[n + 1] = scope | 0;
    d[n + 2] = info | 0;
    this.logLen = n + 3;
  }

  private put(place: number, flags: number): void {
    this.tableScope[place] = this.stampScope | 0;
    this.tableInfo[place] = (this.stampInfo | flags) | 0;
  }

  /** Returns whether the name may be declared already by what the declaration can't stand beside. */
  declareName(name: number, kind: number): boolean {
    if (this.unopened !== 0 && !this.openLevels()) return true;
    const r = (kind * 3) | 0;
    const flags = RULES[r] | 0;
    const excludes = (this.isJavascript ? RULES[r + 2] : RULES[r + 1]) | 0;
    const place = name & this.mask;
    const isHoisted = (kind === DECLARES_VAR || (kind === DECLARES_FUNCTION && this.isJavascript)) && this.stampScope !== this.holdsVars;
    if (place < 0 || place >= this.tableScope.length) return false;
    const oldScope = this.tableScope[place] | 0;
    const oldInfo = this.tableInfo[place] | 0;
    const isOpen = this.isOpen(oldScope, oldInfo >>> 16);
    if (isHoisted || isOpen) return this.declareBeside(place, oldScope, oldInfo, flags, excludes, isHoisted);
    this.tableScope[place] = this.stampScope | 0;
    this.tableInfo[place] = (this.stampInfo | flags) | 0;
    return false;
  }

  /** `declare` of a name that an open scope declares, or that goes up to the function. */
  private declareBeside(place: number, oldScope: number, oldInfo: number, flags: number, excludes: number, isHoisted: boolean): boolean {
    if (isHoisted) {
      const above = flags === F_FUNCTION ? F_FUNCTION_IN_BLOCK : flags;
      this.logPush(place | HOISTED, 0, above);
    }
    if (!this.isOpen(oldScope, oldInfo >>> 16)) {
      this.put(place, flags);
      return false;
    }
    const clashes = ((oldInfo & 0xffff) & excludes) !== 0;
    if (oldScope === this.stampScope) {
      this.put(place, (oldInfo & 0xffff) | flags);
      return clashes;
    }
    this.logPush(place, oldScope, oldInfo);
    this.put(place, flags);
    // oxc asks each scope up to the function, and stops at the first that has the name.
    return isHoisted && oldScope >= this.holdsVars && clashes;
  }

  /** Returns `false` where it is too deep. */
  openLevel(holdsVars: boolean): boolean {
    const depth = ((this.stampInfo >>> 16) + 1) | 0;
    if (depth >= this.levelId.length) return false;
    this.last = ((this.last | 0) + 1) | 0;
    this.levelId[depth] = this.last;
    this.levelLog[depth] = this.logLen;
    this.levelHoldsVars[depth] = this.holdsVars;
    this.stampScope = this.last;
    this.stampInfo = (depth << 16) | 0;
    if (holdsVars) this.holdsVars = this.last;
    return true;
  }

  /** Gives the scopes that have none a level. They are blocks. */
  openLevels(): boolean {
    while (this.unopened !== 0) {
      if (!this.openLevel(false)) return false;
      this.unopened = (this.unopened - 1) | 0;
    }
    return true;
  }

  /** Closes the innermost scope, which has a level. */
  closeLevel(): void {
    const depth = this.stampInfo >>> 16;
    if (depth >= this.levelId.length || !this.isOn) return;
    if (this.logLen !== (this.levelLog[depth] | 0)) {
      this.closeLevelWithLog(depth);
      return;
    }
    this.leave(depth);
  }

  private leave(depth: number): void {
    const holds = this.levelHoldsVars[depth] | 0;
    this.levelId[depth] = 0;
    const around = depth > 0 ? depth - 1 : 0;
    this.stampScope = this.levelId[around] | 0;
    this.stampInfo = (around << 16) | 0;
    this.holdsVars = holds;
  }

  /** Puts back what was replaced since the log was `from` long. What goes up to the function is left in `carried`. */
  private unwind(from: number): void {
    this.carriedLen = 0;
    while (this.logLen > from) {
      const n = this.logLen - 3;
      this.logLen = n;
      const place = this.log[n] | 0;
      const scope = this.log[n + 1] | 0;
      const info = this.log[n + 2] | 0;
      if ((place & HOISTED) !== 0) {
        const c = this.carriedLen;
        if (c + 2 > this.carried.length) {
          const nc = new Int32Array(this.carried.length * 2);
          nc.set(this.carried);
          this.carried = nc;
        }
        this.carried[c] = place & ~HOISTED;
        this.carried[c + 1] = info & 0xffff;
        this.carriedLen = c + 2;
      } else if (place < this.tableScope.length) {
        this.tableScope[place] = scope;
        this.tableInfo[place] = info;
      }
    }
  }

  private closeLevelWithLog(depth: number): void {
    const heldVars = this.holdsVars === this.stampScope;
    this.unwind(this.levelLog[depth] | 0);
    this.leave(depth);
    if (heldVars) return;
    const goesOn = this.stampScope !== this.holdsVars;
    for (let i = 0; i < this.carriedLen; i += 2) {
      const place = this.carried[i] | 0;
      const flags = this.carried[i + 1] | 0;
      if (place >= this.tableScope.length) continue;
      const oldScope = this.tableScope[place] | 0;
      const oldInfo = this.tableInfo[place] | 0;
      if (this.isOpen(oldScope, oldInfo >>> 16)) {
        if (oldScope === this.stampScope) {
          this.put(place, (oldInfo & 0xffff) | flags);
        } else {
          this.logPush(place, oldScope, oldInfo);
          this.put(place, flags);
        }
      } else {
        this.put(place, flags);
      }
      if (goesOn) this.logPush(place | HOISTED, 0, flags);
    }
  }

  /** Writes the mark (5 ints) at `out[at ..]`. */
  markInto(out: Int32Array, at: number): void {
    out[at] = this.stampScope | 0;
    out[at + 1] = this.stampInfo | 0;
    out[at + 2] = this.logLen | 0;
    out[at + 3] = this.holdsVars | 0;
    out[at + 4] = this.unopened | 0;
  }

  rollbackFrom(m: Int32Array, at: number): void {
    this.unopened = m[at + 4] | 0;
    if (!this.isOn) return;
    const markStampScope = m[at] | 0;
    const markStampInfo = m[at + 1] | 0;
    this.unwind(m[at + 2] | 0);
    const kept = markStampInfo >>> 16;
    const open = this.stampInfo >>> 16;
    for (let d = kept + 1; d <= open && d < this.levelId.length; d++) this.levelId[d] = 0;
    this.stampScope = markStampScope;
    this.stampInfo = markStampInfo;
    this.holdsVars = m[at + 3] | 0;
  }

  /** Puts `name` in the set `names`, which is an id that no scope has. Only at the end of the file. */
  private addTo(names: number, name: number): void {
    if (name >= 0 && name <= this.mask && name < this.tableScope.length) {
      this.tableScope[name] = names | 0;
      this.tableInfo[name] = 0;
    }
  }

  /** Whether `addTo` has put `name` in the set `names`. */
  private isIn(names: number, name: number): boolean {
    return name >= 0 && name <= this.mask && name < this.tableScope.length && (this.tableScope[name] | 0) === names && (this.tableInfo[name] | 0) === 0;
  }

  /** Whether it was asked about `name` before, or about one that shares its place. */
  private exportsTwice(name: number, names: number): boolean {
    const place = name & this.mask;
    if (place < 0 || place >= this.tableScope.length) return true;
    const was = (this.tableScope[place] | 0) === names && (this.tableInfo[place] | 0) === 0;
    this.tableScope[place] = names | 0;
    this.tableInfo[place] = 0;
    return was;
  }

  /** Whether a JavaScript module, which has been parsed, may export a name twice or one that it doesn't declare. */
  hasOddExports(): boolean {
    let isUndeclared = false;
    let anyLocal = false;
    for (let i = 0; i < hir.nExports; i++) {
      if (isLocalExport(i)) {
        anyLocal = true;
        break;
      }
    }
    const ids = hir.ids;
    const bodyStart = hir.bodyStart | 0;
    const bodyLen = hir.bodyLen | 0;
    if (anyLocal) {
      // The names that a statement of the file declares in plain sight. Any other may be undeclared.
      this.last = ((this.last | 0) + 1) | 0;
      const atTop = this.last;
      for (let k = 0; k < bodyLen; k++) {
        const s = ids[bodyStart + k] | 0;
        if (s < 0 || s >= hir.nStmts) continue;
        const tag = hir.stmtTag[s] | 0;
        if (tag === STMT_FN) {
          this.addTo(atTop, hir.fnName[hir.stmtA[s] | 0] | 0);
        } else if (tag === STMT_CLASS) {
          this.addTo(atTop, hir.className[hir.stmtA[s] | 0] | 0);
        } else if (tag === STMT_VAR) {
          const ls = hir.stmtA[s] | 0;
          const ln = hir.stmtB[s] | 0;
          for (let j = 0; j < ln; j++) {
            const d = ids[ls + j] | 0;
            const pat = hir.varDeclPat[d] | 0;
            if (pat >= 0 && (hir.patTag[pat] | 0) === PAT_IDENT) this.addTo(atTop, hir.patA[pat] | 0);
          }
        }
      }
      for (let i = 0; i < hir.nImports; i++) {
        this.addTo(atTop, hir.importDefault[i] | 0);
        this.addTo(atTop, hir.importNamespace[i] | 0);
        const ns = hir.importNamedStart[i] | 0;
        const nl = hir.importNamedLen[i] | 0;
        for (let j = 0; j < nl; j++) this.addTo(atTop, hir.importSpecLocal[ids[ns + j] | 0] | 0);
      }
      for (let i = 0; i < hir.nExports && !isUndeclared; i++) {
        if (!isLocalExport(i)) continue;
        const ns = hir.exportItemsStart[i] | 0;
        const nl = hir.exportItemsLen[i] | 0;
        for (let j = 0; j < nl; j++) {
          if (!this.isIn(atTop, hir.exportSpecLocal[ids[ns + j] | 0] | 0)) {
            isUndeclared = true;
            break;
          }
        }
      }
    }
    this.last = ((this.last | 0) + 1) | 0;
    const names = this.last;
    let isTwice = false;
    for (let k = 0; k < bodyLen && !isTwice; k++) {
      const s = ids[bodyStart + k] | 0;
      if (s < 0 || s >= hir.nStmts) continue;
      const tag = hir.stmtTag[s] | 0;
      if (tag === STMT_EXPORT_DEFAULT) {
        isTwice = this.exportOnce(A_default, names);
      } else if (tag === STMT_EXPORT_STAR) {
        isTwice = this.exportOnce(hir.stmtB[s] | 0, names);
      } else if (tag === STMT_EXPORT_NAMED) {
        const e = hir.stmtA[s] | 0;
        const ns = hir.exportItemsStart[e] | 0;
        const nl = hir.exportItemsLen[e] | 0;
        for (let j = 0; j < nl; j++) {
          if (this.exportOnce(hir.exportSpecExported[ids[ns + j] | 0] | 0, names)) {
            isTwice = true;
            break;
          }
        }
      } else if (tag === STMT_FN) {
        const f = hir.stmtA[s] | 0;
        const fl = hir.fnFlags[f] | 0;
        isTwice = (fl & FLAG_EXPORT) !== 0 && this.exportOnce((fl & FLAG_DEFAULT) !== 0 ? A_default : hir.fnName[f] | 0, names);
      } else if (tag === STMT_CLASS) {
        const c = hir.stmtA[s] | 0;
        const fl = hir.classFlags[c] | 0;
        isTwice = (fl & FLAG_EXPORT) !== 0 && this.exportOnce((fl & FLAG_DEFAULT) !== 0 ? A_default : hir.className[c] | 0, names);
      } else if (tag === STMT_VAR) {
        const ls = hir.stmtA[s] | 0;
        const ln = hir.stmtB[s] | 0;
        for (let j = 0; j < ln; j++) {
          const d = ids[ls + j] | 0;
          if (((hir.varDeclFlags[d] | 0) & FLAG_EXPORT) === 0) continue;
          const pat = hir.varDeclPat[d] | 0;
          // What a pattern binds is not looked at here.
          if (pat >= 0 && (hir.patTag[pat] | 0) === PAT_IDENT) {
            if (this.exportOnce(hir.patA[pat] | 0, names)) {
              isTwice = true;
              break;
            }
          } else {
            isTwice = true;
            break;
          }
        }
      }
    }
    return isUndeclared || isTwice;
  }

  private exportOnce(name: number, names: number): boolean {
    return name >= 0 && this.exportsTwice(name, names);
  }
}

function isLocalExport(i: number): boolean {
  return (hir.exportHasModuleSpecifier[i] | 0) === 0 && (hir.exportItemsLen[i] | 0) !== 0;
}

// ───────────────────────────── the parser's side ─────────────────────────────

/** The scopes of the file being parsed. One per thread. TODO(oxc): `declared.begin(..)` is called by `run.ts` for the oxc dialect only. */
export const declared: Declared = new Declared();

export function mayRedeclare(): void {
  hir.rareSyntax = hir.rareSyntax | RARE_MAY_REDECLARE;
  declared.isOn = false;
}

/** The scope that is open declares `name`. */
export function declare(name: number, kind: number): void {
  if (declared.isOn) declareName(name, kind);
}

function declareName(name: number, kind: number): void {
  if (declared.isOn && declared.declareName(name, kind)) mayRedeclare();
}

/** The same for the names that `pat` binds. */
export function declarePattern(pat: number, kind: number): void {
  if (declared.isOn) declareNamesOf(pat, kind);
}

function declareNamesOf(pat: number, kind: number): void {
  if (pat >= 0 && pat < hir.nPats && (hir.patTag[pat] | 0) === PAT_IDENT) {
    if (declared.declareName(hir.patA[pat] | 0, kind)) mayRedeclare();
  } else {
    declareNamesIn(pat, kind);
  }
}

/** The parts of a pattern are right before it in the list. */
function declareNamesIn(pat: number, kind: number): void {
  if (pat < 0 || pat >= hir.nPats) return;
  const start = hir.patPos[pat] | 0;
  for (let index = (pat - 1) | 0; index >= 0; index = (index - 1) | 0) {
    if ((hir.patPos[index] | 0) < start) break;
    if ((hir.patTag[index] | 0) === PAT_IDENT) declareName(hir.patA[index] | 0, kind);
  }
}

/** A block, the head and body of a `for`, the cases of a `switch`, a `catch` clause, the members of an enum. */
export function openScope(): void {
  declared.unopened = ((declared.unopened | 0) + 1) | 0;
}

/** The body of a namespace. */
export function openScopeForVars(): void {
  if (declared.isOn) openLevelForVars();
  else declared.unopened = ((declared.unopened | 0) + 1) | 0;
}

function openLevelForVars(): void {
  const d = declared;
  if (!(d.openLevels() && d.openLevel(true))) {
    // The scope is closed like the others that have no level.
    d.unopened = ((d.unopened | 0) + 1) | 0;
    mayRedeclare();
  }
}

/** The function whose block comes next has these. */
export function noteParameters(typesStart: number, typesLen: number, valuesStart: number, valuesLen: number): void {
  const d = declared;
  if (d.isOn) {
    d.paramTypesStart = typesStart;
    d.paramTypesLen = typesLen;
    d.paramValuesStart = valuesStart;
    d.paramValuesLen = valuesLen;
  }
}

/** The block of a function or a static block. A function without one has nothing that its parameters could clash with. */
export function openFunction(): void {
  if (declared.isOn) openLevelOfFunction();
  else declared.unopened = ((declared.unopened | 0) + 1) | 0;
}

function openLevelOfFunction(): void {
  openLevelForVars();
  const d = declared;
  const ts = d.paramTypesStart;
  const tl = d.paramTypesLen;
  const vs = d.paramValuesStart;
  const vl = d.paramValuesLen;
  d.paramTypesStart = 0;
  d.paramTypesLen = 0;
  d.paramValuesStart = 0;
  d.paramValuesLen = 0;
  for (let i = 0; i < tl; i++) {
    const tp = hir.ids[(ts + i) | 0] | 0;
    if (tp >= 0 && tp < hir.nTypeParams) declareName(hir.typeParamName[tp] | 0, DECLARES_TYPE_PARAMETER);
  }
  for (let i = 0; i < vl; i++) {
    const pr = hir.ids[(vs + i) | 0] | 0;
    if (pr >= 0 && pr < hir.nParams && d.isOn) declareNamesOf(hir.paramPat[pr] | 0, DECLARES_PARAMETER);
  }
}

export function closeScope(): void {
  const d = declared;
  if (d.unopened === 0) d.closeLevel();
  else d.unopened = ((d.unopened | 0) - 1) | 0;
}

/** At the end of a JavaScript file: `rare::ODD_EXPORT`. */
export function noteOddExports(): void {
  if (!lx.isOxc || !p.isJavascript || !hir.hasModuleSyntax) return;
  // oxlint prints nothing but the parser's errors about a file that doesn't parse, and the tree has holes then.
  if (hasFailed() || hir.hasParseDiagnostics) return;
  if (declared.hasOddExports()) hir.rareSyntax = hir.rareSyntax | RARE_ODD_EXPORT;
}
