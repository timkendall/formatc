class Q<T> { static of<U>(v: U): Q<U> { return new Q<U>(v); } constructor(public v: T) {} } console.log(Q.of(3).v);
