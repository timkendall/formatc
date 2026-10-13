// Port of vendor/bun/src/format/tailwind.rs (oxfmt's `sortTailwindcss` / `prettier-plugin-tailwindcss`): STUB.
//
// The sorting of classes needs the order of every class (`Orders`), which the Rust code asks the host for (a callback into the
// driver that runs Tailwind's design system). Until the driver provides that, a handle (`FormatOptions.tailwind`) never
// sorts anything: every text with classes is left as it is. `src/format/css/tailwind_hook.ts` is what the style sheets call.
export { tailwindFollowsPlugin, tailwindIsActive, tailwindSortedToApply } from "./css/tailwind_hook.ts";
