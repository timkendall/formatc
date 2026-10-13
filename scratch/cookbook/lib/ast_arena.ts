// Struct-of-arrays AST arena: node fields are columns of Int32Arrays; a node is just an index.
// No per-node allocation, no refcounting, cache friendly. Reference for the formatter's AST.
export class AstArena {
  kind: Int32Array;
  start: Int32Array;
  end: Int32Array;
  first: Int32Array;   // first child (0 = none; index 0 is a reserved null node)
  next: Int32Array;    // next sibling
  data: Int32Array;    // kind-specific payload (e.g. interned id, operator, flags)
  count: number;
  constructor(cap: number) {
    const c = cap < 16 ? 16 : cap;
    this.kind = new Int32Array(c);
    this.start = new Int32Array(c);
    this.end = new Int32Array(c);
    this.first = new Int32Array(c);
    this.next = new Int32Array(c);
    this.data = new Int32Array(c);
    this.count = 1; // node 0 = null
  }
  grow(): void {
    const c = this.kind.length * 2;
    const k = new Int32Array(c); k.set(this.kind); this.kind = k;
    const s = new Int32Array(c); s.set(this.start); this.start = s;
    const e = new Int32Array(c); e.set(this.end); this.end = e;
    const f = new Int32Array(c); f.set(this.first); this.first = f;
    const n = new Int32Array(c); n.set(this.next); this.next = n;
    const d = new Int32Array(c); d.set(this.data); this.data = d;
  }
  add(kind: number, start: number, end: number, data: number): number {
    const id = this.count;
    if (id === this.kind.length) this.grow();
    this.kind[id] = kind | 0;
    this.start[id] = start | 0;
    this.end[id] = end | 0;
    this.data[id] = data | 0;
    this.count = id + 1;
    return id;
  }
  // Append child to parent's child list. `lastChild` is tracked by the caller (builder) to keep O(1).
  appendChild(parent: number, lastChild: number, child: number): void {
    if (lastChild === 0) this.first[parent] = child | 0;
    else this.next[lastChild] = child | 0;
  }
}
