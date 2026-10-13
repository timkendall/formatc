// Generates src/sema/hir.ts (the HIR tables, tags, enums, builders and field accessors) and the table reference of
// docs/HIR_API.md (between the GENERATED markers) from the schema below. Run: node tools/gen-hir.ts
//
// The schema mirrors vendor/bun/src/sema/hir.rs. Conventions of the TS encoding (see docs/HIR_API.md):
//  - every table is struct-of-arrays; a row id is an Int32 index, NONE = -1;
//  - a Rust `Span<T>` AND a Rust `IdList<T>` are both a (start, len) pair into `hir.ids` (no contiguity guarantee);
//  - a Rust enum with payload (ExprKind, StmtKind, TypeNodeKind, PatKind) is a `tag` column plus the payload columns a, b, c, ...
//    and `aux`; the table below says, per variant, which column holds which field.
import * as fs from "node:fs";

type Col = { name: string; t: "u8" | "i32" | "f64"; doc?: string; dflt?: number };
type Field = { name: string; slots: string[]; kind: string; doc?: string };
type Variant = { name: string; rust: string; fields: Field[]; doc?: string };
type Table = {
  key: string; // Hir field prefix, e.g. "expr"
  plural: string; // e.g. "exprs"
  rust: string; // Rust struct
  id: string; // Rust id type
  pushName: string; // e.g. "Expr"
  cols: Col[];
  tagged?: { prefix: string; variants: Variant[]; payload: string[]; head: string[] };
  doc?: string;
  few?: boolean;
};

const I = (name: string, doc?: string, dflt?: number): Col => ({ name, t: "i32", doc, dflt });
const U = (name: string, doc?: string, dflt?: number): Col => ({ name, t: "u8", doc, dflt });
const F = (name: string, kind: string, slots: string[], doc?: string): Field => ({ name, slots, kind, doc });
const V = (name: string, rust: string, fields: Field[], doc?: string): Variant => ({ name, rust, fields, doc });

// field kinds: id:<Table>, atom, pos, flags, bool, enum:<Name>, list:<Of> (2 slots: start,len into hir.ids), num (numbers index), raw
const exprVariants: Variant[] = [
  V("Missing", "Missing", []),
  V("Ident", "Ident(Atom)", [F("name", "atom", ["a"])]),
  V("PrivateIdentifier", "PrivateIdentifier(Atom)", [F("name", "atom", ["a"])], "`#x` that is an expression of its own"),
  V("This", "This", []),
  V("Super", "Super", []),
  V("Null", "Null", []),
  V("True", "True", []),
  V("False", "False", []),
  V("Number", "Number(u32)", [F("index", "num", ["a"], "index into `hir.numbers`")]),
  V("String", "String(Atom)", [F("value", "atom", ["a"])]),
  V("BigInt", "BigInt(Atom)", [F("digits", "atom", ["a"], "decimal digits")]),
  V("Regex", "Regex", []),
  V("Template", "Template { exprs }", [F("exprs", "list:Expr", ["a", "b"], "substitutions; the `len + 1` ids that FOLLOW them in `hir.ids` are the Atoms of the texts between them (`templateTextsStart`)")]),
  V("TaggedTemplate", "TaggedTemplate(CallId)", [F("call", "id:Call", ["a"])]),
  V("Array", "Array(IdList<ExprId>)", [F("elems", "list:Expr", ["a", "b"], "holes are Missing")]),
  V("Object", "Object(Span<PropId>)", [F("props", "list:Prop", ["a", "b"])]),
  V("Fn", "Fn(FnId)", [F("fn", "id:Fn", ["a"])]),
  V("Class", "Class(ClassId)", [F("class", "id:Class", ["a"])]),
  V("Dot", "Dot { obj, name, name_pos, chain }", [F("obj", "id:Expr", ["a"]), F("name", "atom", ["b"], "starts with `#` for a private name"), F("namePos", "pos", ["c"]), F("chain", "enum:Chain", ["aux"])]),
  V("Index", "Index { obj, index, chain }", [F("obj", "id:Expr", ["a"]), F("index", "id:Expr", ["b"]), F("chain", "enum:Chain", ["aux"])]),
  V("Call", "Call(CallId)", [F("call", "id:Call", ["a"])]),
  V("New", "New(CallId)", [F("call", "id:Call", ["a"])]),
  V("Unary", "Unary { op, operand }", [F("operand", "id:Expr", ["a"]), F("op", "enum:UnOp", ["aux"])]),
  V("Binary", "Binary { op, left, right }", [F("left", "id:Expr", ["a"]), F("right", "id:Expr", ["b"]), F("op", "enum:BinOp", ["aux"])]),
  V("Assign", "Assign { op: Option<BinOp>, target, value }", [F("target", "id:Expr", ["a"]), F("value", "id:Expr", ["b"]), F("op", "raw", ["aux"], "0 = plain `=`, otherwise `BIN_x + 1`")]),
  V("Cond", "Cond { test, yes, no }", [F("test", "id:Expr", ["a"]), F("yes", "id:Expr", ["b"]), F("no", "id:Expr", ["c"])]),
  V("Spread", "Spread(ExprId)", [F("expr", "id:Expr", ["a"])]),
  V("Await", "Await(ExprId)", [F("expr", "id:Expr", ["a"])]),
  V("Yield", "Yield { value, star }", [F("value", "id:Expr", ["a"]), F("star", "bool", ["aux"])]),
  V("As", "As { expr, ty }", [F("expr", "id:Expr", ["a"]), F("ty", "id:Type", ["b"])]),
  V("Satisfies", "Satisfies { expr, ty }", [F("expr", "id:Expr", ["a"]), F("ty", "id:Type", ["b"])]),
  V("AsConst", "AsConst(ExprId)", [F("expr", "id:Expr", ["a"])]),
  V("NonNull", "NonNull(ExprId)", [F("expr", "id:Expr", ["a"])]),
  V("Instantiation", "Instantiation { expr, type_args }", [F("expr", "id:Expr", ["a"]), F("typeArgs", "list:Type", ["b", "c"])]),
  V("Jsx", "Jsx(JsxId)", [F("jsx", "id:Jsx", ["a"])]),
  V("ImportCall", "ImportCall { args }", [F("args", "list:Expr", ["a", "b"], "never empty: the first is the specifier (Missing if there is none)")]),
  V("ImportMeta", "ImportMeta", []),
  V("NewTarget", "NewTarget(Atom)", [F("name", "atom", ["a"], "the word in the source: any word forms a meta property")]),
];

