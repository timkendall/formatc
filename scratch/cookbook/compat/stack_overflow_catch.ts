function d(n: number): number { return 1 + d(n + 1); } try { d(0); } catch (e) { console.log(e instanceof RangeError); }
