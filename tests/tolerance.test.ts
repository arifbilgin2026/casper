/* Tolerance for baby speech — and the property that must survive it:
 * forgiving about pronunciation, still strict about WHICH card. However
 * generous the setting, one card's exact word never scores another card. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { heardIt } from "../src/match.js";
import { skeleton, soundDistance } from "../src/phonetic.js";

interface Card { word: string; also?: string[] }
const LANGS = ["tr", "ru", "en"] as const;
const DECK = Object.fromEntries(LANGS.map((l) => [l, (JSON.parse(readFileSync(
  path.join(__dirname, "..", "decks", `words_${l}.json`), "utf8")) as { words: Card[] }).words]));

const TOL = ["normal", "high"] as const;

describe("sound skeletons", () => {
  it("collapse what babies confuse and ignore what spelling invents", () => {
    expect(skeleton("rabbit")).toEqual(skeleton("wabbit"));   // r → w
    expect(skeleton("frog")).toEqual(skeleton("fwog"));       // cluster, r → w
    expect(skeleton("banana")).toEqual(["P", "V", "N", "V", "N", "V"]);
    expect(skeleton("мама")).toEqual(skeleton("mama"));       // one scheme, all scripts
  });

  it("dropping the final consonant is cheap; swapping a sound is not", () => {
    expect(soundDistance(skeleton("ca"), skeleton("cat"))).toBe(0.5);
    expect(soundDistance(skeleton("tat"), skeleton("cat"))).toBe(1);
  });
});

describe("what a baby actually says", () => {
  // [language, target card, what comes out of the recogniser]
  const FORMS: [typeof LANGS[number], string, string][] = [
    ["en", "cat", "tat"], ["en", "dog", "dod"], ["en", "frog", "fwog"],
    ["en", "rabbit", "wabbit"], ["en", "bear", "bea"], ["en", "ball", "baw"],
    ["tr", "kedi", "tedi"], ["tr", "fil", "pil"], ["tr", "balık", "balı"],
    ["tr", "köpek", "köpe"], ["tr", "elma", "ema"],
    ["ru", "кошка", "кока"], ["ru", "собака", "бака"], ["ru", "лошадь", "лоша"],
  ];

  it("high tolerance accepts the usual simplifications that off rejects", () => {
    for (const [lang, word, said] of FORMS) {
      const card = DECK[lang]!.find((c) => c.word === word);
      if (!card) continue;                                    // deck may not list it
      const others = DECK[lang]!.map((c) => c.word);
      expect(heardIt(said, word, [], others, "high"),
             `${lang}: "${said}" for ${word} at high tolerance`).toBe(true);
    }
  });

  it("…and the default stays strict: the same sounds are not credited", () => {
    let accepted = 0, tried = 0;
    for (const [lang, word, said] of FORMS) {
      if (!DECK[lang]!.some((c) => c.word === word)) continue;
      tried++;
      if (heardIt(said, word, [], DECK[lang]!.map((c) => c.word), "off")) accepted++;
    }
    expect(tried).toBeGreaterThan(8);
    expect(accepted).toBeLessThan(tried);                     // tolerance adds real reach
  });
});

describe("identity still wins over generosity", () => {
  it("a sound that fits another card better is that card's, not this one's", () => {
    // "ba" is a perfect fit for "bee" and only a clipped fit for "ball".
    const en = DECK.en!.map((c) => c.word);
    expect(heardIt("ba", "ball", [], en, "high")).toBe(false);
    expect(heardIt("ba", "bee", [], en, "high")).toBe(true);
  });

  it("at normal tolerance a coin-flip between two cards earns neither", () => {
    const en = DECK.en!.map((c) => c.word);
    // "baw" fits both ball and bear equally; high lets the card on screen win.
    expect(heardIt("baw", "ball", [], en, "normal")).toBe(false);
    expect(heardIt("baw", "ball", [], en, "high")).toBe(true);
  });
});

describe.each(LANGS)("deck %s stays safe under tolerance", (lang) => {
  const deck = DECK[lang]!;
  const all = deck.map((c) => c.word);

  it.each(TOL)("[%s] every word still matches itself", (tol) => {
    for (const c of deck) {
      expect(heardIt(c.word, c.word, c.also ?? [], all, tol), c.word).toBe(true);
    }
  });

  it.each(TOL)("[%s] zero cross-matches: one card's exact word never scores another", (tol) => {
    for (const target of deck) {
      for (const other of deck) {
        if (other.word === target.word) continue;
        expect(heardIt(other.word, target.word, target.also ?? [], all, tol),
               `saying ${other.word} scores ${target.word} at ${tol}`).toBe(false);
      }
    }
  });
});
