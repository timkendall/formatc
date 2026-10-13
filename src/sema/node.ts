// Port of the data model of vendor/bun/src/sema/node.rs: `*ast.Node`, one handle for every node of a file.
//
// WHAT IS PORTED: `Kind` (tsgo's SyntaxKind, KIND_*), the handle encoding (row index + `Part`), the concatenated index space of
// the node vectors (`NodeBases`, `finishNodes`), decoding a handle to (vector, id) and encoding an id to a handle (`Row`), and
// the predicates on kinds.
//
// WHAT IS NOT: `File::children / parent / kind / start / text / name / ...` (node.rs lines ~600-2650 and the type-checker
// helpers after them): the tsgo-shaped tree over the HIR that `bun check` (the type checker) walks. The formatter and the lint
// handles do not use it: `bun_lint::ast` gets parents from the BINDER's side tables (`bind::Bound::expr_parent`, `stmt_parent`,
// `pat_parent`, `prop_owner`, `member_owner`, `param_fn`, `fns`, `class_owner`, `var_stmt`, `case_stmt`, ...: sema/bind/parents.rs
// `bind_for_format`), and from `ast/node.rs::Parents` for types, type parameters and tuple elements. See docs/HIR_API.md,
// "What the handles need that is not here".
import { hir, NONE } from "./hir.ts";

