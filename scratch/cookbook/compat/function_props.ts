function f(): number { return 1; } (f as any).x = 5; console.log(f());
