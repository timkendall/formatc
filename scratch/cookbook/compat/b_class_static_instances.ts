class Tok { static readonly EOF = new Tok(0); static readonly ID = new Tok(1); private constructor(public readonly id: number) {} } console.log(Tok.EOF.id, Tok.ID.id);
