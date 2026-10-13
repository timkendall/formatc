class PErr extends Error { constructor(public pos: number, msg: string) { super(msg); this.name = "PErr"; } }
try { throw new PErr(3, "bad"); } catch (e) { if (e instanceof PErr) console.log(e.pos, e.message, e.name); }
