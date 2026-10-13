let n = 0;
outer: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (j === 3) continue outer; if (i === 3) break outer; n++; } }
console.log(n);