const stmtVariants: Variant[] = [
  V("Empty", "Empty", []),
  V("Debugger", "Debugger", []),
  V("Expr", "Expr(ExprId)", [F("expr", "id:Expr", ["a"])]),
  V("Var", "Var(Span<VarDeclId>)", [F("decls", "list:VarDecl", ["a", "b"])]),
  V("Fn", "Fn(FnId)", [F("fn", "id:Fn", ["a"])]),
  V("Class", "Class(ClassId)", [F("class", "id:Class", ["a"])]),
  V("Interface", "Interface(InterfaceId)", [F("interface", "id:Interface", ["a"])]),
  V("TypeAlias", "TypeAlias(AliasId)", [F("alias", "id:Alias", ["a"])]),
  V("Enum", "Enum(EnumId)", [F("enum", "id:Enum", ["a"])]),
  V("Module", "Module(ModuleId)", [F("module", "id:Module", ["a"])]),
  V("Return", "Return(ExprId)", [F("expr", "id:Expr", ["a"], "NONE if there is no argument")]),
  V("If", "If { test, yes, no }", [F("test", "id:Expr", ["a"]), F("yes", "id:Stmt", ["b"]), F("no", "id:Stmt", ["c"], "NONE without else")]),
  V("For", "For { init, test, update, body }", [F("init", "id:Stmt", ["a"]), F("test", "id:Expr", ["b"]), F("update", "id:Expr", ["c"]), F("body", "id:Stmt", ["d"])]),
  V("ForIn", "ForIn { left, expr, body }", [F("left", "id:Stmt", ["a"], "a Var with one declaration, or an Expr statement"), F("expr", "id:Expr", ["b"]), F("body", "id:Stmt", ["c"])]),
  V("ForOf", "ForOf { left, expr, body, is_await }", [F("left", "id:Stmt", ["a"]), F("expr", "id:Expr", ["b"]), F("body", "id:Stmt", ["c"]), F("isAwait", "bool", ["aux"])]),
  V("While", "While { test, body }", [F("test", "id:Expr", ["a"]), F("body", "id:Stmt", ["b"])]),
  V("DoWhile", "DoWhile { body, test }", [F("body", "id:Stmt", ["a"]), F("test", "id:Expr", ["b"])]),
  V("Block", "Block(IdList<StmtId>)", [F("stmts", "list:Stmt", ["a", "b"])]),
  V("Switch", "Switch { expr, cases }", [F("expr", "id:Expr", ["a"]), F("cases", "list:Case", ["b", "c"])]),
  V("Try", "Try { block, param, handler, finalizer }", [F("block", "id:Stmt", ["a"]), F("param", "id:VarDecl", ["b"]), F("handler", "id:Stmt", ["c"]), F("finalizer", "id:Stmt", ["d"])]),
  V("Throw", "Throw(ExprId)", [F("expr", "id:Expr", ["a"])]),
  V("Break", "Break(Atom)", [F("label", "atom", ["a"])]),
  V("Continue", "Continue(Atom)", [F("label", "atom", ["a"])]),
  V("Labeled", "Labeled { label, body }", [F("label", "atom", ["a"]), F("body", "id:Stmt", ["b"])]),
  V("Import", "Import(ImportId)", [F("import", "id:Import", ["a"])]),
  V("ImportEquals", "ImportEquals(ImportEqualsId)", [F("importEquals", "id:ImportEquals", ["a"])]),
  V("ExportNamed", "ExportNamed(ExportId)", [F("export", "id:Export", ["a"])]),
  V("ExportStar", "ExportStar { spec, alias, type_only, mode, star_pos, alias_pos }", [F("spec", "atom", ["a"], "NONE if it is not a string literal"), F("alias", "atom", ["b"]), F("starPos", "pos", ["c"]), F("aliasPos", "pos", ["d"]), F("flags", "raw", ["aux"], "bit 0 = type_only, bits 1-2 = ResolutionMode (RM_*)")]),
  V("ExportDefault", "ExportDefault(ExprId)", [F("expr", "id:Expr", ["a"])]),
  V("ExportAssign", "ExportAssign(ExprId)", [F("expr", "id:Expr", ["a"])]),
  V("ExportAsNamespace", "ExportAsNamespace(Atom)", [F("name", "atom", ["a"])]),
];

const typeVariants: Variant[] = [
  V("Error", "Error", [], "syntax the type parser failed on"),
  V("Heritage", "Heritage { expr, args }", [F("expr", "id:Expr", ["a"]), F("args", "list:Type", ["b", "c"])]),
  V("Keyword", "Keyword(Keyword)", [F("keyword", "enum:Keyword", ["a"])]),
  V("Ref", "Ref { name, args }", [F("name", "list:Name", ["a", "b"], "the names of `A.B.C`, in order (ids of `names` rows)"), F("args", "list:Type", ["c", "d"])]),
  V("StringLit", "StringLit(Atom)", [F("value", "atom", ["a"])]),
  V("NumberLit", "NumberLit(u32)", [F("index", "num", ["a"])]),
  V("BigIntLit", "BigIntLit { text, negative }", [F("text", "atom", ["a"]), F("negative", "bool", ["aux"])]),
  V("BoolLit", "BoolLit(bool)", [F("value", "bool", ["aux"])]),
  V("Template", "Template { types, texts }", [F("types", "list:Type", ["a", "b"]), F("texts", "list:Atom", ["c", "d"], "Atoms")]),
  V("Array", "Array(TypeNodeId)", [F("elem", "id:Type", ["a"])]),
  V("Tuple", "Tuple(Span<TupleElemId>)", [F("elems", "list:TupleElem", ["a", "b"])]),
  V("Union", "Union(IdList<TypeNodeId>)", [F("types", "list:Type", ["a", "b"])]),
  V("Intersection", "Intersection(IdList<TypeNodeId>)", [F("types", "list:Type", ["a", "b"])]),
  V("Fn", "Fn(FnId)", [F("fn", "id:Fn", ["a"])]),
  V("Object", "Object(Span<MemberId>)", [F("members", "list:Member", ["a", "b"])]),
  V("Cond", "Cond { check, extends, yes, no }", [F("check", "id:Type", ["a"]), F("extends", "id:Type", ["b"]), F("yes", "id:Type", ["c"]), F("no", "id:Type", ["d"])]),
  V("Infer", "Infer(TypeParamId)", [F("param", "id:TypeParam", ["a"])]),
  V("Mapped", "Mapped(MappedId)", [F("mapped", "id:Mapped", ["a"])]),
  V("IndexedAccess", "IndexedAccess { obj, index }", [F("obj", "id:Type", ["a"]), F("index", "id:Type", ["b"])]),
  V("Keyof", "Keyof(TypeNodeId)", [F("ty", "id:Type", ["a"])]),
  V("Readonly", "Readonly(TypeNodeId)", [F("ty", "id:Type", ["a"])]),
  V("UniqueSymbol", "UniqueSymbol", []),
  V("Unique", "Unique(TypeNodeId)", [F("ty", "id:Type", ["a"])]),
  V("JSDoc", "JSDoc { ty, kind, is_postfix }", [F("ty", "id:Type", ["a"]), F("flags", "raw", ["aux"], "bits 0-1 = JSDocTypeKind (JSD_*), bit 2 = is_postfix")]),
  V("Typeof", "Typeof { name, args, has_type_arguments, expr }", [F("name", "list:Name", ["a", "b"]), F("args", "list:Type", ["c", "d"]), F("expr", "id:Expr", ["e"]), F("hasTypeArguments", "bool", ["aux"])]),
  V("Import", "Import { spec, name, args, is_typeof, mode, attributes }", [F("spec", "atom", ["a"], "NONE if not a string"), F("name", "list:Name", ["b", "c"]), F("args", "list:Type", ["d", "e"]), F("flags", "raw", ["aux"], "bit 0 = is_typeof, bits 1-2 = ResolutionMode (RM_*), bits 3-4 = ImportAttributesToken (IAT_*)")]),
  V("Predicate", "Predicate { param, ty, asserts }", [F("param", "atom", ["a"], "`this` for `this is T`"), F("ty", "id:Type", ["b"], "NONE for `asserts x`"), F("asserts", "bool", ["aux"])]),
];

const patVariants: Variant[] = [
  V("Missing", "Missing", []),
  V("Ident", "Ident(Atom)", [F("name", "atom", ["a"])]),
  V("Object", "Object(Span<PatPropId>)", [F("props", "list:PatProp", ["a", "b"])]),
  V("Array", "Array(Span<PatElemId>)", [F("elems", "list:PatElem", ["a", "b"])]),
];

