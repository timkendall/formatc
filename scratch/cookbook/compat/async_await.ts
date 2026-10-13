async function f(x: number): Promise<number> { return x + 1; }
async function main(): Promise<void> { const v = await f(1); console.log(v); }
main();
