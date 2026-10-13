class N { v = 1; next: N | null = null; }
const a = new N(); a.next = new N(); a.next.v = 5;
let p: N | null = a; let s = 0; while (p !== null) { s += p.v; p = p.next; } console.log(s);
