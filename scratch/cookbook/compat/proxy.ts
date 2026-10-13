const p = new Proxy({}, { get: () => 5 }); console.log((p as any).x);