const tables: Table[] = [
  {
    key: "expr", plural: "exprs", rust: "Expr", id: "ExprId", pushName: "Expr",
    cols: [],
    tagged: { prefix: "EXPR", variants: exprVariants, payload: ["a", "b", "c"], head: ["pos", "end"] },
    doc: "`pos`/`end`: `node.Pos()` and `node.End()` excluding enclosing parentheses (parentheses are in `parens`).",
  },
  {
    key: "stmt", plural: "stmts", rust: "Stmt", id: "StmtId", pushName: "Stmt",
    cols: [],
    tagged: { prefix: "STMT", variants: stmtVariants, payload: ["a", "b", "c", "d"], head: ["start", "locPos", "locEnd", "modStart", "modLen"] },
    doc: "`start`: position of its first token including decorators and modifiers. `locPos`/`locEnd`: `Stmt.loc` (0 until the parser sets it). `modStart`/`modLen`: `node.Modifiers()`, a list of `modifiers` ids in `hir.ids`.",
  },
  {
    key: "type", plural: "types", rust: "TypeNode", id: "TypeNodeId", pushName: "Type",
    cols: [],
    tagged: { prefix: "TYPE", variants: typeVariants, payload: ["a", "b", "c", "d", "e"], head: ["pos", "end"] },
    doc: "`end`: `node.End()` excluding enclosing parentheses.",
  },
  {
    key: "pat", plural: "pats", rust: "Pat", id: "PatId", pushName: "Pat",
    cols: [],
    tagged: { prefix: "PAT", variants: patVariants, payload: ["a", "b"], head: ["pos", "end"] },
  },
  {
    key: "patProp", plural: "patProps", rust: "PatProp", id: "PatPropId", pushName: "PatProp",
    cols: [U("keyKind", "PropKey kind: PK_*"), I("keyVal", "atom (PK_NAME/PK_PRIVATE) or ExprId (PK_COMPUTED)", -1), U("nameKind", "NK_*"), I("value", "PatId", -1), I("default", "ExprId", -1), U("isRest"), I("pos", "first token: the name or `...`"), I("keyPos"), I("end")],
  },
  {
    key: "patElem", plural: "patElems", rust: "PatElem", id: "PatElemId", pushName: "PatElem",
    cols: [I("pat", "PatId; a Missing pattern for a hole", -1), I("default", "ExprId", -1), U("isRest"), I("start", "first token: `...` or the pattern"), I("end")],
  },
  {
    key: "fn", plural: "fns", rust: "Func", id: "FnId", pushName: "Fn",
    cols: [
      U("kind", "FN_*"), I("flags", "FLAG_* bits"), I("name", "atom", -1), I("namePos"),
      I("typeParamsStart", "list of TypeParamId"), I("typeParamsLen"), I("paramsStart", "list of ParamId (without `this`)"), I("paramsLen"),
      I("thisParam", "ParamId of a `this` parameter (not among params)", -1), I("ret", "TypeNodeId", -1),
      U("bodyKind", "BODY_NONE / BODY_BLOCK / BODY_EXPR"), I("bodyA", "BODY_BLOCK: stmts list start; BODY_EXPR: ExprId"), I("bodyB", "BODY_BLOCK: stmts list len"),
      I("anchor", "the `(` of the parameters; the `=>` of an arrow function"), I("start", "first token incl. decorators and modifiers"),
    ],
  },
  {
    key: "param", plural: "params", rust: "Param", id: "ParamId", pushName: "Param",
    cols: [I("pat", "PatId", -1), I("ty", "TypeNodeId", -1), I("default", "ExprId", -1), I("flags"), I("pos", "start incl. modifiers and `...`"), I("locPos"), I("locEnd", "0 if the parser did not record it"), I("modStart", "node.Modifiers(): list in ids (modLen 0 = none)"), I("modLen")],
    doc: "`modStart`/`modLen` are Rust's `modifiers_of_params` side column (`param_modifiers`).",
  },
  {
    key: "typeParam", plural: "typeParams", rust: "TypeParam", id: "TypeParamId", pushName: "TypeParam",
    cols: [I("name", "atom", -1), I("pos"), I("start", "first token: a modifier or `pos`"), I("end"), I("constraint", "TypeNodeId", -1), I("default", "TypeNodeId", -1), I("flags"), I("modStart"), I("modLen")],
  },
  {
    key: "class", plural: "classes", rust: "Class", id: "ClassId", pushName: "Class",
    cols: [
      I("name", "atom", -1), I("namePos"), I("flags"), I("typeParamsStart"), I("typeParamsLen"), I("extends", "ExprId of the first `extends` element", -1),
      I("extendsArgsStart"), I("extendsArgsLen"), I("otherExtendsStart", "ExprIds of the other (erroneous) extends elements"), I("otherExtendsLen"),
      I("implementsStart", "TypeNodeIds"), I("implementsLen"), I("otherImplementsStart"), I("otherImplementsLen"),
      I("membersStart", "MemberIds"), I("membersLen"), I("start", "first token incl. decorators and modifiers"), I("modStart"), I("modLen"),
    ],
  },
  {
    key: "interface", plural: "interfaces", rust: "Interface", id: "InterfaceId", pushName: "Interface",
    cols: [I("name", "atom", -1), I("namePos"), I("flags"), I("typeParamsStart"), I("typeParamsLen"), I("extendsStart", "TypeNodeIds"), I("extendsLen"), I("otherHeritageStart"), I("otherHeritageLen"), I("membersStart"), I("membersLen"), I("stmt", "StmtId of the declaration", -1)],
  },
  {
    key: "alias", plural: "aliases", rust: "Alias", id: "AliasId", pushName: "Alias",
    cols: [I("name", "atom", -1), I("namePos"), I("flags"), I("typeParamsStart"), I("typeParamsLen"), I("ty", "TypeNodeId", -1), I("stmt", "StmtId", -1)],
  },
  {
    key: "enum", plural: "enums", rust: "Enum", id: "EnumId", pushName: "Enum", few: true,
    cols: [I("name", "atom", -1), I("namePos"), I("flags"), I("membersStart", "EnumMemberIds"), I("membersLen"), I("stmt", "StmtId", -1)],
  },
  {
    key: "enumMember", plural: "enumMembers", rust: "EnumMember", id: "EnumMemberId", pushName: "EnumMember", few: true,
    cols: [I("name", "atom (NONE for a computed name)", -1), U("nameKind", "NK_*"), I("computedName", "ExprId of `[e]`", -1), I("init", "ExprId", -1), I("pos"), I("locPos"), I("locEnd")],
  },
  {
    key: "module", plural: "modules", rust: "Module", id: "ModuleId", pushName: "Module", few: true,
    cols: [U("nameKind", "MODNAME_IDENT / MODNAME_STRING / MODNAME_GLOBAL"), I("name", "atom (not for MODNAME_GLOBAL)", -1), I("namePos"), I("flags"), I("bodyStart", "StmtIds"), I("bodyLen"), U("hasBody"), U("specifiesModule"), I("stmt", "StmtId", -1)],
  },
  {
    key: "member", plural: "members", rust: "Member", id: "MemberId", pushName: "Member",
    cols: [U("kind", "MEMBER_*"), U("keyKind", "PK_*"), I("keyVal", "atom or ExprId", -1), I("flags"), I("ty", "TypeNodeId", -1), I("init", "ExprId", -1), I("func", "FnId", -1), I("namePos"), I("start", "first token: a decorator, modifier, `get`, `set`, `*`, or `namePos`"), I("locPos", "its `;` or `,` is part of it"), I("locEnd"), I("modStart"), I("modLen")],
  },
  {
    key: "prop", plural: "props", rust: "Prop", id: "PropId", pushName: "Prop",
    cols: [U("kind", "PROP_*"), U("keyKind", "PK_*"), I("keyVal", "atom or ExprId", -1), U("nameKind", "NK_*"), I("value", "ExprId", -1), I("pos"), I("start", "first token"), I("end", "0 if the parser did not record it"), I("postfixToken", "position of the `?` / `!` after the name, 0 = none"), I("modStart", "Rust: modifiers_of_props"), I("modLen")],
  },
  {
    key: "varDecl", plural: "varDecls", rust: "VarDecl", id: "VarDeclId", pushName: "VarDecl",
    cols: [I("pat", "PatId", -1), I("ty", "TypeNodeId", -1), I("init", "ExprId", -1), U("kind", "VAR_*"), I("flags"), I("locPos"), I("locEnd")],
  },
  {
    key: "call", plural: "calls", rust: "Call", id: "CallId", pushName: "Call",
    cols: [I("callee", "ExprId", -1), I("argsStart", "ExprIds"), I("argsLen"), I("typeArgsStart", "TypeNodeIds"), I("typeArgsLen"), I("closePos", "the `)`; -1 (u32::MAX) for `new C`; a tagged template: -1 or INCOMPLETE_TEMPLATE (-2)", -1), U("chain", "CHAIN_*"), I("template", "ExprId of a tagged template's template", -1)],
  },
  {
    key: "case", plural: "cases", rust: "Case", id: "CaseId", pushName: "Case",
    cols: [I("test", "ExprId; NONE for `default`", -1), I("bodyStart", "StmtIds"), I("bodyLen"), I("pos"), I("end")],
  },
  {
    key: "jsx", plural: "jsx", rust: "Jsx", id: "JsxId", pushName: "Jsx", few: true,
    cols: [I("tag", "ExprId; NONE for a fragment", -1), I("closeTag", "ExprId; NONE for `<tag />` and fragments", -1), I("attrsStart", "PropIds"), I("attrsLen"), I("childrenStart", "ExprIds"), I("childrenLen"), I("typeArgsStart"), I("typeArgsLen"), I("openingEnd"), I("closePos", "start of `</tag>`; -1 for `<tag />`", -1), I("end")],
  },
  {
    key: "import", plural: "imports", rust: "Import", id: "ImportId", pushName: "Import",
    cols: [I("spec", "atom", -1), I("default", "atom", -1), I("defaultPos"), I("namespace", "atom", -1), I("namespacePos"), I("clauseStart"), I("clauseEnd"), I("namespaceStart"), I("namedStart", "ImportSpecIds"), I("namedLen"), U("hasNamedImports"), U("typeOnly"), U("isDeferred"), U("mode", "RM_*"), I("stmt", "StmtId", -1)],
  },
  {
    key: "importSpec", plural: "importSpecs", rust: "ImportSpec", id: "ImportSpecId", pushName: "ImportSpec",
    cols: [I("start"), I("imported", "atom", -1), I("local", "atom", -1), I("pos"), U("typeOnly"), I("importedPos"), I("end"), I("import", "ImportId", -1)],
  },
  {
    key: "importEquals", plural: "importEquals", rust: "ImportEquals", id: "ImportEqualsId", pushName: "ImportEquals", few: true,
    cols: [I("name", "atom", -1), I("namePos"), U("targetKind", "IET_REQUIRE: targetA = spec atom; IET_ENTITY: targetA/targetB = list of NameIds"), I("targetA", "", -1), I("targetB"), I("expression", "ExprId of a non-string `require(e)`", -1), I("flags"), I("stmt", "StmtId", -1)],
  },
  {
    key: "export", plural: "exports", rust: "Export", id: "ExportId", pushName: "Export",
    cols: [I("spec", "atom; NONE without `from`", -1), U("hasModuleSpecifier"), I("itemsStart", "ExportSpecIds"), I("itemsLen"), U("typeOnly"), U("mode", "RM_*"), I("stmt", "StmtId", -1)],
  },
  {
    key: "exportSpec", plural: "exportSpecs", rust: "ExportSpec", id: "ExportSpecId", pushName: "ExportSpec",
    cols: [I("start"), I("local", "atom", -1), I("exported", "atom", -1), I("pos"), U("typeOnly"), I("localPos"), I("end"), I("export", "ExportId", -1)],
  },
  {
    key: "tupleElem", plural: "tupleElems", rust: "TupleElem", id: "TupleElemId", pushName: "TupleElem", few: true,
    cols: [I("ty", "TypeNodeId", -1), I("written", "TypeNodeId", -1), U("memberType", "TM_*"), I("name", "atom", -1), U("optional"), U("rest"), U("hasDots"), I("start"), I("end")],
  },
  {
    key: "mapped", plural: "mapped", rust: "Mapped", id: "MappedId", pushName: "Mapped", few: true,
    cols: [I("param", "TypeParamId", -1), I("nameTy", "TypeNodeId", -1), I("ty", "TypeNodeId", -1), U("readonly", "MM_*"), U("optional", "MM_*"), U("isReadonlyWithPlus"), U("isOptionalWithPlus"), I("membersStart", "MemberIds"), I("membersLen")],
  },
  {
    key: "modifier", plural: "modifiers", rust: "Modifier", id: "ModifierId", pushName: "Modifier",
    cols: [U("kind", "MODK_KEYWORD: value = the FLAG_* bit; MODK_DECORATOR: value = ExprId"), I("value", "", -1), I("pos")],
  },
  {
    key: "name", plural: "names", rust: "Name", id: "NameId", pushName: "Name",
    cols: [I("text", "atom", -1), I("pos"), U("qualified", "1: it is the `Right` of a QualifiedName (preceded by a name and a dot)")],
  },
  {
    key: "paren", plural: "parens", rust: "(ExprId, u32, u32)", id: "ParenId", pushName: "Paren",
    cols: [I("expr", "ExprId", -1), I("start"), I("end")],
    doc: "`ParenthesizedExpression`: the inner expression and the start and end of the parentheses. SORTED by `expr` (stable: nested parentheses around one expression innermost first): `hir.finish()` sorts.",
  },
  {
    key: "jsxExpression", plural: "jsxExpressions", rust: "(ExprId, u32, u32)", id: "-", pushName: "JsxExpression",
    cols: [I("expr", "ExprId", -1), I("start"), I("end")],
    doc: "`JsxExpression`: the inner expression and the braces. Sorted by `expr`.",
  },
  {
    key: "nonNullEnd", plural: "nonNullEnds", rust: "(ExprId, u32)", id: "-", pushName: "NonNullEnd", few: true,
    cols: [I("expr", "ExprId", -1), I("end")],
    doc: "The other `NonNullExpression`s of a run `x!!!`: the NonNull and where each ends. Sorted by `expr`, the innermost first.",
  },
  {
    key: "bodyStart", plural: "bodyStarts", rust: "(FnId, u32)", id: "-", pushName: "BodyStart",
    cols: [I("fn", "FnId", -1), I("pos")],
    doc: "The `{` of each function whose body is a block (the `anchor` for a static block). Sorted by `pos`.",
  },
  {
    key: "decorator", plural: "decorators", rust: "(DecoratorOwner, ExprId)", id: "-", pushName: "Decorator", few: true,
    cols: [U("ownerKind", "DECO_CLASS / DECO_MEMBER / DECO_PARAM"), I("ownerId"), I("expr", "ExprId", -1)],
    doc: "`@d`: the decorated node and the expression, in source order.",
  },
];

