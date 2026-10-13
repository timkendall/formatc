interface Box<T> { v: T } function unbox<T>(b: Box<T>): T { return b.v; } console.log(unbox({ v: 5 }), unbox({ v: "s" }));
