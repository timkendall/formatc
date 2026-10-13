console.log(JSON.stringify({ a: 1, b: [1, 2], c: "x" })); const o = JSON.parse('{"a":1}') as { a: number }; console.log(o.a);