// ───────────────────────── enums ─────────────────────────

const enums: { name: string; prefix: string; values: string[]; doc: string }[] = [
  { name: "Chain", prefix: "CHAIN", values: ["No", "Start", "Continue"], doc: "`Chain`" },
  { name: "UnOp", prefix: "UN", values: ["Plus", "Minus", "BitNot", "Not", "Typeof", "Void", "Delete", "PreInc", "PreDec", "PostInc", "PostDec"], doc: "`UnOp`" },
  { name: "BinOp", prefix: "BIN", values: ["Add", "Sub", "Mul", "Div", "Rem", "Pow", "Shl", "Shr", "UShr", "BitAnd", "BitOr", "BitXor", "Lt", "Le", "Gt", "Ge", "EqEq", "NotEq", "EqEqEq", "NotEqEq", "In", "Instanceof", "And", "Or", "Nullish", "Comma"], doc: "`BinOp`" },
  { name: "PropKind", prefix: "PROP", values: ["Init", "Shorthand", "Spread", "Method", "Getter", "Setter"], doc: "`PropKind`" },
  { name: "NameKind", prefix: "NK", values: ["Identifier", "StringLiteral", "NumericLiteral", "ComputedString", "ComputedNumber", "Jsx"], doc: "`NameKind`" },
  { name: "PropKey", prefix: "PK", values: ["None", "Name", "Private", "Computed"], doc: "`PropKey`: keyKind column; the payload is in keyVal (atom for Name/Private, ExprId for Computed)" },
  { name: "VarKind", prefix: "VAR", values: ["Var", "Let", "Const", "Using", "AwaitUsing"], doc: "`VarKind`" },
  { name: "FnKind", prefix: "FN", values: ["Decl", "Expr", "Arrow", "Method", "Getter", "Setter", "Constructor", "StaticBlock", "CallSignature", "ConstructSignature", "FunctionType", "ConstructorType", "IndexSignature"], doc: "`FnKind`" },
  { name: "FnBody", prefix: "BODY", values: ["None", "Block", "Expr"], doc: "`FnBody`" },
  { name: "MemberKind", prefix: "MEMBER", values: ["Property", "Method", "Getter", "Setter", "Constructor", "CallSignature", "ConstructSignature", "IndexSignature", "StaticBlock"], doc: "`MemberKind`" },
  { name: "ModuleName", prefix: "MODNAME", values: ["Ident", "String", "Global"], doc: "`ModuleName`" },
  { name: "ResolutionMode", prefix: "RM", values: ["None", "Import", "Require"], doc: "`ResolutionMode`" },
  { name: "Keyword", prefix: "KW", values: ["Any", "Unknown", "Never", "Void", "Undefined", "Null", "String", "Number", "Boolean", "BigInt", "Symbol", "Object", "This", "Intrinsic"], doc: "`Keyword`" },
  { name: "MappedModifier", prefix: "MM", values: ["None", "Add", "Remove"], doc: "`MappedModifier`" },
  { name: "TupleMemberType", prefix: "TM", values: ["Plain", "Rest", "Optional"], doc: "`TupleMemberType`" },
  { name: "ImportAttributesToken", prefix: "IAT", values: ["None", "With", "Assert"], doc: "`ImportAttributesToken`" },
  { name: "JSDocTypeKind", prefix: "JSD", values: ["Nullable", "NonNullable", "Optional", "Variadic"], doc: "`JSDocTypeKind`" },
  { name: "ReferenceKind", prefix: "REF", values: ["Path", "Types", "Lib"], doc: "`ReferenceKind`" },
  { name: "FileKind", prefix: "FK", values: ["Ts", "Tsx", "Declaration", "Json"], doc: "`FileKind`" },
  { name: "DecoratorOwner", prefix: "DECO", values: ["Class", "Member", "Param"], doc: "`DecoratorOwner`" },
  { name: "ImportEqualsTarget", prefix: "IET", values: ["Require", "Entity"], doc: "`ImportEqualsTarget`" },
  { name: "ModifierKind", prefix: "MODK", values: ["Keyword", "Decorator"], doc: "`ModifierKind`" },
  { name: "DiagnosticKind", prefix: "DK", values: ["Parse", "Js", "JsDoc", "Grammar", "Checker", "Oxc", "OxcFatal", "OxcSemantic", "OxcSecondReading"], doc: "`DiagnosticKind`" },
  { name: "CommentDirectiveKind", prefix: "CD", values: ["ExpectError", "Ignore"], doc: "`CommentDirectiveKind`" },
];