/** tsgo `ast.Kind` (SyntaxKind), in tsgo's order. Rust `Kind::Identifier` is `KIND_Identifier`. */
export const KIND_Unknown: number = 0;
export const KIND_EndOfFile: number = 1;
export const KIND_SingleLineCommentTrivia: number = 2;
export const KIND_MultiLineCommentTrivia: number = 3;
export const KIND_NewLineTrivia: number = 4;
export const KIND_WhitespaceTrivia: number = 5;
export const KIND_ConflictMarkerTrivia: number = 6;
export const KIND_NonTextFileMarkerTrivia: number = 7;
export const KIND_NumericLiteral: number = 8;
export const KIND_BigIntLiteral: number = 9;
export const KIND_StringLiteral: number = 10;
export const KIND_JsxText: number = 11;
export const KIND_JsxTextAllWhiteSpaces: number = 12;
export const KIND_RegularExpressionLiteral: number = 13;
export const KIND_NoSubstitutionTemplateLiteral: number = 14;
export const KIND_TemplateHead: number = 15;
export const KIND_TemplateMiddle: number = 16;
export const KIND_TemplateTail: number = 17;
export const KIND_OpenBraceToken: number = 18;
export const KIND_CloseBraceToken: number = 19;
export const KIND_OpenParenToken: number = 20;
export const KIND_CloseParenToken: number = 21;
export const KIND_OpenBracketToken: number = 22;
export const KIND_CloseBracketToken: number = 23;
export const KIND_DotToken: number = 24;
export const KIND_DotDotDotToken: number = 25;
export const KIND_SemicolonToken: number = 26;
export const KIND_CommaToken: number = 27;
export const KIND_QuestionDotToken: number = 28;
export const KIND_LessThanToken: number = 29;
export const KIND_LessThanSlashToken: number = 30;
export const KIND_GreaterThanToken: number = 31;
export const KIND_LessThanEqualsToken: number = 32;
export const KIND_GreaterThanEqualsToken: number = 33;
export const KIND_EqualsEqualsToken: number = 34;
export const KIND_ExclamationEqualsToken: number = 35;
export const KIND_EqualsEqualsEqualsToken: number = 36;
export const KIND_ExclamationEqualsEqualsToken: number = 37;
export const KIND_EqualsGreaterThanToken: number = 38;
export const KIND_PlusToken: number = 39;
export const KIND_MinusToken: number = 40;
export const KIND_AsteriskToken: number = 41;
export const KIND_AsteriskAsteriskToken: number = 42;
export const KIND_SlashToken: number = 43;
export const KIND_PercentToken: number = 44;
export const KIND_PlusPlusToken: number = 45;
export const KIND_MinusMinusToken: number = 46;
export const KIND_LessThanLessThanToken: number = 47;
export const KIND_GreaterThanGreaterThanToken: number = 48;
export const KIND_GreaterThanGreaterThanGreaterThanToken: number = 49;
export const KIND_AmpersandToken: number = 50;
export const KIND_BarToken: number = 51;
export const KIND_CaretToken: number = 52;
export const KIND_ExclamationToken: number = 53;
export const KIND_TildeToken: number = 54;
export const KIND_AmpersandAmpersandToken: number = 55;
export const KIND_BarBarToken: number = 56;
export const KIND_QuestionToken: number = 57;
export const KIND_ColonToken: number = 58;
export const KIND_AtToken: number = 59;
export const KIND_QuestionQuestionToken: number = 60;
export const KIND_BacktickToken: number = 61;
export const KIND_HashToken: number = 62;
export const KIND_EqualsToken: number = 63;
export const KIND_PlusEqualsToken: number = 64;
export const KIND_MinusEqualsToken: number = 65;
export const KIND_AsteriskEqualsToken: number = 66;
export const KIND_AsteriskAsteriskEqualsToken: number = 67;
export const KIND_SlashEqualsToken: number = 68;
export const KIND_PercentEqualsToken: number = 69;
export const KIND_LessThanLessThanEqualsToken: number = 70;
export const KIND_GreaterThanGreaterThanEqualsToken: number = 71;
export const KIND_GreaterThanGreaterThanGreaterThanEqualsToken: number = 72;
export const KIND_AmpersandEqualsToken: number = 73;
export const KIND_BarEqualsToken: number = 74;
export const KIND_BarBarEqualsToken: number = 75;
export const KIND_AmpersandAmpersandEqualsToken: number = 76;
export const KIND_QuestionQuestionEqualsToken: number = 77;
export const KIND_CaretEqualsToken: number = 78;
export const KIND_Identifier: number = 79;
export const KIND_PrivateIdentifier: number = 80;
export const KIND_JSDocCommentTextToken: number = 81;
export const KIND_BreakKeyword: number = 82;
export const KIND_CaseKeyword: number = 83;
export const KIND_CatchKeyword: number = 84;
export const KIND_ClassKeyword: number = 85;
export const KIND_ConstKeyword: number = 86;
export const KIND_ContinueKeyword: number = 87;
export const KIND_DebuggerKeyword: number = 88;
export const KIND_DefaultKeyword: number = 89;
export const KIND_DeleteKeyword: number = 90;
export const KIND_DoKeyword: number = 91;
export const KIND_ElseKeyword: number = 92;
export const KIND_EnumKeyword: number = 93;
export const KIND_ExportKeyword: number = 94;
export const KIND_ExtendsKeyword: number = 95;
export const KIND_FalseKeyword: number = 96;
export const KIND_FinallyKeyword: number = 97;
export const KIND_ForKeyword: number = 98;
export const KIND_FunctionKeyword: number = 99;
export const KIND_IfKeyword: number = 100;
export const KIND_ImportKeyword: number = 101;
export const KIND_InKeyword: number = 102;
export const KIND_InstanceOfKeyword: number = 103;
export const KIND_NewKeyword: number = 104;
export const KIND_NullKeyword: number = 105;
export const KIND_ReturnKeyword: number = 106;
export const KIND_SuperKeyword: number = 107;
export const KIND_SwitchKeyword: number = 108;
export const KIND_ThisKeyword: number = 109;
export const KIND_ThrowKeyword: number = 110;
export const KIND_TrueKeyword: number = 111;
export const KIND_TryKeyword: number = 112;
export const KIND_TypeOfKeyword: number = 113;
export const KIND_VarKeyword: number = 114;
export const KIND_VoidKeyword: number = 115;
export const KIND_WhileKeyword: number = 116;
export const KIND_WithKeyword: number = 117;
export const KIND_ImplementsKeyword: number = 118;
export const KIND_InterfaceKeyword: number = 119;
export const KIND_LetKeyword: number = 120;
export const KIND_PackageKeyword: number = 121;
export const KIND_PrivateKeyword: number = 122;
export const KIND_ProtectedKeyword: number = 123;
export const KIND_PublicKeyword: number = 124;
export const KIND_StaticKeyword: number = 125;
export const KIND_YieldKeyword: number = 126;
export const KIND_AbstractKeyword: number = 127;
export const KIND_AccessorKeyword: number = 128;
export const KIND_AsKeyword: number = 129;
export const KIND_AssertsKeyword: number = 130;
export const KIND_AssertKeyword: number = 131;
export const KIND_AnyKeyword: number = 132;
export const KIND_AsyncKeyword: number = 133;
export const KIND_AwaitKeyword: number = 134;
export const KIND_BooleanKeyword: number = 135;
export const KIND_ConstructorKeyword: number = 136;
export const KIND_DeclareKeyword: number = 137;
export const KIND_GetKeyword: number = 138;
export const KIND_ImmediateKeyword: number = 139;
export const KIND_InferKeyword: number = 140;
export const KIND_IntrinsicKeyword: number = 141;
export const KIND_IsKeyword: number = 142;
export const KIND_KeyOfKeyword: number = 143;
export const KIND_ModuleKeyword: number = 144;
export const KIND_NamespaceKeyword: number = 145;
export const KIND_NeverKeyword: number = 146;
export const KIND_OutKeyword: number = 147;
export const KIND_ReadonlyKeyword: number = 148;
export const KIND_RequireKeyword: number = 149;
export const KIND_NumberKeyword: number = 150;
export const KIND_ObjectKeyword: number = 151;
export const KIND_SatisfiesKeyword: number = 152;
export const KIND_SetKeyword: number = 153;
export const KIND_StringKeyword: number = 154;
export const KIND_SymbolKeyword: number = 155;
export const KIND_TypeKeyword: number = 156;
export const KIND_UndefinedKeyword: number = 157;
export const KIND_UniqueKeyword: number = 158;
export const KIND_UnknownKeyword: number = 159;
export const KIND_UsingKeyword: number = 160;
export const KIND_FromKeyword: number = 161;
export const KIND_GlobalKeyword: number = 162;
export const KIND_BigIntKeyword: number = 163;
export const KIND_OverrideKeyword: number = 164;
export const KIND_OfKeyword: number = 165;
export const KIND_DeferKeyword: number = 166;
export const KIND_QualifiedName: number = 167;
export const KIND_ComputedPropertyName: number = 168;
export const KIND_TypeParameter: number = 169;
export const KIND_Parameter: number = 170;
export const KIND_Decorator: number = 171;
export const KIND_PropertySignature: number = 172;
export const KIND_PropertyDeclaration: number = 173;
export const KIND_MethodSignature: number = 174;
export const KIND_MethodDeclaration: number = 175;
export const KIND_ClassStaticBlockDeclaration: number = 176;
export const KIND_Constructor: number = 177;
export const KIND_GetAccessor: number = 178;
export const KIND_SetAccessor: number = 179;
export const KIND_CallSignature: number = 180;
export const KIND_ConstructSignature: number = 181;
export const KIND_IndexSignature: number = 182;
export const KIND_TypePredicate: number = 183;
export const KIND_TypeReference: number = 184;
export const KIND_FunctionType: number = 185;
export const KIND_ConstructorType: number = 186;
export const KIND_TypeQuery: number = 187;
export const KIND_TypeLiteral: number = 188;
export const KIND_ArrayType: number = 189;
export const KIND_TupleType: number = 190;
export const KIND_OptionalType: number = 191;
export const KIND_RestType: number = 192;
export const KIND_UnionType: number = 193;
export const KIND_IntersectionType: number = 194;
export const KIND_ConditionalType: number = 195;
export const KIND_InferType: number = 196;
export const KIND_ParenthesizedType: number = 197;
export const KIND_ThisType: number = 198;
export const KIND_TypeOperator: number = 199;
export const KIND_IndexedAccessType: number = 200;
export const KIND_MappedType: number = 201;
export const KIND_LiteralType: number = 202;
export const KIND_NamedTupleMember: number = 203;
export const KIND_TemplateLiteralType: number = 204;
export const KIND_TemplateLiteralTypeSpan: number = 205;
export const KIND_ImportType: number = 206;
export const KIND_ObjectBindingPattern: number = 207;
export const KIND_ArrayBindingPattern: number = 208;
export const KIND_BindingElement: number = 209;
export const KIND_ArrayLiteralExpression: number = 210;
export const KIND_ObjectLiteralExpression: number = 211;
export const KIND_PropertyAccessExpression: number = 212;
export const KIND_ElementAccessExpression: number = 213;
export const KIND_CallExpression: number = 214;
export const KIND_NewExpression: number = 215;
export const KIND_TaggedTemplateExpression: number = 216;
export const KIND_TypeAssertionExpression: number = 217;
export const KIND_ParenthesizedExpression: number = 218;
export const KIND_FunctionExpression: number = 219;
export const KIND_ArrowFunction: number = 220;
export const KIND_DeleteExpression: number = 221;
export const KIND_TypeOfExpression: number = 222;
export const KIND_VoidExpression: number = 223;
export const KIND_AwaitExpression: number = 224;
export const KIND_PrefixUnaryExpression: number = 225;
export const KIND_PostfixUnaryExpression: number = 226;
export const KIND_BinaryExpression: number = 227;
export const KIND_ConditionalExpression: number = 228;
export const KIND_TemplateExpression: number = 229;
export const KIND_YieldExpression: number = 230;
export const KIND_SpreadElement: number = 231;
export const KIND_ClassExpression: number = 232;
export const KIND_OmittedExpression: number = 233;
export const KIND_ExpressionWithTypeArguments: number = 234;
export const KIND_AsExpression: number = 235;
export const KIND_NonNullExpression: number = 236;
export const KIND_MetaProperty: number = 237;
export const KIND_SyntheticExpression: number = 238;
export const KIND_SatisfiesExpression: number = 239;
export const KIND_TemplateSpan: number = 240;
export const KIND_SemicolonClassElement: number = 241;
export const KIND_Block: number = 242;
export const KIND_EmptyStatement: number = 243;
export const KIND_VariableStatement: number = 244;
export const KIND_ExpressionStatement: number = 245;
export const KIND_IfStatement: number = 246;
export const KIND_DoStatement: number = 247;
export const KIND_WhileStatement: number = 248;
export const KIND_ForStatement: number = 249;
export const KIND_ForInStatement: number = 250;
export const KIND_ForOfStatement: number = 251;
export const KIND_ContinueStatement: number = 252;
export const KIND_BreakStatement: number = 253;
export const KIND_ReturnStatement: number = 254;
export const KIND_WithStatement: number = 255;
export const KIND_SwitchStatement: number = 256;
export const KIND_LabeledStatement: number = 257;
export const KIND_ThrowStatement: number = 258;
export const KIND_TryStatement: number = 259;
export const KIND_DebuggerStatement: number = 260;
export const KIND_VariableDeclaration: number = 261;
export const KIND_VariableDeclarationList: number = 262;
export const KIND_FunctionDeclaration: number = 263;
export const KIND_ClassDeclaration: number = 264;
export const KIND_InterfaceDeclaration: number = 265;
export const KIND_TypeAliasDeclaration: number = 266;
export const KIND_EnumDeclaration: number = 267;
export const KIND_ModuleDeclaration: number = 268;
export const KIND_ModuleBlock: number = 269;
export const KIND_CaseBlock: number = 270;
export const KIND_NamespaceExportDeclaration: number = 271;
export const KIND_ImportEqualsDeclaration: number = 272;
export const KIND_ImportDeclaration: number = 273;
export const KIND_ImportClause: number = 274;
export const KIND_NamespaceImport: number = 275;
export const KIND_NamedImports: number = 276;
export const KIND_ImportSpecifier: number = 277;
export const KIND_ExportAssignment: number = 278;
export const KIND_ExportDeclaration: number = 279;
export const KIND_NamedExports: number = 280;
export const KIND_NamespaceExport: number = 281;
export const KIND_ExportSpecifier: number = 282;
export const KIND_MissingDeclaration: number = 283;
export const KIND_ExternalModuleReference: number = 284;
export const KIND_JsxElement: number = 285;
export const KIND_JsxSelfClosingElement: number = 286;
export const KIND_JsxOpeningElement: number = 287;
export const KIND_JsxClosingElement: number = 288;
export const KIND_JsxFragment: number = 289;
export const KIND_JsxOpeningFragment: number = 290;
export const KIND_JsxClosingFragment: number = 291;
export const KIND_JsxAttribute: number = 292;
export const KIND_JsxAttributes: number = 293;
export const KIND_JsxSpreadAttribute: number = 294;
export const KIND_JsxExpression: number = 295;
export const KIND_JsxNamespacedName: number = 296;
export const KIND_CaseClause: number = 297;
export const KIND_DefaultClause: number = 298;
export const KIND_HeritageClause: number = 299;
export const KIND_CatchClause: number = 300;
export const KIND_ImportAttributes: number = 301;
export const KIND_ImportAttribute: number = 302;
export const KIND_PropertyAssignment: number = 303;
export const KIND_ShorthandPropertyAssignment: number = 304;
export const KIND_SpreadAssignment: number = 305;
export const KIND_EnumMember: number = 306;
export const KIND_SourceFile: number = 307;
export const KIND_JSDocTypeExpression: number = 308;
export const KIND_JSDocNameReference: number = 309;
export const KIND_JSDocAllType: number = 310;
export const KIND_JSDocNullableType: number = 311;
export const KIND_JSDocNonNullableType: number = 312;
export const KIND_JSDocOptionalType: number = 313;
export const KIND_JSDocVariadicType: number = 314;
export const KIND_JSDoc: number = 315;
export const KIND_JSDocText: number = 316;
export const KIND_JSDocTypeLiteral: number = 317;
export const KIND_JSDocSignature: number = 318;
export const KIND_JSDocLink: number = 319;
export const KIND_JSDocLinkCode: number = 320;
export const KIND_JSDocLinkPlain: number = 321;
export const KIND_JSDocUnknownTag: number = 322;
export const KIND_JSDocAugmentsTag: number = 323;
export const KIND_JSDocImplementsTag: number = 324;
export const KIND_JSDocDeprecatedTag: number = 325;
export const KIND_JSDocPublicTag: number = 326;
export const KIND_JSDocPrivateTag: number = 327;
export const KIND_JSDocProtectedTag: number = 328;
export const KIND_JSDocReadonlyTag: number = 329;
export const KIND_JSDocOverrideTag: number = 330;
export const KIND_JSDocCallbackTag: number = 331;
export const KIND_JSDocOverloadTag: number = 332;
export const KIND_JSDocParameterTag: number = 333;
export const KIND_JSDocReturnTag: number = 334;
export const KIND_JSDocThisTag: number = 335;
export const KIND_JSDocTypeTag: number = 336;
export const KIND_JSDocTemplateTag: number = 337;
export const KIND_JSDocTypedefTag: number = 338;
export const KIND_JSDocSeeTag: number = 339;
export const KIND_JSDocPropertyTag: number = 340;
export const KIND_JSDocThrowsTag: number = 341;
export const KIND_JSDocSatisfiesTag: number = 342;
export const KIND_JSDocImportTag: number = 343;
export const KIND_SyntaxList: number = 344;
export const KIND_JSTypeAliasDeclaration: number = 345;
export const KIND_JSImportDeclaration: number = 346;
export const KIND_NotEmittedStatement: number = 347;
export const KIND_PartiallyEmittedExpression: number = 348;
export const KIND_SyntheticReferenceExpression: number = 349;
export const KIND_NotEmittedTypeElement: number = 350;
export const KIND_COUNT: number = 351;

