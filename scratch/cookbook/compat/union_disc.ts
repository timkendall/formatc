type Sh = { kind: "c"; r: number } | { kind: "s"; w: number };
function area(s: Sh): number { switch (s.kind) { case "c": return 3 * s.r * s.r; case "s": return s.w * s.w; } }
console.log(area({ kind: "c", r: 2 }), area({ kind: "s", w: 3 }));
