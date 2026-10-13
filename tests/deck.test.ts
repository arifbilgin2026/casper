/* Every deck, whole: no word fails itself, no alternate is rejected, and no
 * utterance can score the wrong card. A data bug once let "banana" score a
 * pig — these run over every pair so it cannot come back. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { heardIt, norm } from "../src/match.js";

interface Card { word: string; emoji: string; also?: string[]; cry?: string }
interface Deck { words: Card[]; phrases: Record<string, string[]> }

const LANGS = ["tr", "ru", "en"] as const;
const DATA = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(readFileSync(
  path.join(__dirname, "..", "decks", `words_${l}.json`), "utf8")) as Deck]));

describe.each(LANGS)("deck %s", (lang) => {
  const deck = DATA[lang]!.words;
  const all = deck.map((w) => w.word);

  it("every word matches itself", () => {
    for (const w of deck) {
      expect(heardIt(w.word, w.word, w.also ?? [], all),
             `${w.word} does not match itself`).toBe(true);
    }
  });

  it("every alternate is accepted for its own card", () => {
    for (const w of deck) {
      for (const alt of w.also ?? []) {
        expect(heardIt(alt, w.word, w.also ?? [], all),
               `alternate ${alt} rejected for ${w.word}`).toBe(true);
      }
    }
  });

  it("zero cross-matches: one card's word never scores another", () => {
    for (const target of deck) {
      for (const other of deck) {
        if (other.word === target.word) continue;
        expect(heardIt(other.word, target.word, target.also ?? [], all),
               `saying ${other.word} scores ${target.word}`).toBe(false);
      }
    }
  });

  it("no alternate IS another card's word (banana must not score a pig)", () => {
    for (const w of deck) {
      for (const alt of w.also ?? []) {
        for (const other of deck) {
          if (other.word === w.word) continue;
          expect(norm(alt), `${w.word} alternate ${alt} IS card ${other.word}`)
            .not.toBe(norm(other.word));
        }
      }
    }
  });

  it("cards are unique and complete", () => {
    const names = deck.map((w) => norm(w.word));
    expect(new Set(names).size).toBe(names.length);
    for (const w of deck) expect(w.emoji, `${w.word} has no picture`).toBeTruthy();
  });

  it("cries never collide with answers (we SAY the cry at every flip)", () => {
    const words = new Set(deck.map((w) => norm(w.word)));
    for (const w of deck) {
      for (const token of norm(w.cry ?? "").split(/\s+/).filter(Boolean)) {
        expect(words.has(token), `cry of ${w.word} contains deck word ${token}`)
          .toBe(false);
      }
    }
  });

  it("canned phrases exist for every kind and never contain a deck word", () => {
    const phrases = DATA[lang]!.phrases;
    const words = new Set(deck.map((w) => norm(w.word)));
    for (const kind of ["ask", "yes", "again"]) {
      expect(phrases[kind]?.length, `no canned ${kind} lines`).toBeTruthy();
    }
    // An ask/again line that contains an answer hands the child the word.
    for (const kind of ["ask", "again"]) {
      for (const p of phrases[kind]!) {
        for (const token of norm(p).split(/\s+/)) {
          expect(words.has(token), `canned ${kind} line "${p}" contains "${token}"`)
            .toBe(false);
        }
      }
    }
  });
});