const KIND_NAMES: string[] = [
  "Unknown",
  "EndOfFile",
  "SingleLineCommentTrivia",
  "MultiLineCommentTrivia",
  "NewLineTrivia",
  "WhitespaceTrivia",
  "ConflictMarkerTrivia",
  "NonTextFileMarkerTrivia",
  "NumericLiteral",
  "BigIntLiteral",
  "StringLiteral",
  "JsxText",
  "JsxTextAllWhiteSpaces",
  "RegularExpressionLiteral",
  "NoSubstitutionTemplateLiteral",
  "TemplateHead",
  "TemplateMiddle",
  "TemplateTail",
  "OpenBraceToken",
  "CloseBraceToken",
  "OpenParenToken",
  "CloseParenToken",
  "OpenBracketToken",
  "CloseBracketToken",
  "DotToken",
  "DotDotDotToken",
  "SemicolonToken",
  "CommaToken",
  "QuestionDotToken",
  "LessThanToken",
  "LessThanSlashToken",
  "GreaterThanToken",
  "LessThanEqualsToken",
  "GreaterThanEqualsToken",
  "EqualsEqualsToken",
  "ExclamationEqualsToken",
  "EqualsEqualsEqualsToken",
  "ExclamationEqualsEqualsToken",
  "EqualsGreaterThanToken",
  "PlusToken",
  "MinusToken",
  "AsteriskToken",
  "AsteriskAsteriskToken",
  "SlashToken",
  "PercentToken",
  "PlusPlusToken",
  "MinusMinusToken",
  "LessThanLessThanToken",
  "GreaterThanGreaterThanToken",
  "GreaterThanGreaterThanGreaterThanToken",
  "AmpersandToken",
  "BarToken",
  "CaretToken",
  "ExclamationToken",
  "TildeToken",
  "AmpersandAmpersandToken",
  "BarBarToken",
  "QuestionToken",
  "ColonToken",
  "AtToken",
  "QuestionQuestionToken",
  "BacktickToken",
  "HashToken",
  "EqualsToken",
  "PlusEqualsToken",
  "MinusEqualsToken",
  "AsteriskEqualsToken",
  "AsteriskAsteriskEqualsToken",
  "SlashEqualsToken",
  "PercentEqualsToken",
  "LessThanLessThanEqualsToken",
  "GreaterThanGreaterThanEqualsToken",
  "GreaterThanGreaterThanGreaterThanEqualsToken",
  "AmpersandEqualsToken",
  "BarEqualsToken",
  "BarBarEqualsToken",
  "AmpersandAmpersandEqualsToken",
  "QuestionQuestionEqualsToken",
  "CaretEqualsToken",
  "Identifier",
  "PrivateIdentifier",
  "JSDocCommentTextToken",
  "BreakKeyword",
  "CaseKeyword",
  "CatchKeyword",
  "ClassKeyword",
  "ConstKeyword",
  "ContinueKeyword",
  "DebuggerKeyword",
  "DefaultKeyword",
  "DeleteKeyword",
  "DoKeyword",
  "ElseKeyword",
  "EnumKeyword",
  "ExportKeyword",
  "ExtendsKeyword",
  "FalseKeyword",
  "FinallyKeyword",
  "ForKeyword",
  "FunctionKeyword",
  "IfKeyword",
  "ImportKeyword",
  "InKeyword",
  "InstanceOfKeyword",
  "NewKeyword",
  "NullKeyword",
  "ReturnKeyword",
  "SuperKeyword",
  "SwitchKeyword",
  "ThisKeyword",
  "ThrowKeyword",
  "TrueKeyword",
  "TryKeyword",
  "TypeOfKeyword",
  "VarKeyword",
  "VoidKeyword",
  "WhileKeyword",
  "WithKeyword",
  "ImplementsKeyword",
  "InterfaceKeyword",
  "LetKeyword",
  "PackageKeyword",
  "PrivateKeyword",
  "ProtectedKeyword",
  "PublicKeyword",
  "StaticKeyword",
  "YieldKeyword",
  "AbstractKeyword",
  "AccessorKeyword",
  "AsKeyword",
  "AssertsKeyword",
  "AssertKeyword",
  "AnyKeyword",
  "AsyncKeyword",
  "AwaitKeyword",
  "BooleanKeyword",
  "ConstructorKeyword",
  "DeclareKeyword",
  "GetKeyword",
  "ImmediateKeyword",
  "InferKeyword",
  "IntrinsicKeyword",
  "IsKeyword",
  "KeyOfKeyword",
  "ModuleKeyword",
  "NamespaceKeyword",
  "NeverKeyword",
  "OutKeyword",
  "ReadonlyKeyword",
  "RequireKeyword",
  "NumberKeyword",
  "ObjectKeyword",
  "SatisfiesKeyword",
  "SetKeyword",
  "StringKeyword",
  "SymbolKeyword",
  "TypeKeyword",
  "UndefinedKeyword",
  "UniqueKeyword",
  "UnknownKeyword",
  "UsingKeyword",
  "FromKeyword",
  "GlobalKeyword",
  "BigIntKeyword",
  "OverrideKeyword",
  "OfKeyword",
  "DeferKeyword",
  "QualifiedName",
  "ComputedPropertyName",
  "TypeParameter",
  "Parameter",
  "Decorator",
  "PropertySignature",
  "PropertyDeclaration",
  "MethodSignature",
  "MethodDeclaration",
  "ClassStaticBlockDeclaration",
  "Constructor",
  "GetAccessor",
  "SetAccessor",
  "CallSignature",
  "ConstructSignature",
  "IndexSignature",
  "TypePredicate",
  "TypeReference",
  "FunctionType",
  "ConstructorType",
  "TypeQuery",
  "TypeLiteral",
  "ArrayType",
  "TupleType",
  "OptionalType",
  "RestType",
  "UnionType",
  "IntersectionType",
  "ConditionalType",
  "InferType",
  "ParenthesizedType",
  "ThisType",
  "TypeOperator",
  "IndexedAccessType",
  "MappedType",
  "LiteralType",
  "NamedTupleMember",
  "TemplateLiteralType",
  "TemplateLiteralTypeSpan",
  "ImportType",
  "ObjectBindingPattern",
  "ArrayBindingPattern",
  "BindingElement",
  "ArrayLiteralExpression",
  "ObjectLiteralExpression",
  "PropertyAccessExpression",
  "ElementAccessExpression",
  "CallExpression",
  "NewExpression",
  "TaggedTemplateExpression",
  "TypeAssertionExpression",
  "ParenthesizedExpression",
  "FunctionExpression",
  "ArrowFunction",
  "DeleteExpression",
  "TypeOfExpression",
  "VoidExpression",
  "AwaitExpression",
  "PrefixUnaryExpression",
  "PostfixUnaryExpression",
  "BinaryExpression",
  "ConditionalExpression",
  "TemplateExpression",
  "YieldExpression",
  "SpreadElement",
  "ClassExpression",
  "OmittedExpression",
  "ExpressionWithTypeArguments",
  "AsExpression",
  "NonNullExpression",
  "MetaProperty",
  "SyntheticExpression",
  "SatisfiesExpression",
  "TemplateSpan",
  "SemicolonClassElement",
  "Block",
  "EmptyStatement",
  "VariableStatement",
  "ExpressionStatement",
  "IfStatement",
  "DoStatement",
  "WhileStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "ContinueStatement",
  "BreakStatement",
  "ReturnStatement",
  "WithStatement",
  "SwitchStatement",
  "LabeledStatement",
  "ThrowStatement",
  "TryStatement",
  "DebuggerStatement",
  "VariableDeclaration",
  "VariableDeclarationList",
  "FunctionDeclaration",
  "ClassDeclaration",
  "InterfaceDeclaration",
  "TypeAliasDeclaration",
  "EnumDeclaration",
  "ModuleDeclaration",
  "ModuleBlock",
  "CaseBlock",
  "NamespaceExportDeclaration",
  "ImportEqualsDeclaration",
  "ImportDeclaration",
  "ImportClause",
  "NamespaceImport",
  "NamedImports",
  "ImportSpecifier",
  "ExportAssignment",
  "ExportDeclaration",
  "NamedExports",
  "NamespaceExport",
  "ExportSpecifier",
  "MissingDeclaration",
  "ExternalModuleReference",
  "JsxElement",
  "JsxSelfClosingElement",
  "JsxOpeningElement",
  "JsxClosingElement",
  "JsxFragment",
  "JsxOpeningFragment",
  "JsxClosingFragment",
  "JsxAttribute",
  "JsxAttributes",
  "JsxSpreadAttribute",
  "JsxExpression",
  "JsxNamespacedName",
  "CaseClause",
  "DefaultClause",
  "HeritageClause",
  "CatchClause",
  "ImportAttributes",
  "ImportAttribute",
  "PropertyAssignment",
  "ShorthandPropertyAssignment",
  "SpreadAssignment",
  "EnumMember",
  "SourceFile",
  "JSDocTypeExpression",
  "JSDocNameReference",
  "JSDocAllType",
  "JSDocNullableType",
  "JSDocNonNullableType",
  "JSDocOptionalType",
  "JSDocVariadicType",
  "JSDoc",
  "JSDocText",
  "JSDocTypeLiteral",
  "JSDocSignature",
  "JSDocLink",
  "JSDocLinkCode",
  "JSDocLinkPlain",
  "JSDocUnknownTag",
  "JSDocAugmentsTag",
  "JSDocImplementsTag",
  "JSDocDeprecatedTag",
  "JSDocPublicTag",
  "JSDocPrivateTag",
  "JSDocProtectedTag",
  "JSDocReadonlyTag",
  "JSDocOverrideTag",
  "JSDocCallbackTag",
  "JSDocOverloadTag",
  "JSDocParameterTag",
  "JSDocReturnTag",
  "JSDocThisTag",
  "JSDocTypeTag",
  "JSDocTemplateTag",
  "JSDocTypedefTag",
  "JSDocSeeTag",
  "JSDocPropertyTag",
  "JSDocThrowsTag",
  "JSDocSatisfiesTag",
  "JSDocImportTag",
  "SyntaxList",
  "JSTypeAliasDeclaration",
  "JSImportDeclaration",
  "NotEmittedStatement",
  "PartiallyEmittedExpression",
  "SyntheticReferenceExpression",
  "NotEmittedTypeElement",
];

