const s = new Set<number>([1, 2, 2, 3]); s.add(4); s.delete(1); console.log(s.size, s.has(2), [...s]);