const flags: [string, number][] = [
  ["EXPORT", 0], ["DEFAULT", 1], ["AMBIENT", 2], ["ABSTRACT", 3], ["ASYNC", 4], ["GENERATOR", 5], ["STATIC", 6], ["READONLY", 7],
  ["OPTIONAL", 8], ["PRIVATE", 9], ["PROTECTED", 10], ["PUBLIC", 11], ["OVERRIDE", 12], ["ACCESSOR", 13], ["CONST", 14],
  ["REST", 15], ["DEFINITE", 16], ["TYPE_ONLY", 17], ["IN", 18], ["OUT", 19], ["PARAMETER_PROPERTY", 20], ["LITERAL_NAME", 21],
  ["STRING_NAME", 23], ["MISSING_BODY", 24], ["REPARSED", 25], ["COMPUTED_NAME", 26], ["CLASS_ELEMENT", 27],
];

const rare: [string, number][] = [
  ["SUSPENDS_IN_PARAMETERS", 0], ["DECLARATION_AS_BODY", 1], ["ODD_ACCESSOR", 2], ["DEFAULT_IN_OBJECT", 3], ["NOTABLE_CLASS_MEMBER", 4],
  ["ODD_PRIVATE_NAME", 5], ["DELETES_A_NAME", 6], ["DIRECTIVE_IN_FUNCTION", 7], ["TYPE_PARAMETER_MODIFIER", 8], ["JSDOC_TYPE", 9],
  ["TYPE_PREDICATE", 10], ["ODD_LOOP_HEAD", 11], ["EXPORT_ASSIGNMENT", 12], ["NESTED_MODULE_SYNTAX", 13], ["ODD_TARGET", 16],
  ["MAY_REDECLARE", 17], ["ODD_EXPORT", 18], ["NEW_TARGET", 19], ["FOR_AWAIT", 20], ["ODD_JUMP", 21], ["NESTED_DECLARE", 22],
  ["SUSPENDS_IN_STATIC_BLOCK", 24], ["AWAIT_USING", 25], ["ODD_DECLARATION", 26],
];

// ───────────────────────── generation helpers ─────────────────────────

const RESERVED = new Set(["default", "extends", "import", "export", "class", "enum", "case", "function", "new", "delete", "in", "typeof", "void", "var", "let", "const", "static", "yield", "await", "if", "for", "do", "while", "switch", "try", "catch", "finally", "return", "break", "continue", "with", "this", "super", "null", "true", "false", "interface", "package", "private", "protected", "public", "implements"]);
const pn = (s: string): string => (RESERVED.has(s) ? s + "_" : s);
const upperSnake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);
const colField = (t: Table, c: string): string => t.key + cap(c);
const tsType = (c: Col): string => (c.t === "u8" ? "Uint8Array" : c.t === "f64" ? "Float64Array" : "Int32Array");

/** Columns in PUSH order: tagged tables are (tag, head..., payload..., aux). */
function allCols(t: Table): Col[] {
  if (!t.tagged) return t.cols;
  const cols: Col[] = [U("tag")];
  for (const h of t.tagged.head) cols.push(I(h));
  for (const p of t.tagged.payload) cols.push(I(p, "", 0));
  cols.push(U("aux"));
  return cols;
}

let out = "";
const w = (s: string): void => {
  out += s + "\n";
};

w("// GENERATED by tools/gen-hir.ts from the schema in that file. DO NOT EDIT; edit the schema and run `node tools/gen-hir.ts`.");
w("//");
w("// The HIR of a file as struct-of-arrays tables (port of vendor/bun/src/sema/hir.rs). Contract: docs/HIR_API.md.");
w("//  - ids are Int32 row indices, NONE = -1 (Rust u32::MAX); atoms are Int32 (-1 = Atom::NONE); positions are byte offsets;");
w("//  - a Rust Span<T> and IdList<T> are both a (start, len) pair into `hir.ids`;");
w("//  - enum-with-payload nodes are a `tag` column + payload columns `a`, `b`, `c`, ..., `aux`;");
w("//  - one `Hir` per thread (`hir`), allocated once, grow-only, `hir.reset()` per file; every push writes every column of its row.");
w("//  - every read of a typed array that is stored or passed must be `| 0`-ed by the caller (cookbook rule 1); the accessors do it.");
w("");
w('import { I32Vec } from "./vec.ts";');
w("");
w("/** `NONE`: the absent id / atom (Rust: u32::MAX, Atom::NONE). */");
w("export const NONE: number = -1;");
w("/** `hir::INCOMPLETE_TEMPLATE`: `call.closePos` of a tagged template whose last text is missing or unterminated. */");
w("export const INCOMPLETE_TEMPLATE: number = -2;");
w("");
for (const e of enums) {
  w(`// ${e.doc}`);
  e.values.forEach((v, i) => w(`export const ${e.prefix}_${upperSnake(v)}: number = ${i};`));
  w("");
}
w("// Flags (bitflags `Flags`): bit numbers are Rust's.");
for (const [n, b] of flags) w(`export const FLAG_${n}: number = ${1 << b};`);
w("");
w("// `hir::rare`: bits of `hir.rareSyntax`.");
for (const [n, b] of rare) w(`export const RARE_${n}: number = ${1 << b};`);
w("");
w("// Name::QUALIFIED is the `qualified` column. Modifier keyword flags are FLAG_* bits.");
w("");
for (const t of tables) {
  if (!t.tagged) continue;
  w(`// ${t.rust} tags (${t.tagged.prefix}_*), in the order of Rust's ${t.rust}Tag`);
  t.tagged.variants.forEach((v, i) => w(`export const ${t.tagged!.prefix}_${upperSnake(v.name)}: number = ${i};`));
  w(`export const ${t.tagged.prefix}_COUNT: number = ${t.tagged.variants.length};`);
  w("");
}

