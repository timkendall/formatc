const g: number[][] = []; for (let i = 0; i < 3; i++) { g.push(new Array(3).fill(0)); } g[1][1] = 5; console.log(g[1][1], g.length, g.flat().length);
