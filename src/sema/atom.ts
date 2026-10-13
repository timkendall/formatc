// Port of vendor/bun/src/sema/atom.rs: the `known` atoms. An atom is an Int32 id (NONE = -1) of an interned name; the
// ones below have FIXED numbers (the same in every file), exactly the numbering of Rust's `atom::known`.
// Rust `known::foo` is `A_foo` here (the Rust spelling with `r#` and the trailing `_` of `let_`, `async_`, `self_` removed),
// so `known::String` / `known::string` are `A_String` / `A_string`.
// `Atom::is_keyword_identifier` (the words binder.go checks an Identifier for) is `isKeywordIdentifier`.

/** `Atom::NONE` */
export const ATOM_NONE: number = -1;

export const A_empty: number = 0;
export const A_default: number = 1;
export const A_export_equals: number = 2;
export const A_returned: number = 3;
export const A_this: number = 4;
export const A_undefined: number = 5;
export const A_implements: number = 6;
export const A_interface: number = 7;
export const A_let: number = 8;
export const A_package: number = 9;
export const A_private: number = 10;
export const A_protected: number = 11;
export const A_public: number = 12;
export const A_static: number = 13;
export const A_yield: number = 14;
export const A_await: number = 15;
export const A_eval: number = 16;
export const A_arguments: number = 17;
export const A_constructor: number = 18;
export const A_prototype: number = 19;
export const A_length: number = 20;
export const A_then: number = 21;
export const A_next: number = 22;
export const A_value: number = 23;
export const A_done: number = 24;
export const A_globalThis: number = 25;
export const A_require: number = 26;
export const A_module: number = 27;
export const A_exports: number = 28;
export const A_Array: number = 29;
export const A_ReadonlyArray: number = 30;
export const A_Object: number = 31;
export const A_Function: number = 32;
export const A_CallableFunction: number = 33;
export const A_NewableFunction: number = 34;
export const A_String: number = 35;
export const A_Number: number = 36;
export const A_Boolean: number = 37;
export const A_Symbol: number = 38;
export const A_BigInt: number = 39;
export const A_RegExp: number = 40;
export const A_Promise: number = 41;
export const A_PromiseLike: number = 42;
export const A_Iterable: number = 43;
export const A_Iterator: number = 44;
export const A_IterableIterator: number = 45;
export const A_IteratorObject: number = 46;
export const A_AsyncIterable: number = 47;
export const A_AsyncIterator: number = 48;
export const A_AsyncIterableIterator: number = 49;
export const A_SymbolConstructor: number = 50;
export const A_AsyncIteratorObject: number = 51;
export const A_Generator: number = 52;
export const A_AsyncGenerator: number = 53;
export const A_IArguments: number = 54;
export const A_TemplateStringsArray: number = 55;
export const A_ImportMeta: number = 56;
export const A_Error: number = 57;
export const A_Map: number = 58;
export const A_Set: number = 59;
export const A_Partial: number = 60;
export const A_Required: number = 61;
export const A_Readonly: number = 62;
export const A_Pick: number = 63;
export const A_Omit: number = 64;
export const A_Record: number = 65;
export const A_Exclude: number = 66;
export const A_Extract: number = 67;
export const A_NonNullable: number = 68;
export const A_ReturnType: number = 69;
export const A_Parameters: number = 70;
export const A_ConstructorParameters: number = 71;
export const A_InstanceType: number = 72;
export const A_Awaited: number = 73;
export const A_ThisType: number = 74;
export const A_NoInfer: number = 75;
export const A_Uppercase: number = 76;
export const A_Lowercase: number = 77;
export const A_Capitalize: number = 78;
export const A_Uncapitalize: number = 79;
export const A_isArray: number = 80;
export const A_iterator: number = 81;
export const A_asyncIterator: number = 82;
export const A_JSX: number = 83;
export const A_Element: number = 84;
export const A_IntrinsicElements: number = 85;
export const A_IntrinsicAttributes: number = 86;
export const A_IntrinsicClassAttributes: number = 87;
export const A_LibraryManagedAttributes: number = 88;
export const A_ElementAttributesProperty: number = 89;
export const A_ElementChildrenAttribute: number = 90;
export const A_ElementClass: number = 91;
export const A_ElementType: number = 92;
export const A_children: number = 93;
export const A_props: number = 94;
export const A_string: number = 95;
export const A_unknown: number = 96;
export const A_number: number = 97;
export const A_boolean: number = 98;
export const A_bigint: number = 99;
export const A_symbol: number = 100;
export const A_object: number = 101;
export const A_function: number = 102;
export const A_push: number = 103;
export const A_unshift: number = 104;
export const A_call: number = 105;
export const A_apply: number = 106;
export const A_bind: number = 107;
export const A_args: number = 108;
export const A_React: number = 109;
export const A_const: number = 110;
export const A_global: number = 111;
export const A_intrinsic: number = 112;
export const A_Disposable: number = 113;
export const A_freeze: number = 114;
export const A_key: number = 115;
export const A_ref: number = 116;
export const A_defineProperty: number = 117;
export const A_get: number = 118;
export const A_set: number = 119;
export const A_writable: number = 120;
export const A_anonymous_function: number = 121;
export const A_object_literal: number = 122;
export const A_computed: number = 123;
export const A_assignment_declaration: number = 124;
export const A_missing: number = 125;
export const A_constructor_declaration: number = 126;
export const A_call_signature: number = 127;
export const A_construct_signature: number = 128;
export const A_index_signature: number = 129;
export const A_type_literal: number = 130;
export const A_any: number = 131;
export const A_never: number = 132;
export const A_void: number = 133;
export const A_WeakMap: number = 134;
export const A_WeakSet: number = 135;
export const A_Reflect: number = 136;
export const A___esModule: number = 137;
export const A_async: number = 138;
export const A_AsyncDisposable: number = 139;
export const A_tslib: number = 140;
export const A_callee: number = 141;
export const A_caller: number = 142;
export const A___proto__: number = 143;
export const A___iterator__: number = 144;
export const A_hasOwnProperty: number = 145;
export const A_isPrototypeOf: number = 146;
export const A_propertyIsEnumerable: number = 147;
export const A_NaN: number = 148;
export const A_console: number = 149;
export const A_Infinity: number = 150;
export const A_window: number = 151;
export const A_self: number = 152;
export const A_Math: number = 153;
export const A_JSON: number = 154;
export const A_Atomics: number = 155;
export const A_Intl: number = 156;
export const A_Temporal: number = 157;
export const A_process: number = 158;
export const A_Buffer: number = 159;
export const A_parseInt: number = 160;
export const A_alert: number = 161;
export const A_confirm: number = 162;
export const A_prompt: number = 163;
export const A_setTimeout: number = 164;
export const A_setInterval: number = 165;
export const A_execScript: number = 166;
/** `[Symbol.iterator]` and `[Symbol.asyncIterator]` as property names, and `InternalSymbolNameGlobal`. */
export const A_sym_iterator: number = 167;
export const A_sym_async_iterator: number = 168;
export const A_global_augmentation: number = 169;
/** `atom::FIXED`: the atoms below it are the same in every file. */
export const ATOM_FIXED: number = 170;