/** Debug: the tsgo name of a kind. */
export function kindName(k: number): string {
  return k >= 0 && k < KIND_NAMES.length ? KIND_NAMES[k] : "?";
}

// ───────────── predicates on kinds (impl Kind) ─────────────
function isInTypeNodeRange(k: number): boolean {
  return k >= KIND_TypePredicate && k <= KIND_ImportType;
}
/** `IsFunctionLikeDeclaration` */
export function isFunctionLikeDeclaration(k: number): boolean {
  return (
    k === KIND_FunctionDeclaration || k === KIND_MethodDeclaration || k === KIND_Constructor || k === KIND_GetAccessor ||
    k === KIND_SetAccessor || k === KIND_FunctionExpression || k === KIND_ArrowFunction
  );
}
/** `IsIterationStatement(node, false)` */
export function isIterationStatement(k: number): boolean {
  return k === KIND_ForStatement || k === KIND_ForInStatement || k === KIND_ForOfStatement || k === KIND_DoStatement || k === KIND_WhileStatement;
}
/** `IsFunctionLikeKind` */
export function isFunctionLike(k: number): boolean {
  return (
    isFunctionLikeDeclaration(k) || k === KIND_MethodSignature || k === KIND_CallSignature || k === KIND_JSDocSignature ||
    k === KIND_ConstructSignature || k === KIND_IndexSignature || k === KIND_FunctionType || k === KIND_ConstructorType
  );
}
/** `IsClassLike` */
export function isClassLike(k: number): boolean {
  return k === KIND_ClassDeclaration || k === KIND_ClassExpression;
}
/** `IsTypeNodeKind` */
export function isTypeNode(k: number): boolean {
  return (
    isInTypeNodeRange(k) || k === KIND_AnyKeyword || k === KIND_UnknownKeyword || k === KIND_NumberKeyword || k === KIND_BigIntKeyword ||
    k === KIND_ObjectKeyword || k === KIND_BooleanKeyword || k === KIND_StringKeyword || k === KIND_SymbolKeyword || k === KIND_VoidKeyword ||
    k === KIND_UndefinedKeyword || k === KIND_NeverKeyword || k === KIND_IntrinsicKeyword || k === KIND_ExpressionWithTypeArguments ||
    k === KIND_JSDocAllType || k === KIND_JSDocNullableType || k === KIND_JSDocNonNullableType || k === KIND_JSDocOptionalType ||
    k === KIND_JSDocVariadicType
  );
}
/** `Kind::is_access_expression` */
export function isAccessExpression(k: number): boolean {
  return k === KIND_PropertyAccessExpression || k === KIND_ElementAccessExpression;
}

