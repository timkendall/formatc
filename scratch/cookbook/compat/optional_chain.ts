class A { b: A | null = null; v: number = 5; }
const a = new A(); a.b = new A();
console.log(a.b?.v, a.b?.b?.v, a?.v);
const arr: number[] | undefined = [1,2]; console.log(arr?.[1], arr?.length);
const u: number | undefined = undefined; console.log(u ?? 7, (u as number | undefined)?.toFixed);
