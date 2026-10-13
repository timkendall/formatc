// `keyword_suggestion` of recover.rs and the `GetSpellingSuggestion` of regexp_scanner.rs that it calls: the "Did you mean" of
// "Unknown keyword or identifier. Did you mean '{0}'?" (1435). A LEAF (no imports): the words are JS strings, this is the error path.

/** `GetViableKeywordSuggestions`: TypeScript's keywords of more than two letters. */
const KEYWORD_SUGGESTIONS: string[] = [
  "abstract", "accessor", "any", "asserts", "assert", "bigint", "boolean", "break", "case", "catch", "class", "continue",
  "const", "constructor", "debugger", "declare", "default", "defer", "delete", "else", "enum", "export", "extends", "false",
  "finally", "for", "from", "function", "get", "immediate", "implements", "import", "infer", "instanceof", "interface",
  "intrinsic", "keyof", "let", "module", "namespace", "never", "new", "null", "number", "object", "package", "private",
  "protected", "public", "override", "out", "readonly", "require", "global", "return", "satisfies", "set", "static",
  "string", "super", "switch", "symbol", "this", "throw", "true", "try", "type", "typeof", "undefined", "unique",
  "unknown", "using", "var", "void", "while", "with", "yield", "async", "await",
];

function runes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i) as number;
    if (c > 0xffff) i++;
    out.push(c);
  }
  return out;
}

function lowerRune(c: number): number {
  return String.fromCodePoint(c).toLowerCase().codePointAt(0) as number;
}

/** `levenshteinWithMax`: a substitution costs 2, and a case change costs almost nothing. -1: more than `maxValue`. */
function levenshteinWithMax(s1: number[], s2: number[], maxValue: number): number {
  let previous: number[] = [];
  for (let j = 0; j <= s2.length; j++) previous.push(j);
  let current: number[] = [];
  for (let j = 0; j <= s2.length; j++) current.push(0);
  const big = maxValue + 0.01;
  for (let i = 0; i < s1.length; i++) {
    const c1 = s1[i];
    const row = i + 1;
    const minJ = row > maxValue ? Math.ceil(row - maxValue) : 1;
    const maxJ = Math.min(Math.floor(maxValue + row), s2.length);
    let colMin = row;
    current[0] = row;
    for (let j = 1; j < Math.min(minJ, s2.length + 1); j++) current[j] = big;
    for (let j = minJ; j <= maxJ; j++) {
      const c2 = s2[j - 1];
      let distance: number;
      if (c1 === c2) distance = previous[j - 1];
      else {
        const substitution = previous[j - 1] + (lowerRune(c1) === lowerRune(c2) ? 0.1 : 2.0);
        distance = Math.min(previous[j] + 1.0, current[j - 1] + 1.0, substitution);
      }
      current[j] = distance;
      colMin = Math.min(colMin, distance);
    }
    for (let j = Math.min(maxJ + 1, s2.length + 1); j <= s2.length; j++) current[j] = big;
    if (colMin > maxValue) return -1;
    const t = previous;
    previous = current;
    current = t;
  }
  const distance = previous[s2.length];
  return distance <= maxValue ? distance : -1;
}

/** `GetSpellingSuggestionForStrings`: the best candidate for `name`, or null. */
export function spellingSuggestion(name: string, candidates: string[]): string | null {
  const nameRunes = runes(name);
  const maximumLengthDifference = Math.max(2, Math.floor(nameRunes.length * 0.34));
  let bestDistance = Math.floor(nameRunes.length * 0.4) + 0.9;
  let best: string | null = null;
  for (let k = 0; k < candidates.length; k++) {
    const candidate = candidates[k];
    // `candidate_name.len()` in Rust is the number of BYTES.
    const candidateBytes = Buffer.byteLength(candidate, "utf8");
    if (candidateBytes === 0 || Math.abs(candidateBytes - nameRunes.length) > maximumLengthDifference || candidate === name) continue;
    const candidateRunes = runes(candidate);
    if (candidateBytes < 3) {
      // Two-letter names are easy to distinguish, unless they differ only by case.
      let same = candidateRunes.length === nameRunes.length;
      for (let i = 0; same && i < nameRunes.length; i++) if (lowerRune(candidateRunes[i]) !== lowerRune(nameRunes[i])) same = false;
      if (!same) continue;
    }
    const distance = levenshteinWithMax(nameRunes, candidateRunes, bestDistance);
    if (distance < 0) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    } else if (best === null || candidate < best) {
      best = candidate;
    }
  }
  return best;
}

/** `keyword_suggestion`: the suggestion of `parseErrorForMissingSemicolonAfter` for `word`. */
export function keywordSuggestion(word: string): string | null {
  const found = spellingSuggestion(word, KEYWORD_SUGGESTIONS);
  if (found !== null) return found;
  for (let i = 0; i < KEYWORD_SUGGESTIONS.length; i++) {
    const keyword = KEYWORD_SUGGESTIONS[i];
    if (word.length > keyword.length + 2 && word.startsWith(keyword)) return keyword + " " + word.slice(keyword.length);
  }
  return null;
}
