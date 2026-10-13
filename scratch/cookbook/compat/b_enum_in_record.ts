enum E { A, B } const names: Record<number, string> = { [E.A]: "a", [E.B]: "b" }; console.log(names[E.B]);
