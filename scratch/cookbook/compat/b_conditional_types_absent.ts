type A<T> = T extends string ? number : boolean; const x: A<string> = 5; console.log(x);