/** `Atom::is_keyword_identifier`: `implements`..`arguments` (`checkContextualIdentifier` words, `eval`, `arguments`). */
export function isKeywordIdentifier(a: number): boolean {
  return (a - A_implements) >>> 0 <= (A_arguments - A_implements) >>> 0;
}

/** The texts of the known atoms, by number. Latin-1: the 0xFE characters stand for the byte 0xFE (no source text has it). */
export const KNOWN_TEXTS: string[] = [
  "",
  "default",
  "export=",
  "return=",
  "this",
  "undefined",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "await",
  "eval",
  "arguments",
  "constructor",
  "prototype",
  "length",
  "then",
  "next",
  "value",
  "done",
  "globalThis",
  "require",
  "module",
  "exports",
  "Array",
  "ReadonlyArray",
  "Object",
  "Function",
  "CallableFunction",
  "NewableFunction",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "RegExp",
  "Promise",
  "PromiseLike",
  "Iterable",
  "Iterator",
  "IterableIterator",
  "IteratorObject",
  "AsyncIterable",
  "AsyncIterator",
  "AsyncIterableIterator",
  "SymbolConstructor",
  "AsyncIteratorObject",
  "Generator",
  "AsyncGenerator",
  "IArguments",
  "TemplateStringsArray",
  "ImportMeta",
  "Error",
  "Map",
  "Set",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Record",
  "Exclude",
  "Extract",
  "NonNullable",
  "ReturnType",
  "Parameters",
  "ConstructorParameters",
  "InstanceType",
  "Awaited",
  "ThisType",
  "NoInfer",
  "Uppercase",
  "Lowercase",
  "Capitalize",
  "Uncapitalize",
  "isArray",
  "iterator",
  "asyncIterator",
  "JSX",
  "Element",
  "IntrinsicElements",
  "IntrinsicAttributes",
  "IntrinsicClassAttributes",
  "LibraryManagedAttributes",
  "ElementAttributesProperty",
  "ElementChildrenAttribute",
  "ElementClass",
  "ElementType",
  "children",
  "props",
  "string",
  "unknown",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "function",
  "push",
  "unshift",
  "call",
  "apply",
  "bind",
  "args",
  "React",
  "const",
  "global",
  "intrinsic",
  "Disposable",
  "freeze",
  "key",
  "ref",
  "defineProperty",
  "get",
  "set",
  "writable",
  "function=",
  "object=",
  "computed=",
  "assignment=",
  "missing=",
  "constructor=",
  "call=",
  "new=",
  "index=",
  "type=",
  "any",
  "never",
  "void",
  "WeakMap",
  "WeakSet",
  "Reflect",
  "__esModule",
  "async",
  "AsyncDisposable",
  "tslib",
  "callee",
  "caller",
  "__proto__",
  "__iterator__",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "NaN",
  "console",
  "Infinity",
  "window",
  "self",
  "Math",
  "JSON",
  "Atomics",
  "Intl",
  "Temporal",
  "process",
  "Buffer",
  "parseInt",
  "alert",
  "confirm",
  "prompt",
  "setTimeout",
  "setInterval",
  "execScript",
  "\u00fe@iterator",
  "\u00fe@asyncIterator",
  "\u00feglobal",
];

/** Prefix of the name of a symbol-keyed property: `InternalSymbolNamePrefix` and `@`. */
export const SYMBOL_NAME_PREFIX = "\u00fe@";
/** Prefix of the name of a property that a class declares as `#x`. */
export const PRIVATE_NAME_PREFIX = "\u00fe#";