// helpers for growth
w("function growU8(a: Uint8Array, n: number): Uint8Array {");
w("  const b = new Uint8Array(n);");
w("  b.set(a);");
w("  return b;");
w("}");
w("function growI32(a: Int32Array, n: number): Int32Array {");
w("  const b = new Int32Array(n);");
w("  b.set(a);");
w("  return b;");
w("}");
w("function growF64(a: Float64Array, n: number): Float64Array {");
w("  const b = new Float64Array(n);");
w("  b.set(a);");
w("  return b;");
w("}");
w("");

w("export class Hir {");
w("  // ───────── file-level scalars (FileIn fields) ─────────");
w("  kind: number = 0; // FK_*");
w("  isJs: boolean = false;");
w("  isFlow: boolean = false;");
w("  /** `// @ts-check` (1) / `// @ts-nocheck` (0) among the leading comments; -1 = none. The last one wins. */");
w("  checkDirective: number = -1;");
w("  isModuleByDecree: boolean = false;");
w("  hasModuleSyntax: boolean = false;");
w("  hasErrors: boolean = false;");
w("  ranOutOfStack: boolean = false;");
w("  legacyDecorators: boolean = false;");
w("  mayBindAParameterTwice: boolean = false;");
w("  /** Bits of RARE_* */");
w("  rareSyntax: number = 0;");
w("  hasParseDiagnostics: boolean = false;");
w("  syntaxErrors: number = 0;");
w("  errorPos: number = 0;");
w("  /** The source: every position is an offset into it. `text.length >= sourceLen` (scratch buffers have slack). */");
w("  text: Uint8Array = new Uint8Array(0);");
w("  sourceLen: number = 0;");
w("  /** `FileIn::body`: the top-level statements, a list in `ids`. */");
w("  bodyStart: number = 0;");
w("  bodyLen: number = 0;");
w("  /** JSX pragmas of the leading comments: classic = 1, automatic = 0, none = -1; atoms or NONE */");
w("  jsxClassic: number = -1;");
w("  jsxFactory: number = -1;");
w("  jsxFragmentFactory: number = -1;");
w("  jsxImportSource: number = -1;");
w("");
w("  // ───────── shared lists ─────────");
w("  /** Id lists (Rust `File::ids`): every `list:` field is a (start, len) range of this array. */");
w("  ids: Int32Array = new Int32Array(4096);");
w("  idsLen: number = 0;");
w("  numbers: Float64Array = new Float64Array(256);");
w("  numbersLen: number = 0;");
w("");

for (const t of tables) {
  w(`  // ───────── ${t.plural}: ${t.rust}${t.tagged ? " (tagged)" : ""} ─────────`);
  for (const c of allCols(t)) w(`  ${colField(t, c.name)}: ${tsType(c)} = new ${tsType(c)}(${t.few ? 16 : 256});`);
  w(`  n${cap(t.plural)}: number = 0;`);
  w(`  cap${cap(t.plural)}: number = ${t.few ? 16 : 256};`);
  w("");
}

w("  // ───────── plain side tables (rows of Int32) ─────────");
w("  /** `references`: rows (ReferenceKind, atom, pos, ResolutionMode). */");
w("  references: Int32Array = new Int32Array(16);");
w("  referencesLen: number = 0;");
w("  /** `comments`: rows (start, end) of every `//` and block comment in source order (not a `#!` line, nor an HTML comment). The lexer appends to it. */");
w("  comments: I32Vec = new I32Vec(4096);");
w("  /** `commentDirectives`: rows (start, end, CD_*): `@ts-expect-error` / `@ts-ignore`. The lexer appends to it. */");
w("  commentDirectives: I32Vec = new I32Vec(16);");
w("  /** `withBodies`: rows (start, end) of the statement of each `with (e) stmt`. */");
w("  withBodies: Int32Array = new Int32Array(16);");
w("  withBodiesLen: number = 0;");
w("  /** `afterSkipped`: start of each token that follows a token the parser skipped in a list. Sorted. */");
w("  afterSkipped: Int32Array = new Int32Array(16);");
w("  afterSkippedLen: number = 0;");
w("  /** `unclosedLiterals`: rows (start, end). Sorted. */");
w("  unclosedLiterals: Int32Array = new Int32Array(16);");
w("  unclosedLiteralsLen: number = 0;");
w("  /** `strayDecorators`: rows (start, end). */");
w("  strayDecorators: Int32Array = new Int32Array(16);");
w("  strayDecoratorsLen: number = 0;");
w("  /** `deferredImportCalls`: rows (ExprId, close paren pos). */");
w("  deferredImportCalls: Int32Array = new Int32Array(16);");
w("  deferredImportCallsLen: number = 0;");
w("  /** `importCallTypeArgs`: rows (ExprId of the specifier, ids start, ids len). */");
w("  importCallTypeArgs: Int32Array = new Int32Array(16);");
w("  importCallTypeArgsLen: number = 0;");
w("  /** `importAttributes`: rows (start of `with`, ExprId of the attributes Object), in source order. */");
w("  importAttributes: Int32Array = new Int32Array(16);");
w("  importAttributesLen: number = 0;");
w("  /** `specifierExpressions`: ExprIds of module specifiers that are not string literals. */");
w("  specifierExpressions: Int32Array = new Int32Array(16);");
w("  specifierExpressionsLen: number = 0;");
w("  /** `exportsFromExpressions`: rows (StmtId, ExprId). */");
w("  exportsFromExpressions: Int32Array = new Int32Array(16);");
w("  exportsFromExpressionsLen: number = 0;");
w("  /** `keywordIdentifierPositions`: the position of each Identifier whose atom is a keyword identifier, in parse order. */");
w("  keywordIdentifierPositions: Int32Array = new Int32Array(16);");
w("  keywordIdentifierPositionsLen: number = 0;");
w("  /** `diagnostics`: rows (DK_*, start, end, code, argsId). `end` = -1: an empty range at `start`; 0: the end of the token at `start`. `argsId`: -1, or the index in `diagArgs` of the message arguments (`{0}`, `{1}`: one string each; cold). */");
w("  diagnostics: Int32Array = new Int32Array(20);");
w("  diagArgs: string[][] = [];");
w("  diagnosticsLen: number = 0;");
w("");

w("  // ───────── lifecycle ─────────");
w("  /** Forgets the previous file: counts to 0. Nothing is reallocated. */");
w("  reset(): void {");
w("    this.comments.reset();");
w("    this.commentDirectives.reset();");
w("    this.resetKeepingComments();");
w("  }");
w("");
w("  /** `reset` but for the comments: the file of a text that is given up keeps those that the lexer got past. */");
w("  resetKeepingComments(): void {");
w("    this.kind = FK_TS;");
w("    this.isJs = false;");
w("    this.isFlow = false;");
w("    this.checkDirective = -1;");
w("    this.isModuleByDecree = false;");
w("    this.hasModuleSyntax = false;");
w("    this.hasErrors = false;");
w("    this.ranOutOfStack = false;");
w("    this.legacyDecorators = false;");
w("    this.mayBindAParameterTwice = false;");
w("    this.rareSyntax = 0;");
w("    this.hasParseDiagnostics = false;");
w("    this.syntaxErrors = 0;");
w("    this.errorPos = 0;");
w("    this.sourceLen = 0;");
w("    this.bodyStart = 0;");
w("    this.bodyLen = 0;");
w("    this.jsxClassic = -1;");
w("    this.jsxFactory = -1;");
w("    this.jsxFragmentFactory = -1;");
w("    this.jsxImportSource = -1;");
w("    this.idsLen = 0;");
w("    this.numbersLen = 0;");
for (const t of tables) w(`    this.n${cap(t.plural)} = 0;`);
for (const n of ["references", "withBodies", "afterSkipped", "unclosedLiterals", "strayDecorators", "deferredImportCalls", "importCallTypeArgs", "importAttributes", "specifierExpressions", "exportsFromExpressions", "keywordIdentifierPositions", "diagnostics"]) w(`    this.${n}Len = 0;`);
w("    if (this.diagArgs.length > 0) this.diagArgs = [];");
w("  }");
w("");
w("  /** Grows the big tables for a source of `srcLen` bytes (heuristic: avoids regrowth; optional). */");
w("  reserveFor(srcLen: number): void {");
w("    const n = (srcLen >> 2) + 64;");
w("    while (this.capExprs < n) this.growExprs();");
w("    while (this.capStmts < (n >> 2)) this.growStmts();");
w("    while (this.capTypes < (n >> 2)) this.growTypes();");
w("    while (this.ids.length < n) this.growIds();");
w("  }");
w("");
w("  growIds(): void {");
w("    this.ids = growI32(this.ids, this.ids.length * 2);");
w("  }");
w("  /** Reserves `extra` more ids. */");
w("  ensureIds(extra: number): void {");
w("    while (this.idsLen + extra > this.ids.length) this.growIds();");
w("  }");
w("  /** `FileBuilder::list`: appends `stack[from, stack.len)` to `ids`; returns the start (the length is `stack.len - from`). Does NOT truncate the stack. */");
w("  listFrom(stack: Int32Array, stackLen: number, from: number): number {");
w("    const start = this.idsLen;");
w("    const n = stackLen - from;");
w("    this.ensureIds(n);");
w("    const ids = this.ids;");
w("    for (let i = 0; i < n; i++) ids[start + i] = stack[from + i] | 0;");
w("    this.idsLen = start + n;");
w("    return start;");
w("  }");
w("  /** Appends one id to `ids` (for lists built in one go: nothing else may append in between). */");
w("  pushId(v: number): number {");
w("    const n = this.idsLen;");
w("    if (n === this.ids.length) this.growIds();");
w("    this.ids[n] = v | 0;");
w("    this.idsLen = n + 1;");
w("    return n;");
w("  }");
w("  /** `FileBuilder::number`: index of the new number. */");
w("  pushNumber(v: number): number {");
w("    const n = this.numbersLen;");
w("    if (n === this.numbers.length) this.numbers = growF64(this.numbers, n * 2);");
w("    this.numbers[n] = v;");
w("    this.numbersLen = n + 1;");
w("    return n;");
w("  }");
w("");

