// The part of `format/tailwind.rs` that style sheets use: the classes behind `@apply`. `src/format/tailwind.ts` is the
// stub of the rest (it calls back into the driver for class orders, which is not ported yet).
import { ByteBuf } from "../../base/bytebuf.ts";

/** oxfmt's `sortTailwindcss` for one file: `handle` is `FormatOptions.tailwind` (-1: none). */
export function tailwindIsActive(handle: number): boolean {
  return handle >= 0;
}

/** `Tailwind::follows_plugin`: `prettier-plugin-tailwindcss` in a Prettier config has turned it on. */
export function tailwindFollowsPlugin(handle: number): boolean {
  return handle >= 0 && false;
}

/** `Tailwind::sorted_to_apply(params)`: the classes of `params[s, e)` sorted, appended to `out`; false: there are none or they
 * stay as they are (nothing is written). TODO(port): needs the class orders from the driver (`Orders`); until then the
 * text is left as it is. */
export function tailwindSortedToApply(handle: number, params: Uint8Array, s: number, e: number, out: ByteBuf): boolean {
  void handle;
  void params;
  void s;
  void e;
  void out;
  return false;
}
