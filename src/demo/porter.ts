// The Porter stemmer exactly as SQLite's FTS5 `porter` tokenizer implements
// it (fts5_tokenize.c), so the browser demo stems words the way the app's
// search index does. Input is an already folded token: lowercase, diacritics
// removed.

type Rule = [suffix: string, output: string, cond?: (stem: string) => boolean];

function isVowel(c: string, yIsVowel: boolean) {
  return c === "a" || c === "e" || c === "i" || c === "o" || c === "u" || (yIsVowel && c === "y");
}

/** Skips one vowel run then one consonant; returns the index after it, or 0. */
function gobbleVC(stem: string, prevCons: boolean) {
  let cons = prevCons;
  let i = 0;
  for (; i < stem.length; i++) {
    cons = !isVowel(stem[i], cons);
    if (!cons) break;
  }
  for (i++; i < stem.length; i++) {
    cons = !isVowel(stem[i], cons);
    if (cons) return i + 1;
  }
  return 0;
}

const mGt0 = (stem: string) => gobbleVC(stem, false) > 0;

function mGt1(stem: string) {
  const n = gobbleVC(stem, false);
  return n > 0 && gobbleVC(stem.slice(n), true) > 0;
}

function mEq1(stem: string) {
  const n = gobbleVC(stem, false);
  return n > 0 && gobbleVC(stem.slice(n), true) === 0;
}

/** *o: ends consonant-vowel-consonant, the last not w, x or y. */
function oStar(stem: string) {
  const last = stem[stem.length - 1];
  if (last === "w" || last === "x" || last === "y") return false;
  let mask = 0;
  let cons = false;
  for (const c of stem) {
    cons = !isVowel(c, cons);
    mask = ((mask << 1) + (cons ? 1 : 0)) & 0xff;
  }
  return (mask & 0x7) === 0x5;
}

function hasVowel(stem: string) {
  for (let i = 0; i < stem.length; i++) if (isVowel(stem[i], i > 0)) return true;
  return false;
}

const mGt1SorT = (stem: string) => (stem.endsWith("s") || stem.endsWith("t")) && mGt1(stem);

/**
 * Applies the first rule whose suffix matches (the word must be longer than
 * the suffix). Returns the new word and the index of the rule applied, or -1
 * if none matched or its condition failed.
 */
function apply(word: string, rules: Rule[]): [string, number] {
  for (const [i, [suffix, output, cond]] of rules.entries()) {
    if (word.length > suffix.length && word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (cond && !cond(stem)) return [word, -1];
      return [stem + output, i];
    }
  }
  return [word, -1];
}

const step1B: Rule[] = [
  ["eed", "ee", mGt0],
  ["ed", "", hasVowel],
  ["ing", "", hasVowel],
];
const step1B2: Rule[] = [
  ["at", "ate"],
  ["bl", "ble"],
  ["iz", "ize"],
];
const step2: Rule[] = [
  ["ational", "ate", mGt0],
  ["tional", "tion", mGt0],
  ["enci", "ence", mGt0],
  ["anci", "ance", mGt0],
  ["izer", "ize", mGt0],
  ["logi", "log", mGt0],
  ["bli", "ble", mGt0],
  ["alli", "al", mGt0],
  ["entli", "ent", mGt0],
  ["eli", "e", mGt0],
  ["ousli", "ous", mGt0],
  ["ization", "ize", mGt0],
  ["ation", "ate", mGt0],
  ["ator", "ate", mGt0],
  ["alism", "al", mGt0],
  ["iveness", "ive", mGt0],
  ["fulness", "ful", mGt0],
  ["ousness", "ous", mGt0],
  ["aliti", "al", mGt0],
  ["iviti", "ive", mGt0],
  ["biliti", "ble", mGt0],
];
const step3: Rule[] = [
  ["ical", "ic", mGt0],
  ["ness", "", mGt0],
  ["icate", "ic", mGt0],
  ["iciti", "ic", mGt0],
  ["ful", "", mGt0],
  ["ative", "", mGt0],
  ["alize", "al", mGt0],
];
const step4: Rule[] = [
  ["al", "", mGt1],
  ["ance", "", mGt1],
  ["ence", "", mGt1],
  ["er", "", mGt1],
  ["ic", "", mGt1],
  ["able", "", mGt1],
  ["ible", "", mGt1],
  ["ant", "", mGt1],
  ["ement", "", mGt1],
  ["ment", "", mGt1],
  ["ent", "", mGt1],
  ["ion", "", mGt1SorT],
  ["ou", "", mGt1],
  ["ism", "", mGt1],
  ["ate", "", mGt1],
  ["iti", "", mGt1],
  ["ous", "", mGt1],
  ["ive", "", mGt1],
  ["ize", "", mGt1],
];

const utf8 = new TextEncoder();

export function porterStem(token: string): string {
  // FTS5 leaves tokens under 3 or over 64 bytes as they are.
  const bytes = utf8.encode(token).length;
  if (bytes < 3 || bytes > 64) return token;
  let w = token;

  // Step 1a.
  if (w.endsWith("s")) {
    if (w.endsWith("es")) {
      w = (w.length > 4 && w.endsWith("sses")) || (w.length > 3 && w.endsWith("ies"))
        ? w.slice(0, -2)
        : w.slice(0, -1);
    } else if (!w.endsWith("ss")) {
      w = w.slice(0, -1);
    }
  }

  // Step 1b. Only removing "ed" or "ing" (not "eed" -> "ee") goes on to
  // the clean-up rules.
  const [afterB, ruleB] = apply(w, step1B);
  w = afterB;
  if (ruleB > 0) {
    const [afterB2, ruleB2] = apply(w, step1B2);
    w = afterB2;
    if (ruleB2 < 0) {
      const c = w[w.length - 1];
      if (!isVowel(c, false) && c !== "l" && c !== "s" && c !== "z" && c === w[w.length - 2]) {
        w = w.slice(0, -1);
      } else if (mEq1(w) && oStar(w)) {
        w += "e";
      }
    }
  }

  // Step 1c.
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";

  w = apply(w, step2)[0];
  w = apply(w, step3)[0];
  w = apply(w, step4)[0];

  // Step 5a.
  if (w.endsWith("e")) {
    const stem = w.slice(0, -1);
    if (mGt1(stem) || (mEq1(stem) && !oStar(stem))) w = stem;
  }
  // Step 5b.
  if (w.length > 1 && w.endsWith("ll") && mGt1(w.slice(0, -1))) w = w.slice(0, -1);

  return w;
}
