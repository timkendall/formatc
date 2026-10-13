import { x, y as why, Foo } from "./reexp_mid.ts";
import type { Shape } from "./reexp_types.ts";
import * as ns from "./reexp_mid.ts";
const s: Shape = { w: 2 };
console.log(x, why, new Foo().z, ns.x, s.w);
