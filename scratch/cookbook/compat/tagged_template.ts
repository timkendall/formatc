function tag(s: TemplateStringsArray, ...v: number[]): string { return s.join("|") + v.join(","); } console.log(tag`a${1}b${2}c`);
