class Stack<T> { items: T[] = []; push(x: T): void { this.items.push(x); } pop(): T | undefined { return this.items.pop(); } get size(): number { return this.items.length; } }
const s = new Stack<number>(); s.push(1); s.push(2); const t = new Stack<string>(); t.push("a");
console.log(s.pop(), s.size, t.pop(), t.size);