for (const t of tables) {
  const P = cap(t.plural);
  const cols = allCols(t);
  w(`  grow${P}(): void {`);
  w(`    const n = this.cap${P} * 2;`);
  for (const c of cols) {
    const f = colField(t, c.name);
    w(`    this.${f} = grow${c.t === "u8" ? "U8" : c.t === "f64" ? "F64" : "I32"}(this.${f}, n);`);
  }
  w(`    this.cap${P} = n;`);
  w("  }");
  // push
  const args = cols.map((c) => `${pn(c.name)}: number`).join(", ");
  w(`  /** Appends a row (every column) and returns its id. */`);
  w(`  push${t.pushName}(${args}): number {`);
  w(`    const id = this.n${P};`);
  w(`    if (id === this.cap${P}) this.grow${P}();`);
  for (const c of cols) w(`    this.${colField(t, c.name)}[id] = ${pn(c.name)} | 0;`);
  w(`    this.n${P} = id + 1;`);
  w("    return id;");
  w("  }");
  // new with defaults for plain tables
  if (!t.tagged) {
    w(`  /** Appends a row with the default of every column (see the table in docs/HIR_API.md) and returns its id; then write columns directly. */`);
    w(`  new${t.pushName}(): number {`);
    w(`    const id = this.n${P};`);
    w(`    if (id === this.cap${P}) this.grow${P}();`);
    for (const c of cols) w(`    this.${colField(t, c.name)}[id] = ${c.dflt ?? 0};`);
    w(`    this.n${P} = id + 1;`);
    w("    return id;");
    w("  }");
  }
  w("");
}
w("  /** Pushes a row to a plain side table: `rows` has `stride` ints per row. */");
for (const n of ["references:4", "withBodies:2", "afterSkipped:1", "unclosedLiterals:2", "strayDecorators:2", "deferredImportCalls:2", "importCallTypeArgs:3", "importAttributes:2", "specifierExpressions:1", "exportsFromExpressions:2", "keywordIdentifierPositions:1", "diagnostics:5"]) {
  const [name, strideS] = n.split(":");
  const stride = parseInt(strideS, 10);
  const params = ["a", "b", "c", "d", "e"].slice(0, stride).map((x) => `${x}: number`).join(", ");
  w(`  push${cap(name)}(${params}): void {`);
  w(`    const n = this.${name}Len;`);
  w(`    if (n + ${stride} > this.${name}.length) this.${name} = growI32(this.${name}, this.${name}.length * 2);`);
  ["a", "b", "c", "d", "e"].slice(0, stride).forEach((x, i) => w(`    this.${name}[n + ${i}] = ${x} | 0;`));
  w(`    this.${name}Len = n + ${stride};`);
  w("  }");
}
w("}");
w("");
w("/** The HIR of the file being parsed / formatted on this thread. */");
w("export const hir: Hir = new Hir();");
w("");

// variant pushers and accessors
for (const t of tables) {
  if (!t.tagged) continue;
  const tg = t.tagged;
  const P = cap(t.plural);
  w(`// ───────── ${t.plural}: builders and accessors per variant (${t.rust}) ─────────`);
  w(`export function ${t.key}Tag(id: number): number {`);
  w(`  return hir.${t.key}Tag[id] | 0;`);
  w("}");
  for (const h of tg.head) {
    w(`export function ${t.key}${cap(h)}(id: number): number {`);
    w(`  return hir.${t.key}${cap(h)}[id] | 0;`);
    w("}");
  }
  for (const v of tg.variants) {
    const cn = `${tg.prefix}_${upperSnake(v.name)}`;
    const params: string[] = tg.head.map((h) => `${h}: number`);
    const slotVals: Record<string, string> = {};
    for (const s of [...tg.payload, "aux"]) slotVals[s] = "0";
    for (const f of v.fields) {
      f.slots.forEach((s, i) => {
        const pname = pn(f.kind.startsWith("list:") ? f.name + (i === 0 ? "Start" : "Len") : f.name);
        params.push(`${pname}: number`);
        slotVals[s] = pname;
      });
    }
    // headers for stmts: modStart/modLen default 0 (set separately)
    w(`/** ${t.rust}::${v.rust}.${v.doc ? " " + v.doc : ""} */`);
    const headParams = tg.head;
    // the generic pusher has head columns then payload
    const callArgs: string[] = [];
    callArgs.push(cn);
    callArgs.push(...tg.head.map((h) => h));
    callArgs.push(...tg.payload.map((s) => slotVals[s]));
    callArgs.push(slotVals["aux"]);
    // statements: modStart/modLen cannot be given: they are head columns -> default 0 is passed by the wrapper for stmts
    if (t.key === "stmt") {
      const p2 = ["start: number"];
      for (const f of v.fields) f.slots.forEach((s, i) => p2.push(`${pn(f.kind.startsWith("list:") ? f.name + (i === 0 ? "Start" : "Len") : f.name)}: number`));
      w(`export function push${t.pushName}${v.name}(${p2.join(", ")}): number {`);
      w(`  const id = hir.pushStmt(${[cn, "start", "0", "0", "0", "0", ...tg.payload.map((s) => slotVals[s]), slotVals["aux"]].join(", ")});`);
      // back references
      const back: Record<string, string> = { Interface: "interface", TypeAlias: "alias", Enum: "enum", Module: "module", ImportEquals: "importEquals", Import: "import", ExportNamed: "export" };
      const tableOf: Record<string, string> = { Interface: "interface", TypeAlias: "alias", Enum: "enum", Module: "module", ImportEquals: "importEquals", Import: "import", ExportNamed: "export" };
      if (back[v.name]) w(`  hir.${tableOf[v.name]}Stmt[${pn(v.fields[0].name)}] = id; // Rust: set_stmt_kind records the statement in the declaration`);
      w("  return id;");
      w("}");
    } else {
      const p3 = tg.head.map((h) => `${h}: number`);
      for (const f of v.fields) f.slots.forEach((s, i) => p3.push(`${pn(f.kind.startsWith("list:") ? f.name + (i === 0 ? "Start" : "Len") : f.name)}: number`));
      w(`export function push${t.pushName}${v.name}(${p3.join(", ")}): number {`);
      w(`  return hir.push${t.pushName}(${[cn, ...tg.head, ...tg.payload.map((s) => slotVals[s]), slotVals["aux"]].join(", ")});`);
      w("}");
    }
    for (const f of v.fields) {
      f.slots.forEach((s, i) => {
        const nm = `${t.key}${v.name}${cap(f.name)}${f.kind.startsWith("list:") ? (i === 0 ? "Start" : "Len") : ""}`;
        const col = s === "aux" ? "Aux" : s.toUpperCase();
        w(`/** ${v.name}.${f.name}${f.doc ? ": " + f.doc : ""} */`);
        w(`export function ${nm}(id: number): number {`);
        w(`  return hir.${t.key}${col}[id] | 0;`);
        w("}");
      });
    }
    void headParams;
  }
  w("");
}

