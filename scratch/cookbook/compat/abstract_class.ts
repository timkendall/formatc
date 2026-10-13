abstract class Shape { abstract area(): number; describe(): string { return "area=" + this.area(); } }
class Sq extends Shape { constructor(private s: number) { super(); } area(): number { return this.s * this.s; } }
class Rect extends Shape { constructor(public w: number, public h: number) { super(); } area(): number { return this.w * this.h; } }
const shapes: Shape[] = [new Sq(2), new Rect(2, 3)];
for (const s of shapes) console.log(s.describe());
