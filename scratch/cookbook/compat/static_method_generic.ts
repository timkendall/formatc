class U { static pick<T>(a: T, b: T, first: boolean): T { return first ? a : b; } } console.log(U.pick(1, 2, false), U.pick("a", "b", true));
