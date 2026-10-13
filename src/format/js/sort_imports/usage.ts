// What `is_used` of organize.rs asks the binder: whether a name that the file imports is referred to. There is no binder in this port, so this
// walks the tree (`nodeChildren`) with the scopes that matter for the question: a name that is declared in a function, a block, a class, a
// type, .. hides the import in it. A reference is an identifier in an expression (also the tag of JSX), the first name of a type or of
// the target of `import a = b.c`, and the local name of `export { a }`. `declarations` counts what a name is declared as at the top (more than
// one: the declarations are merged, as TypeScript's `symbol.declarations.length > 1`).
import { I32Vec } from "../../../sema/vec.ts";
import {
  EXPR_IDENT,
  FN_EXPR,
  IET_ENTITY,
  MODNAME_IDENT,
  N_CASE,
  N_CLASS,
  N_EXPR,
  N_FILE,
  N_FUNC,
  N_STMT,
  N_TYPE,
  N_VAR_DECL,
  STMT_BLOCK,
  STMT_CLASS,
  STMT_ENUM,
  STMT_EXPORT_NAMED,
  STMT_FN,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IMPORT,
  STMT_IMPORT_EQUALS,
  STMT_INTERFACE,
  STMT_MODULE,
  STMT_SWITCH,
  STMT_TRY,
  STMT_TYPE_ALIAS,
  STMT_VAR,
  TYPE_COND,
  TYPE_INFER,
  TYPE_MAPPED,
  TYPE_REF,
  VAR_VAR,
  aliasName,
  className,
  entityAtom,
  enumMembersLen,
  enumMembersStart,
  enumName,
  exportItemsLen,
  exportItemsStart,
  exportHasFrom,
  exportSpecLocal,
  exprIdentName,
  exprIsJsxTagName,
  exprTag,
  funcKind,
  funcName,
  funcParamsLen,
  funcParamsStart,
  funcTypeParamsLen,
  funcTypeParamsStart,
  hir,
  importDefault,
  importEqualsEntityLen,
  importEqualsEntityStart,
  importEqualsName,
  importEqualsTargetKind,
  importNamedLen,
  importNamedStart,
  importNamespace,
  importSpecLocal,
  interfaceName,
  interfaceTypeParamsLen,
  interfaceTypeParamsStart,
  aliasTypeParamsLen,
  aliasTypeParamsStart,
  classTypeParamsLen,
  classTypeParamsStart,
  listAt,
  moduleName,
  moduleNameKind,
  nameBuf,
  nameStart,
  nodeChildren,
  nodeId,
  nodeKind,
  nodeOfStmt,
  paramPat,
  patBindings,
  patIdentName,
  stmtClassClass,
  stmtEnumEnum,
  stmtExportNamedExport,
  stmtFnFn,
  stmtImportEqualsImportEquals,
  stmtImportImport,
  stmtModuleModule,
  stmtTag,
  stmtTryBlock,
  stmtTryFinalizer,
  stmtTryHandler,
  stmtTryParam,
  stmtTypeAliasAlias,
  stmtInterfaceInterface,
  stmtVarDeclsLen,
  stmtVarDeclsStart,
  typeCondExtends,
  typeInferParam,
  typeMappedMapped,
  typeParamName,
  typeRefNameStart,
  typeRefNameLen,
  typeTag,
  varDeclKind,
  varDeclPat,
  mappedParam,
  nodeOfType,
} from "../../../lint/ast/index.ts";

/** What the walk found. */
export class Usage {
  /** The names that are referred to, where the top scope is what they mean. */
  refs: Set<number> = new Set<number>();
  /** How many times the names are declared at the top. */
  declarations: Map<number, number> = new Map<number, number>();
  scopes: Set<number>[] = [];
  /** The top scope is the one of the root. */
  scratch: I32Vec = new I32Vec(64);

  isShadowed(atom: number): boolean {
    for (let i = this.scopes.length - 1; i >= 0; i--) if ((this.scopes[i] as Set<number>).has(atom)) return true;
    return false;
  }

