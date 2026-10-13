function f(): void { try { throw new Error("a"); } catch (e) { throw new Error("b: " + (e as Error).message); } } try { f(); } catch (e) { console.log((e as Error).message); }