// ───────────── the handle ─────────────
/** `Node(u32)` is an Int32 here: NODE_NONE = -1 (u32::MAX), NODE_FILE = 0 (the SourceFile). A handle is a HIR row's index in the
 * concatenated space of the node vectors (`nodeBases`), plus in its top bits a `Part`: a tsgo node that carries no information
 * beyond a HIR node has no row of its own, it is "that part of that row". Sources have < 2^26 rows. */
export const NODE_NONE: number = -1;
export const NODE_FILE: number = 0;
/** The number of bits of a handle that select the HIR row. */
export const NODE_ROW_BITS: number = 26;
export const NODE_ROW_MASK: number = (1 << 26) - 1;

// `Part`: the high bits of a handle. 0 = it is a HIR row.

/** `Node::row`: the HIR row that it is, or is a part of. */
export function nodeRow(n: number): number {
  return n & NODE_ROW_MASK;
}
/** `Node::part`: 0 if it is a HIR row, else PART_*. */
export function nodePart(n: number): number {
  return n < 0 ? 0 : n >>> NODE_ROW_BITS;
}
/** `Node::with`: that part of the row `n`. */
export function nodeWith(n: number, part: number): number {
  if (n < 0) return NODE_NONE;
  return (nodeRow(n) | (part << NODE_ROW_BITS)) | 0;
}

