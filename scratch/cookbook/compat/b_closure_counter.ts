function mk(): () => number { let c = 0; return () => ++c; } const f = mk(); f(); console.log(f());
