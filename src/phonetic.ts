/* How a baby simplifies a word, as a comparison on sound instead of spelling.
 *
 * Spelling distance can't see what children do to words. They don't make typos,
 * they make systematic simplifications: r and l become w ("wabbit"), k and g
 * become t and d ("tat" for cat, "dod" for dog), the final consonant falls off
 * ("ca"), a cluster collapses ("fwog"), a syllable is dropped ("nana" for
 * banana). The recogniser then spells whatever it heard however it likes.
 *
 * So both sides are reduced to a coarse SOUND SKELETON — vowels collapsed to
 * one symbol, consonants to their manner class — and compared there. The same
 * reduction covers Turkish, Russian and English letters, since a child's
 * simplifications are the same in every language.
 *
 * This only ever supplies TOLERANCE. Whether a skeleton is close enough, and
 * whether the target is the best fit in the deck, is decided by match.ts.
 */

/** Letter → sound class. Anything not listed is dropped (h, ğ, ', etc.). */
const CLASS: Record<string, string> = {};
const put = (cls: string, letters: string) => { for (const c of letters) CLASS[c] = cls; };
put("V", "aeıioöuüyаеёиоуыэюя");        // vowels (tr/en y in "kuyu" is a glide, but
                                        // as a trailing "y" it behaves as a vowel)
put("P", "pbпб");                       // lips, stopped
put("T", "tdтд");                       // tongue-tip, stopped
put("K", "kgqcкг");                     // back of tongue, stopped (c is /k/ in en)
put("F", "fvфв");                       // lip-teeth friction
put("S", "szşçjсзшщчцж");               // hissing sounds and affricates
put("N", "mnмн");                       // nasals
put("L", "lrwйлр");                     // liquids and glides — babies swap all of them

/** The skeleton of one word: classes in order, repeats collapsed. */
export function skeleton(word: string): string[] {
  const out: string[] = [];
  for (const ch of word.toLowerCase()) {
    const c = CLASS[ch];
    if (!c) continue;
    if (out[out.length - 1] !== c) out.push(c);       // "bb" → P, "aa"/"ai" → V
  }
  return out;
}

/**
 * Distance between what was said and a target, in skeleton symbols.
 * Dropping the TARGET's final consonant costs only half: it is the commonest
 * thing a toddler does to a word ("ca", "do", "ba").
 */
export function soundDistance(said: string[], target: string[]): number {
  const full = editDistance(said, target);
  // Toddlers also drop an unstressed FIRST syllable of a longer word:
  // "nana" for banana, "бака" for собака. Cheap, but only for 5+ sounds, so
  // a short word can't lose its whole front half for free.
  if (target.length >= 5 && target[0] !== "V" && target[1] === "V") {
    return Math.min(full, 0.5 + editDistance(said, target.slice(2)));
  }
  return full;
}

function editDistance(said: string[], target: string[]): number {
  const n = said.length, m = target.length;
  const last = m - 1;
  const dropCost = (j: number) => (j === last && target[j] !== "V" ? 0.5 : 1);
  let prev = [0];
  for (let j = 0; j < m; j++) prev.push(prev[j]! + dropCost(j));
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur.push(Math.min(
        (prev[j] ?? 0) + 1,                                            // extra sound said
        (cur[j - 1] ?? 0) + dropCost(j - 1),                           // sound left out
        (prev[j - 1] ?? 0) + (said[i - 1] === target[j - 1] ? 0 : 1),  // sound swapped
      ));
    }
    prev = cur;
  }
  return prev[m] ?? 0;
}

export type Tolerance = "off" | "normal" | "high";

/** The most sound-distance a target of this skeleton length may be forgiven. */
export function allowance(len: number, tol: Tolerance): number {
  if (tol === "off") return -1;
  if (tol === "normal") return len >= 5 ? 1 : 0.5;     // short words: only a dropped end
  return len >= 5 ? 1.5 : len >= 3 ? 1 : 0.5;          // "high": a baby's whole repertoire
}