// ───────────── the index space of the node vectors ─────────────
// `node_vectors!`: the order of the vectors; the first handle of vector i is nodeBases[i]; nodeBases[19] is the end.
export const NV_EXPR: number = 0;
export const NV_STMT: number = 1;
export const NV_TYPE: number = 2;
export const NV_PAT: number = 3;
export const NV_PAT_PROP: number = 4;
export const NV_PAT_ELEM: number = 5;
export const NV_PARAM: number = 6;
export const NV_TYPE_PARAM: number = 7;
export const NV_MEMBER: number = 8;
export const NV_PROP: number = 9;
export const NV_VAR_DECL: number = 10;
export const NV_CASE: number = 11;
export const NV_ENUM_MEMBER: number = 12;
export const NV_IMPORT_SPEC: number = 13;
export const NV_EXPORT_SPEC: number = 14;
export const NV_TUPLE_ELEM: number = 15;
export const NV_MODIFIER: number = 16;
export const NV_NAME: number = 17;
export const NV_PAREN: number = 18;
export const NV_COUNT: number = 19;

export const nodeBases = new Int32Array(NV_COUNT + 1);

/** `File::node_bases` (`finish_nodes`): fixes the index space for the rows of the file. Call after parsing and after `finishHir()`. */
export function finishNodes(): void {
  const b = nodeBases;
  b[0] = 1;
  b[1] = (b[0] | 0) + hir.nExprs;
  b[2] = (b[1] | 0) + hir.nStmts;
  b[3] = (b[2] | 0) + hir.nTypes;
  b[4] = (b[3] | 0) + hir.nPats;
  b[5] = (b[4] | 0) + hir.nPatProps;
  b[6] = (b[5] | 0) + hir.nPatElems;
  b[7] = (b[6] | 0) + hir.nParams;
  b[8] = (b[7] | 0) + hir.nTypeParams;
  b[9] = (b[8] | 0) + hir.nMembers;
  b[10] = (b[9] | 0) + hir.nProps;
  b[11] = (b[10] | 0) + hir.nVarDecls;
  b[12] = (b[11] | 0) + hir.nCases;
  b[13] = (b[12] | 0) + hir.nEnumMembers;
  b[14] = (b[13] | 0) + hir.nImportSpecs;
  b[15] = (b[14] | 0) + hir.nExportSpecs;
  b[16] = (b[15] | 0) + hir.nTupleElems;
  b[17] = (b[16] | 0) + hir.nModifiers;
  b[18] = (b[17] | 0) + hir.nNames;
  b[19] = (b[18] | 0) + hir.nParens;
}

