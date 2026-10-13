enum F { None = 0, A = 1 << 0, B = 1 << 1, C = 1 << 2 } let f: number = F.A | F.C; console.log((f & F.B) !== 0, (f & F.C) !== 0, f);