// ───────────────────────── docs ─────────────────────────

let doc = "";
const d = (s: string): void => {
  doc += s + "\n";
};
d("<!-- BEGIN GENERATED (tools/gen-hir.ts) -->");
d("");
d("## 8. Enum, flag and tag constants");
d("");
d("Each is `export const PREFIX_NAME: number` in `src/sema/hir.ts` (value = Rust discriminant).");
d("");
d("| Rust | constants |");
d("| ---- | --------- |");
for (const e of enums) d(`| ${e.doc} | ${e.values.map((v, i) => `\`${e.prefix}_${upperSnake(v)}\`=${i}`).join(", ")} |`);
d(`| \`Flags\` | ${flags.map(([n, b]) => `\`FLAG_${n}\`=1<<${b}`).join(", ")} |`);
d(`| \`hir::rare\` | ${rare.map(([n, b]) => `\`RARE_${n}\`=1<<${b}`).join(", ")} |`);
d("");
d("## 9. Tables");
d("");
d("### 9.1 Tagged tables (Rust enums with payload)");
d("");
for (const t of tables) {
  if (!t.tagged) continue;
  const tg = t.tagged;
  d(`#### \`hir.${t.plural}\` (Rust \`${t.rust}\` / \`${t.rust}Kind\`; id type \`${t.id}\`)`);
  d("");
  if (t.doc) d(t.doc);
  d("");
  d(`Columns: \`hir.${t.key}Tag\` (u8, \`${tg.prefix}_*\`), \`hir.${t.key}Aux\` (u8), ${tg.head.map((h) => `\`hir.${t.key}${cap(h)}\``).join(", ")}, ${tg.payload.map((s) => `\`hir.${t.key}${s.toUpperCase()}\``).join(", ")} (i32). Push: \`hir.push${t.pushName}(tag, ${tg.head.join(", ")}, ${tg.payload.join(", ")}, aux)\` or the per-variant \`push${t.pushName}<Variant>(${tg.head.join(", ")}, ...fields)\`${t.key === "stmt" ? " (stmt: `start` only; loc and modifiers are set afterwards)" : ""}. Accessors: \`${t.key}<Variant><Field>(id)\`.`);
  d("");
  d(`| Tag | Rust variant | fields -> column |`);
  d(`| --- | ------------ | ---------------- |`);
  for (const v of tg.variants) {
    const fl = v.fields.map((f) => `${f.name} -> ${f.slots.join("+")}${f.kind.startsWith("list:") ? " (list of " + f.kind.slice(5) + "Id)" : f.kind.startsWith("id:") ? " (" + f.kind.slice(3) + "Id)" : f.kind === "atom" ? " (atom)" : f.kind === "pos" ? " (pos)" : f.kind.startsWith("enum:") ? " (" + f.kind.slice(5) + ")" : f.kind === "num" ? " (numbers idx)" : ""}${f.doc ? " — " + f.doc : ""}`).join("; ");
    d(`| \`${tg.prefix}_${upperSnake(v.name)}\` | \`${v.rust}\`${v.doc ? " — " + v.doc : ""} | ${fl || "—"} |`);
  }
  d("");
}
d("### 9.2 Plain tables");
d("");
for (const t of tables) {
  if (t.tagged) continue;
  d(`#### \`hir.${t.plural}\` (Rust \`${t.rust}\`${t.id !== "-" ? `; id type \`${t.id}\`` : ""})`);
  d("");
  if (t.doc) d(t.doc);
  d("");
  d(`Push: \`hir.push${t.pushName}(${allCols(t).map((c) => c.name).join(", ")})\` (all columns, in this order) or \`hir.new${t.pushName}()\` (defaults) and write columns. Count: \`hir.n${cap(t.plural)}\`.`);
  d("");
  d("| Column | Type | Meaning | Default of `new` |");
  d("| ------ | ---- | ------- | ---------------- |");
  for (const c of t.cols) d(`| \`hir.${colField(t, c.name)}\` | ${c.t} | ${c.doc ?? ""} | ${c.dflt ?? 0} |`);
  d("");
}
d("### 9.3 Flat side tables (rows of Int32 in `hir.<name>`, length `hir.<name>Len`, append with `hir.push<Name>(...)`)");
d("");
d("| Table | Rust | Row layout |");
d("| ----- | ---- | ---------- |");
for (const [n, rust, layout] of [
  ["references", "references", "ReferenceKind (REF_*), atom, pos, ResolutionMode (RM_*)"],
  ["withBodies", "with_bodies", "start, end of the statement of each `with (e) stmt`"],
  ["afterSkipped", "after_skipped", "start of each token that follows a token the parser skipped in a list (sorted)"],
  ["unclosedLiterals", "unclosed_literals", "start, end of array/object literals whose closing bracket is missing (sorted)"],
  ["strayDecorators", "stray_decorators", "start, end"],
  ["deferredImportCalls", "deferred_import_calls", "ExprId of the specifier, pos of the `)`"],
  ["importCallTypeArgs", "import_call_type_args", "ExprId of the specifier, ids start, ids len (TypeNodeIds)"],
  ["importAttributes", "import_attributes", "start of `with`, ExprId of the attributes Object (source order)"],
  ["specifierExpressions", "specifier_expressions", "ExprId"],
  ["exportsFromExpressions", "exports_from_expressions", "StmtId, ExprId"],
  ["keywordIdentifierPositions", "keyword_identifier_positions", "pos"],
  ["diagnostics", "diagnostics", "DK_* kind, start, end (-1: empty range at start), code, argsId (-1: none; else an index of `hir.diagArgs`)."],
]) d(`| \`hir.${n}\` | \`${rust}\` | ${layout} |`);
d("");
d("Shared with the lexer (`I32Vec`): `hir.comments` (rows start, end), `hir.commentDirectives` (rows start, end, CD_*).");
d("");
d("### 9.4 File-level fields of `hir` (Rust `FileIn` scalars)");
d("");
d("`kind` (FK_*), `isJs`, `isFlow`, `checkDirective` (-1/0/1), `isModuleByDecree`, `hasModuleSyntax`, `hasErrors`, `ranOutOfStack`, `legacyDecorators`, `mayBindAParameterTwice`, `rareSyntax` (RARE_* bits), `hasParseDiagnostics`, `syntaxErrors`, `errorPos`, `text` + `sourceLen`, `bodyStart`/`bodyLen`, `jsxClassic`/`jsxFactory`/`jsxFragmentFactory`/`jsxImportSource`, `ids` + `idsLen`, `numbers` + `numbersLen`, and the counts `hir.nExprs`, `nStmts`, ... (`n` + the table name).");
d("");
d("<!-- END GENERATED -->");

fs.writeFileSync(new URL("../src/sema/hir.ts", import.meta.url), out);
const docPath = new URL("../docs/HIR_API.md", import.meta.url);
let existing = "";
try {
  existing = fs.readFileSync(docPath, "utf8");
} catch {
  existing = "";
}
if (existing.includes("<!-- BEGIN GENERATED")) {
  const a = existing.indexOf("<!-- BEGIN GENERATED");
  const b = existing.indexOf("<!-- END GENERATED -->") + "<!-- END GENERATED -->".length;
  existing = existing.slice(0, a) + doc.trimEnd() + existing.slice(b);
} else {
  existing += "\n" + doc;
}
fs.writeFileSync(docPath, existing);
console.log("hir.ts", out.split("\n").length, "lines; docs generated section", doc.split("\n").length, "lines");
