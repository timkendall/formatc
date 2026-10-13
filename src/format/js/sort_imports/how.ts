// `How` and `SortImports` of vendor/bun/src/format/js/sort_imports/mod.rs: how to sort imports, with the settings checked and the regular
// expressions compiled. One is made for an option set on each thread; `FormatOptions.sortImports` is its handle (an index of `registry`).
import type { OxfmtOptions } from "./oxfmt/options.ts";
import type { TrivagoOptions } from "./trivago.ts";
import type { IanvsOptions } from "./ianvs.ts";
import type { OrganizeOptions } from "./organize.ts";

export const HOW_TRIVAGO: number = 0;
export const HOW_IANVS: number = 1;
export const HOW_OXFMT: number = 2;
/** `sortImports` from bunfig.toml or `--sort-imports`. Runs oxfmt's sorter plus `native.ts`. */
export const HOW_NATIVE: number = 3;
export const HOW_ORGANIZE: number = 4;

export class SortImports {
  how: number;
  trivago: TrivagoOptions | null = null;
  ianvs: IanvsOptions | null = null;
  /** For `HOW_OXFMT` and `HOW_NATIVE`. */
  oxfmt: OxfmtOptions | null = null;
  organize: OrganizeOptions | null = null;
  constructor(how: number) {
    this.how = how;
  }

  /** Whether it is `format` that sorts the imports, and not `sortedText`: then what it writes has the tokens of the file in another order. */
  isAppliedByFormat(): boolean {
    return this.how === HOW_OXFMT || this.how === HOW_NATIVE;
  }

  /** Whether `sortedText` asks which imports are used. */
  needsSymbols(): boolean {
    return this.how === HOW_ORGANIZE && this.organize !== null && !this.organize.skipsDestructiveCodeActions;
  }

  /** Whether the imports of code in a file of another language are sorted. */
  appliesToEmbeddedCode(): boolean {
    return this.how !== HOW_ORGANIZE;
  }
}

class Registry {
  items: SortImports[] = [];
}
const registry = new Registry();

/** The handle of `how` (what `FormatOptions.sortImports` holds). */
export function registerSortImports(how: SortImports): number {
  registry.items.push(how);
  return registry.items.length - 1;
}

/** null for -1. */
export function sortImportsOf(handle: number): SortImports | null {
  if (handle < 0 || handle >= registry.items.length) return null;
  return registry.items[handle] as SortImports;
}