/** `Row::row`: the handle of the HIR row `id` of vector `v` (NV_*). NODE_NONE for NONE. */
export function rowNode(v: number, id: number): number {
  return id < 0 ? NODE_NONE : ((nodeBases[v] | 0) + id) | 0;
}

/** Result slots of `nodeData`. */
let ndVector = 0;
let ndId = 0;
export function getNdVector(): number {
  return ndVector;
}
export function getNdId(): number {
  return ndId;
}
/** Results of `nodeData`. */
export const ND_NONE: number = 0;
export const ND_FILE: number = 1;
export const ND_ROW: number = 2;
export const ND_PART: number = 3;

/**
 * `File::data`: decodes a handle. Returns ND_NONE / ND_FILE / ND_PART (then `getNdId()` is the handle of the row it is a part of and
 * the part is `nodePart(n)`) / ND_ROW (then `getNdVector()` is NV_* and `getNdId()` the id in that vector's table).
 */
export function nodeData(n: number): number {
  if (n < 0) return ND_NONE;
  if (n === NODE_FILE) return ND_FILE;
  if (nodePart(n) !== 0) {
    ndId = nodeRow(n);
    return ND_PART;
  }
  // Most queried nodes are expressions or statements.
  const b = nodeBases;
  if (n >= (b[0] | 0) && n < (b[1] | 0)) {
    ndVector = NV_EXPR;
    ndId = (n - (b[0] | 0)) | 0;
    return ND_ROW;
  }
  if (n >= (b[1] | 0) && n < (b[2] | 0)) {
    ndVector = NV_STMT;
    ndId = (n - (b[1] | 0)) | 0;
    return ND_ROW;
  }
  for (let v = 2; v < NV_COUNT; v++) {
    if (n >= (b[v] | 0) && n < (b[v + 1] | 0)) {
      ndVector = v;
      ndId = (n - (b[v] | 0)) | 0;
      return ND_ROW;
    }
  }
  return ND_NONE;
}

