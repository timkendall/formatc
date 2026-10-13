// A random document that is TOML for the most part (the syntax; a key may be there twice), for the differential test.
import { Rng } from "./corpus.ts";

export function genValue(rng: Rng, depth: number): string {
  const k = rng.below(depth > 3 ? 9 : 12);
  switch (k) {
    case 0: return String(rng.below(1000) - 300);
    case 1: return rng.pick(["1_000", "0xDEAD_beef", "0o17", "0b101", "+7", "-0", "9223372036854775807", "123456789012345678901234567890"]);
    case 2: return rng.pick(["1.5", "-0.01", "6.626e-34", "5e+22", "224_617.445_991_228", "inf", "-inf", "nan", "+nan", "3.14e0"]);
    case 3: return rng.pick(["true", "false"]);
    case 4: return rng.pick(['"abc"', '"a\\tb\\u00e9\\U0001F600"', '""', '"q\\"q"', '"\\e\\x41"']);
    case 5: return rng.pick(["'abc'", "''", "'C:\\Users\\x'"]);
    case 6: return rng.pick(['"""\nmulti\nline"""', '"""a \\\n   b"""', "'''\nraw\n'''", '"""x""""', "'''x''''"]);
    case 7: return rng.pick(["1979-05-27", "07:32:00", "07:32", "1979-05-27T07:32:00Z", "1979-05-27 07:32:00.999-07:00", "1979-05-27T07:32:00"]);
    case 8: return rng.pick(["2000-02-29", "1999-12-31T23:59:60Z", "00:00:00.123456789123"]);
    case 9: {
      const items: string[] = [];
      const cnt = rng.below(4);
      for (let i = 0; i < cnt; i++) items.push(genValue(rng, depth + 1));
      const sep = rng.pick([", ", ",\n  ", " , ", ",\n# c\n"]);
      const trailing = rng.below(2) === 0 ? "," : "";
      const open = rng.pick(["[", "[ ", "[\n  ", "[ # c\n"]);
      return open + items.join(sep) + (items.length > 0 ? trailing : "") + rng.pick(["]", " ]", "\n]"]);
    }
    default: {
      const items: string[] = [];
      const cnt = rng.below(4);
      for (let i = 0; i < cnt; i++) items.push(genKey(rng) + rng.pick([" = ", "=", " =  "]) + genValue(rng, depth + 1));
      const trailing = rng.below(3) === 0 ? "," : "";
      return rng.pick(["{", "{ ", "{\n  "]) + items.join(rng.pick([", ", ",", ",\n  "])) + (items.length > 0 ? trailing : "") + rng.pick(["}", " }", "\n}"]);
    }
  }
}

export function genKey(rng: Rng): string {
  const seg = () => rng.pick(["a", "b-c", "key_1", "42", '"q q"', "'l'", "z", '"\\u00e9"']);
  const cnt = 1 + rng.below(3);
  const segs: string[] = [];
  for (let i = 0; i < cnt; i++) segs.push(seg());
  return segs.join(rng.pick([".", " . ", ". ", " ."]));
}

export function genDoc(rng: Rng): Buffer {
  let t = rng.pick(["", "# c\n", "\n\n"]);
  const lines = 1 + rng.below(10);
  for (let i = 0; i < lines; i++) {
    const k = rng.below(5);
    if (k === 0) t += "[" + rng.pick(["", " "]) + genKey(rng) + rng.pick(["", " "]) + "]" + rng.pick(["", " # c"]) + "\n";
    else if (k === 1) t += "[[" + genKey(rng) + "]]" + rng.pick(["", "  # c"]) + "\n";
    else t += genKey(rng) + rng.pick([" = ", "=", " =\t"]) + genValue(rng, 0) + rng.pick(["", " ", " # c", "\t#c"]) + rng.pick(["\n", "\r\n", "\n\n"]);
  }
  return Buffer.from(t, "utf8");
}
