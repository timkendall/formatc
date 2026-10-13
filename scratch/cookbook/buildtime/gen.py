import random, sys
random.seed(1)
def func(i, ncase=20):
    lines = [f"export function f{i}(src: Uint8Array, pos: number, n: number): number {{"]
    lines.append("  let p = pos;")
    lines.append("  while (p < n) {")
    lines.append("    const c = src[p] | 0;")
    lines.append("    switch (c) {")
    for k in range(ncase):
        lines.append(f"      case {32+k}: p = ((p | 0) + {1 + k % 3}) | 0; if (p > n) return -1; break;")
    lines.append(f"      default: return (p * {i + 3} + c) & 0xffff;")
    lines.append("    }")
    lines.append("  }")
    lines.append("  return p;")
    lines.append("}")
    lines.append(f"export class C{i} {{ a: number = {i}; b: number = 0; m(x: number): number {{ this.b = this.b + x * this.a; if (this.b > 1000) {{ this.b = this.b - 1000; }} return this.b; }} n(s: string): number {{ return s.length + this.a; }} }}")
    return "\n".join(lines)
# single file: 500 functions
src = ["// synthetic"]
for i in range(500): src.append(func(i))
src.append("const buf = new Uint8Array(1024); for (let i = 0; i < 1024; i++) buf[i] = 32 + (i % 20);")
src.append("let total = 0;")
for i in range(500): src.append(f"total += f{i}(buf, 0, 1024) + new C{i}().m({i});")
src.append("console.log(total);")
open("single/big.ts","w").write("\n".join(src))
# multi-file: 50 modules x 10 functions + main
for m in range(50):
    body = []
    for j in range(10): body.append(func(m*10+j))
    open(f"multi/m{m}.ts","w").write("\n".join(body))
main = []
for m in range(50):
    names = ", ".join(f"f{m*10+j}, C{m*10+j}" for j in range(10))
    main.append(f'import {{ {names} }} from "./m{m}.ts";')
main.append("const buf = new Uint8Array(1024); for (let i = 0; i < 1024; i++) buf[i] = 32 + (i % 20);")
main.append("let total = 0;")
for i in range(500): main.append(f"total += f{i}(buf, 0, 1024) + new C{i}().m({i});")
main.append("console.log(total);")
open("multi/main.ts","w").write("\n".join(main))
