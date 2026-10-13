const a = new Array<number>(3).fill(0); a[1] = 4; const g: number[][] = []; for (let i = 0; i < 2; i++) g.push(new Array<number>(2).fill(i)); console.log(a, g, g[1][1]);