/**
 * `ToNode for ExprId`, without the Fn special case (a function expression's node is its owner, node.rs `Owners`, not ported): the
 * handle of the expression row.
 */
export function exprNode(e: number): number {
  return rowNode(NV_EXPR, e);
}
/** `ToNode::to_child for ExprId`: the node that represents the expression in its parent: the outermost parentheses around it, else the expression. */
export function exprChildNode(e: number): number {
  // The outermost parentheses around it come last in `parens` (sorted by expression).
  let lo = 0;
  let hi = hir.nParens;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((hir.parenExpr[mid] | 0) <= e) lo = mid + 1;
    else hi = mid;
  }
  const last = lo - 1;
  if (last >= 0 && (hir.parenExpr[last] | 0) === e) return rowNode(NV_PAREN, last);
  return exprNode(e);
}
export function stmtNode(s: number): number {
  return rowNode(NV_STMT, s);
}
export function typeNode(t: number): number {
  return rowNode(NV_TYPE, t);
}
/** `ToNode for InterfaceId`: the node of the declaration is its statement. */
export function interfaceNode(i: number): number {
  return i < 0 ? NODE_NONE : rowNode(NV_STMT, hir.interfaceStmt[i] | 0);
}
export function aliasNode(a: number): number {
  return a < 0 ? NODE_NONE : rowNode(NV_STMT, hir.aliasStmt[a] | 0);
}
export function enumNode(e: number): number {
  return e < 0 ? NODE_NONE : rowNode(NV_STMT, hir.enumStmt[e] | 0);
}
export function moduleNode(m: number): number {
  return m < 0 ? NODE_NONE : rowNode(NV_STMT, hir.moduleStmt[m] | 0);
}
export function importNode(i: number): number {
  return i < 0 ? NODE_NONE : rowNode(NV_STMT, hir.importStmt[i] | 0);
}
export function importEqualsNode(i: number): number {
  return i < 0 ? NODE_NONE : rowNode(NV_STMT, hir.importEqualsStmt[i] | 0);
}
export function exportNode(x: number): number {
  return x < 0 ? NODE_NONE : rowNode(NV_STMT, hir.exportStmt[x] | 0);
}
void NONE;
