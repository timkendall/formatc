const a = Uint8Array.from([1, 2, 3]); const b = new Uint8Array([4, 5]); const c = new Uint8Array(5); c.set(a); c.set(b, 3); console.log(c, a.subarray(1).length, Array.from(c).join());