  ref(atom: number): void {
    if (atom < 0) return;
    if (!this.isShadowed(atom)) this.refs.add(atom);
  }

  /** Declares `atom` in the innermost scope, or counts it if the walk is at the top. */
  declare(atom: number): void {
    if (atom < 0) return;
    if (this.scopes.length === 0) {
      const n = this.declarations.get(atom);
      this.declarations.set(atom, n === undefined ? 1 : n + 1);
    } else {
      (this.scopes[this.scopes.length - 1] as Set<number>).add(atom);
    }
  }

  declarePattern(pat: number): void {
    const base = this.scratch.len;
    patBindings(pat, this.scratch);
    const end = this.scratch.len;
    // The vector may be used by the calls below: copy the ids first.
    const ids: number[] = [];
    for (let i = base; i < end; i++) ids.push(this.scratch.data[i] | 0);
    this.scratch.len = base;
    for (let i = 0; i < ids.length; i++) this.declare(patIdentName(ids[i] as number));
  }

  /** Declares what the statements declare in their scope (`let`, `const`, functions, classes, ..), and `var`s of them and of what is nested. */
  predeclare(statements: number[], hoistVars: boolean): void {
    for (let i = 0; i < statements.length; i++) {
      const s = nodeId(statements[i] as number);
      switch (stmtTag(s)) {
        case STMT_VAR: {
          const start = stmtVarDeclsStart(s);
          const len = stmtVarDeclsLen(s);
          for (let k = 0; k < len; k++) {
            const d = listAt(start, k);
            if (varDeclKind(d) !== VAR_VAR) this.declarePattern(varDeclPat(d));
          }
          break;
        }
        case STMT_FN:
          this.declare(funcName(stmtFnFn(s)));
          break;
        case STMT_CLASS:
          this.declare(className(stmtClassClass(s)));
          break;
        case STMT_ENUM:
          this.declare(enumName(stmtEnumEnum(s)));
          break;
        case STMT_MODULE: {
          const m = stmtModuleModule(s);
          if (moduleNameKind(m) === MODNAME_IDENT) this.declare(moduleName(m));
          break;
        }
        case STMT_INTERFACE:
          this.declare(interfaceName(stmtInterfaceInterface(s)));
          break;
        case STMT_TYPE_ALIAS:
          this.declare(aliasName(stmtTypeAliasAlias(s)));
          break;
        case STMT_IMPORT_EQUALS:
          this.declare(importEqualsName(stmtImportEqualsImportEquals(s)));
          break;
        case STMT_IMPORT: {
          const imp = stmtImportImport(s);
          if (importDefault(imp) >= 0) this.declare(importDefault(imp));
          if (importNamespace(imp) >= 0) this.declare(importNamespace(imp));
          const n = importNamedLen(imp);
          const ns = importNamedStart(imp);
          for (let k = 0; k < n; k++) this.declare(importSpecLocal(listAt(ns, k)));
          break;
        }
        default:
          break;
      }
      if (hoistVars) this.hoistVars(statements[i] as number);
    }
  }

  /** The `var`s in `node` and what is nested in it, but not in functions. */
  hoistVars(node: number): void {
    const out = new I32Vec(16);
    nodeChildren(node, -1, out);
    const children: number[] = [];
    for (let i = 0; i < out.len; i++) children.push(out.data[i] | 0);
    for (let i = 0; i < children.length; i++) {
      const c = children[i] as number;
      const kind = nodeKind(c);
      if (kind === N_VAR_DECL) {
        if (varDeclKind(nodeId(c)) === VAR_VAR) this.declarePattern(varDeclPat(nodeId(c)));
      } else if (kind === N_STMT || kind === N_CASE) {
        this.hoistVars(c);
      }
    }
  }

  push(): void {
    this.scopes.push(new Set<number>());
  }

  pop(): void {
    this.scopes.pop();
  }

