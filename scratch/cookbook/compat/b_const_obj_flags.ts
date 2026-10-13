const FLAGS = { A: 1, B: 2, C: 4 } as const; let f = 0; f |= FLAGS.A; f |= FLAGS.C; console.log(f, (f & FLAGS.B) === 0);
