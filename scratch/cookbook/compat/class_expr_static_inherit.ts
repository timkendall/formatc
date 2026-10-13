class A { static make(): A { return new this(); } name(): string { return "A"; } } class B extends A { name(): string { return "B"; } } console.log(B.make().name());
