/* Did the toddler say the word? Deliberately generous.
 *
 * A two-year-old saying "apa" for "elma" has done the thing we are asking of
 * them. Scoring that as a miss teaches them the game is unwinnable, so this
 * accepts a near miss — and keeps the judging of "near" in one small, readable,
 * TESTED place rather than inside a model. Whether two strings are the same
 * word has a correct answer; a model is the wrong tool for it.
 */

import { Tolerance, allowance, skeleton, soundDistance } from "./phonetic.js";

const FOLD: Record<string, string> = {
  "â": "a", "î": "i", "û": "u", "ä": "a", "ë": "e", "ï": "i", "ö": "o",
  "ü": "u", "Â": "A", "Î": "I", "Û": "U",
};

export function norm(s: string): string {
  let t = (s ?? "").trim().toLowerCase().normalize("NFKC");
  t = t.replace(/[âîûäëïöüÂÎÛ]/g, (c) => FOLD[c] ?? c);
  // Keep letters, digits and spaces of ANY script (Turkish, Cyrillic, Latin).
  return [...t].filter((c) => /[\p{L}\p{N}\s]/u.test(c)).join("");
}

/** Levenshtein, short strings only. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      ));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * True only when `said` CERTAINLY contains the target word: an exact word (or
 * a listed alternate) that is not also the start of some longer card word.
 *
 * This is the early-commit test — it runs on interim (still-changing)
 * transcripts, so it must never fire on something the child is still in the
 * middle of saying. "ay" (moon) is a prefix of "ayı" (bear): an interim "ay"
 * is NOT certain, the next interim may be "ayı", so it waits for the final.
 * heardIt() stays the generous judge for finals; this is the strict one.
 */
export function saidExactly(
  said: string, target: string, also: string[] = [], others: string[] = [],
): boolean {
  const t = norm(target);
  const alts = new Set(also.map(norm));
  const rivals = others.map(norm).filter((o) => o !== t);
  for (const word of norm(said).split(/\s+/)) {
    if (!word || (word !== t && !alts.has(word))) continue;
    if (rivals.some((r) => r !== word && r.startsWith(word))) continue;
    return true;
  }
  return false;
}

/**
 * True if `said` is a fair attempt at `target`.
 *
 * `others` is every OTHER word in the deck. Being generous about near misses
 * is right for a toddler, but not so generous that naming the wrong animal
 * earns a star: "kedi" is one edit from "keçi" and "at" from "ay". So a near
 * miss only counts when the target is the BEST fit in the whole deck — if
 * some other card fits as well or better, she named that one instead, and we
 * ask again. Forgiving about pronunciation, strict about which animal it is.
 */
export function heardIt(
  said: string, target: string, also: string[] = [], others: string[] = [],
  tolerance: Tolerance = "off",
): boolean {
  const s = norm(said), t = norm(target);
  if (!s) return false;
  if (spelledAttempt(s, t, also, others)) return true;
  return tolerance !== "off" && soundsLike(s, t, others, tolerance);
}

/** The spelling-level judge: exact, listed alternates, prefixes, near misses. */
function spelledAttempt(s: string, t: string, also: string[], others: string[]): boolean {
  const alts = new Set(also.map(norm));
  if (alts.has(s)) return true;              // a two-word attempt, e.g. "köpek balığı"
  const rivals = others.map(norm).filter((o) => o !== t);
  for (const word of s.split(/\s+/)) {
    if (word === t || alts.has(word)) return true;   // exact, or hand-listed

    // A clean prefix is strong evidence: "til" starts tilki and starts no
    // other card. Judge it only against cards it could ALSO be the start
    // of — not against every word that happens to be one letter away,
    // which would let "fil" veto "tilki".
    if (word.length >= 2 && (t.startsWith(word) || word.startsWith(t))) {
      if (!rivals.some((r) => r.startsWith(word) || word.startsWith(r))) return true;
      continue;
    }

    // Otherwise a near miss counts only if nothing else fits as well.
    const d = distance(word, t);
    if (d > Math.max(1, Math.floor(t.length / 3))) continue;
    if (rivals.some((r) => distance(word, r) <= d)) continue;
    return true;
  }
  return false;
}

/**
 * The sound-level judge, the last resort for a baby's simplifications.
 *
 * Still "forgiving about pronunciation, strict about identity", on sound:
 *  - a word that IS another card's exact word is that card, never this one;
 *  - the target must sit within the tolerance's allowance of the sounds said;
 *  - and no other card may sit strictly closer (at "normal" it must also not
 *    tie — a coin-flip between two cards earns neither; at "high" a tie goes
 *    to the card on screen, since a baby who is trying should not be punished
 *    for a sound that fits two pictures).
 */
function soundsLike(s: string, t: string, others: string[], tol: Tolerance): boolean {
  const target = skeleton(t);
  if (target.length < 2) return false;
  const rivals = others.map(norm).filter((o) => o !== t);
  const allowed = allowance(target.length, tol);
  for (const word of s.split(/\s+/)) {
    if (rivals.includes(word)) continue;            // she named a different card
    const heard = skeleton(word);
    if (heard.length < 2 && !(heard.length === 1 && target.length <= 2)) continue;
    const d = soundDistance(heard, target);
    if (d > allowed) continue;
    const best = Math.min(...rivals.map((r) => soundDistance(heard, skeleton(r))), Infinity);
    if (tol === "high" ? d <= best : d < best) return true;
  }
  return false;
}
