/* The matcher is the part that must never regress: forgiving about
 * pronunciation, strict about identity. "maz" for muz is a win; "kedi" for
 * keçi is not — she named a different animal. */
import { describe, expect, it } from "vitest";
import { heardIt, norm, saidExactly } from "../src/match.js";

const DECK = ["kedi", "keçi", "tilki", "fil", "muz", "elma", "at", "ay",
              "karpuz", "karınca", "köpek", "köpekbalığı"];

describe("heardIt", () => {
  it("exact word matches itself", () => {
    expect(heardIt("kedi", "kedi", [], DECK)).toBe(true);
  });

  it("case and diacritics fold — 'Кошка' IS 'кошка'", () => {
    expect(heardIt("Кошка", "кошка", [], ["кошка", "собака"])).toBe(true);
    expect(heardIt("KEDI", "kedi", [], DECK)).toBe(true);
  });

  it("finds the word inside a small sentence", () => {
    expect(heardIt("bu elma", "elma", [], DECK)).toBe(true);
  });

  it("accepts listed alternates, single and two-word", () => {
    expect(heardIt("apa", "elma", ["apa"], DECK)).toBe(true);
    expect(heardIt("köpek balığı", "köpekbalığı", ["köpek balığı"], DECK)).toBe(true);
  });

  it("near miss wins only when the target is the best fit", () => {
    expect(heardIt("maz", "muz", [], DECK)).toBe(true);
  });

  it("the wrong animal never scores, even one edit away", () => {
    expect(heardIt("kedi", "keçi", [], DECK)).toBe(false);
    expect(heardIt("at", "ay", [], DECK)).toBe(false);
  });

  it("a clean prefix beats a coincidental edit distance (til → tilki, not fil)", () => {
    expect(heardIt("til", "tilki", [], DECK)).toBe(true);
  });

  it("an ambiguous prefix does not score (kar: karpuz or karınca?)", () => {
    expect(heardIt("kar", "karpuz", [], DECK)).toBe(false);
  });

  it("rejects empty and noise, ignores punctuation", () => {
    expect(heardIt("", "kedi", [], DECK)).toBe(false);
    expect(heardIt("   ", "kedi", [], DECK)).toBe(false);
    expect(heardIt("muz!", "muz", [], DECK)).toBe(true);
  });
});

describe("norm", () => {
  it("strips marks and folds case across scripts", () => {
    expect(norm("  Muz! ")).toBe("muz");
    expect(norm("Кошка")).toBe("кошка");
  });
});

describe("saidExactly (the early-commit test)", () => {
  const D = ["ay", "ayı", "kedi", "keçi", "at", "elma"];

  it("fires on an exact word or a listed alternate", () => {
    expect(saidExactly("kedi", "kedi", [], D)).toBe(true);
    expect(saidExactly("Kedi!", "kedi", [], D)).toBe(true);
    expect(saidExactly("kitty", "kedi", ["kitty"], D)).toBe(true);
    expect(saidExactly("bu elma", "elma", [], D)).toBe(true);
  });

  it("never fires on a word that is still the start of a longer card", () => {
    // "ay" (moon) may be the first half of "ayı" (bear): wait for the final.
    expect(saidExactly("ay", "ay", [], D)).toBe(false);
    expect(saidExactly("ayı", "ayı", [], D)).toBe(true);
  });

  it("is strict where heardIt is generous: no prefixes, no near misses", () => {
    expect(saidExactly("kedı", "kedi", [], D)).toBe(false);
    expect(saidExactly("ke", "kedi", [], D)).toBe(false);
    expect(heardIt("maz", "muz", [], ["muz", "kedi"])).toBe(true);
    expect(saidExactly("maz", "muz", [], ["muz", "kedi"])).toBe(false);
  });
});
