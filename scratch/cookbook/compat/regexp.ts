const re = /(\d+)-(\w+)/; const m = re.exec("abc 12-xy"); console.log(m ? m[1] + m[2] : "none", /^a+$/.test("aaa"), "a1b22".replace(/\d+/g, "#"));