  childrenOf(node: number): number[] {
    const out = new I32Vec(16);
    nodeChildren(node, -1, out);
    const children: number[] = [];
    for (let i = 0; i < out.len; i++) children.push(out.data[i] | 0);
    return children;
  }

  walkChildren(node: number): void {
    const children = this.childrenOf(node);
    for (let i = 0; i < children.length; i++) this.walk(children[i] as number);
  }

  statementsOf(children: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < children.length; i++) if (nodeKind(children[i] as number) === N_STMT) out.push(children[i] as number);
    return out;
  }

  walk(node: number): void {
    const kind = nodeKind(node);
    const id = nodeId(node);
    switch (kind) {
      case N_EXPR:
        if (exprTag(id) === EXPR_IDENT) {
          if (exprIsJsxTagName(id)) {
            // An intrinsic element: `<a />`.
            const atom = exprIdentName(id);
            const c = nameBuf(atom)[nameStart(atom)] | 0;
            if (c >= 97 && c <= 122) return;
          }
          this.ref(exprIdentName(id));
          return;
        }
        this.walkChildren(node);
        return;
      case N_STMT:
        this.walkStmt(node, id);
        return;
      case N_FUNC: {
        this.push();
        const tps = funcTypeParamsStart(id);
        for (let i = 0; i < funcTypeParamsLen(id); i++) this.declare(typeParamName(listAt(tps, i)));
        const ps = funcParamsStart(id);
        for (let i = 0; i < funcParamsLen(id); i++) this.declarePattern(paramPat(listAt(ps, i)));
        if (funcKind(id) === FN_EXPR) this.declare(funcName(id));
        const children = this.childrenOf(node);
        this.predeclare(this.statementsOf(children), true);
        for (let i = 0; i < children.length; i++) this.walk(children[i] as number);
        this.pop();
        return;
      }
      case N_CLASS: {
        this.push();
        const tps = classTypeParamsStart(id);
        for (let i = 0; i < classTypeParamsLen(id); i++) this.declare(typeParamName(listAt(tps, i)));
        this.declare(className(id));
        this.walkChildren(node);
        this.pop();
        return;
      }
      case N_TYPE:
        this.walkType(node, id);
        return;
      default:
        this.walkChildren(node);
        return;
    }
  }

  walkType(node: number, t: number): void {
    switch (typeTag(t)) {
      case TYPE_REF: {
        const start = typeRefNameStart(t);
        if (typeRefNameLen(t) > 0) this.ref(entityAtom(start, 0));
        this.walkChildren(node);
        return;
      }
      case TYPE_COND: {
        this.push();
        this.declareInfers(typeCondExtends(t));
        this.walkChildren(node);
        this.pop();
        return;
      }
      case TYPE_MAPPED: {
        this.push();
        this.declare(typeParamName(mappedParam(typeMappedMapped(t))));
        this.walkChildren(node);
        this.pop();
        return;
      }
      default:
        this.walkChildren(node);
        return;
    }
  }

  /** The names that `infer` declares in the type `t`. */
  declareInfers(t: number): void {
    if (t < 0) return;
    if (typeTag(t) === TYPE_INFER) this.declare(typeParamName(typeInferParam(t)));
    const children = this.childrenOf(nodeOfType(t));
    for (let i = 0; i < children.length; i++) {
      const c = children[i] as number;
      if (nodeKind(c) === N_TYPE) this.declareInfers(nodeId(c));
    }
  }

  walkStmt(node: number, s: number): void {
    switch (stmtTag(s)) {
      case STMT_BLOCK: {
        this.push();
        const children = this.childrenOf(node);
        this.predeclare(this.statementsOf(children), false);
        for (let i = 0; i < children.length; i++) this.walk(children[i] as number);
        this.pop();
        return;
      }
      case STMT_FOR:
      case STMT_FOR_IN:
      case STMT_FOR_OF: {
        this.push();
        const children = this.childrenOf(node);
        this.predeclare(this.statementsOf(children), false);
        for (let i = 0; i < children.length; i++) this.walk(children[i] as number);
        this.pop();
        return;
      }
      case STMT_SWITCH: {
        this.push();
        const children = this.childrenOf(node);
        for (let i = 0; i < children.length; i++) {
          if (nodeKind(children[i] as number) === N_CASE) this.predeclare(this.statementsOf(this.childrenOf(children[i] as number)), false);
        }
        for (let i = 0; i < children.length; i++) this.walk(children[i] as number);
        this.pop();
        return;
      }
      case STMT_TRY: {
        const block = stmtTryBlock(s);
        const param = stmtTryParam(s);
        const handler = stmtTryHandler(s);
        const finalizer = stmtTryFinalizer(s);
        if (block >= 0) this.walk(nodeOfStmt(block));
        if (param >= 0) {
          this.push();
          this.declarePattern(varDeclPat(param));
          this.walkChildren(nodeOfVarDeclHandle(param));
          if (handler >= 0) this.walk(nodeOfStmt(handler));
          this.pop();
        } else if (handler >= 0) {
          this.walk(nodeOfStmt(handler));
        }
        if (finalizer >= 0) this.walk(nodeOfStmt(finalizer));
        return;
      }
      case STMT_INTERFACE: {
        const i = stmtInterfaceInterface(s);
        this.push();
        const tps = interfaceTypeParamsStart(i);
        for (let k = 0; k < interfaceTypeParamsLen(i); k++) this.declare(typeParamName(listAt(tps, k)));
        this.walkChildren(node);
        this.pop();
        return;
      }
      case STMT_TYPE_ALIAS: {
        const a = stmtTypeAliasAlias(s);
        this.push();
        const tps = aliasTypeParamsStart(a);
        for (let k = 0; k < aliasTypeParamsLen(a); k++) this.declare(typeParamName(listAt(tps, k)));
        this.walkChildren(node);
        this.pop();
        return;
      }
      case STMT_ENUM: {
        // The members are in scope in the initializers: `enum E { a, b = a }`.
        const e = stmtEnumEnum(s);
        this.push();
        const ms = enumMembersStart(e);
        for (let k = 0; k < enumMembersLen(e); k++) this.declare(enumMemberNameAtom(listAt(ms, k)));
        this.walkChildren(node);
        this.pop();
        return;
      }
      case STMT_MODULE: {
        this.push();
        const children = this.childrenOf(node);
        this.predeclare(this.statementsOf(children), true);
        for (let i = 0; i < children.length; i++) this.walk(children[i] as number);
        this.pop();
        return;
      }
      case STMT_EXPORT_NAMED: {
        const x = stmtExportNamedExport(s);
        if (!exportHasFrom(x)) {
          const start = exportItemsStart(x);
          for (let k = 0; k < exportItemsLen(x); k++) this.ref(exportSpecLocal(listAt(start, k)));
        }
        this.walkChildren(node);
        return;
      }
      case STMT_IMPORT_EQUALS: {
        const i = stmtImportEqualsImportEquals(s);
        if (importEqualsTargetKind(i) === IET_ENTITY && importEqualsEntityLen(i) > 0) this.ref(entityAtom(importEqualsEntityStart(i), 0));
        return;
      }
      default:
        this.walkChildren(node);
        return;
    }
  }
}

function nodeOfVarDeclHandle(d: number): number {
  // `Node::VarDecl(d)`
  return (13 << 26) | d;
}

function enumMemberNameAtom(m: number): number {
  return hir.enumMemberName[m] | 0;
}

/**
 * The usage of the names in the statements `(start, len)` of the file (`root` is `N_FILE`) or of the body of a module (`root` is the
 * statement of the module).
 */
export function usageOf(root: number): Usage {
  const usage = new Usage();
  const children = usage.childrenOf(root);
  const statements = usage.statementsOf(children);
  usage.predeclare(statements, true);
  for (let i = 0; i < children.length; i++) usage.walk(children[i] as number);
  return usage;
}

export const _fileKind: number = N_FILE;
