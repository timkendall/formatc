const w = new WeakMap<object, number>(); const k = {}; w.set(k, 1); console.log(w.get(k));
