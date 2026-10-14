/* Code-owned guards around the model's mouth, and the code-owned celebration.
 * Whether a line hands the child the answer is a string question with a
 * correct answer — so it is computed, never prompted. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chatter } from "../src/chatter.js";
import { Game, GameIO } from "../src/game.js";
import type { Card } from "../src/persona.js";

const deckFile = JSON.parse(readFileSync(
  path.join(__dirname, "..", "decks", "words_tr.json"), "utf8"),
) as { words: Card[]; phrases: Record<"ask" | "yes" | "again", string[]> };

function playable() {
  const sent: unknown[] = [];
  const stars: string[] = [];
  const io: GameIO = {
    sendJson: (o) => sent.push(o),
    sendPcm: () => {},
    onStar: (w) => stars.push(w),
    log: () => {},
  };
  // noLlm keeps the constructor from needing AWS credentials in CI.
  const game = new Game("tr", deckFile.words, deckFile.phrases, "voice", io,
                        { noLlm: true });
  // show() warms the chatter, which start() normally creates.
  (game as unknown as { chatter: Chatter }).chatter =
    new Chatter(null, "tr", deckFile.phrases);
  return { game: game as unknown as Record<string, unknown>, sent, stars, real: game };
}

describe("the answer-leak guard", () => {
  it("the card's word in our mouth is a leak; token-based, not substring", () => {
    const { game } = playable();
    (game as { card: Card | null }).card = { word: "at", emoji: "🐴" };
    const leaks = (t: string) => (game.leaksAnswer as (t: string) => boolean).call(game, t);
    expect(leaks("Hop, at!")).toBe(true);
    expect(leaks("Bu ne?")).toBe(false);
    expect(leaks("Hadi atla!")).toBe(false);   // "atla" is not "at"
  });

  it("saying it is fine once she got it, or after three tries, or with no card", () => {
    const { game } = playable();
    const leaks = (t: string) => (game.leaksAnswer as (t: string) => boolean).call(game, t);
    (game as { card: Card | null }).card = { word: "at", emoji: "🐴" };
    (game as { verdict: boolean | null }).verdict = true;
    expect(leaks("Evet, at!")).toBe(false);
    (game as { verdict: boolean | null }).verdict = null;
    (game as { tries: number }).tries = 3;
    expect(leaks("Bu bir at.")).toBe(false);
    (game as { card: Card | null }).card = null;
    expect(leaks("At!")).toBe(false);
  });
});

describe("the code-owned turn", () => {
  it("a right answer always earns star + confetti + next card, even when omitted", () => {
    const { game } = playable();
    (game as { card: Card | null }).card = deckFile.words[0]!;
    (game as { verdict: boolean | null }).verdict = true;
    const ensure = game.ensureTurn as (s: unknown[]) => { kind: string }[];
    const script = ensure.call(game, [{ kind: "say", val: "Aferin!" }]);
    const kinds = script.map((s) => s.kind);
    expect(kinds).toContain("star");
    expect(kinds).toContain("sound");
    expect(kinds).toContain("card");
  });

  it("a seen card cannot be re-shown while unseen cards remain", () => {
    const { game } = playable();
    const show = game.show as (w: string) => void;
    show.call(game, "kedi");
    show.call(game, "köpek");
    show.call(game, "kedi");
    expect((game as { card: Card | null }).card?.word).not.toBe("kedi");
  });
});

describe("hearing her before the recogniser does", () => {
  afterEach(() => { vi.useRealTimers(); });

  function listening() {
    vi.useFakeTimers();
    const { game, real } = playable();
    (game as { ears: unknown }).ears = { feed() {}, finalize() {}, close() {} };
    const chunk = (peak: number) => {
      const b = Buffer.alloc(640);
      for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? peak : -peak, i * 2);
      return b;
    };
    // one 20 ms chunk of microphone audio, on the clock the server would see
    const hear = (peak: number, n = 1) => {
      for (let i = 0; i < n; i++) { real.feed(chunk(peak)); vi.advanceTimersByTime(20); }
    };
    return { real, hear };
  }

  it("room noise is not a voice; a clear sound is, for a while", () => {
    const { real, hear } = listening();
    hear(130, 50);                                    // quiet room
    expect(real.childLoudWithin(900)).toBe(false);
    hear(2800);                                       // "kedi"
    expect(real.childLoudWithin(900)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(real.childLoudWithin(900)).toBe(false);    // …and only for a while
  });

  it("a noisy room raises the bar instead of reading as constant speech", () => {
    const { real, hear } = listening();
    hear(900, 400);                                   // 8 s of fan / TV hum
    expect(real.childLoudWithin(900)).toBe(false);
    hear(6000);                                       // but a real voice over it still counts
    expect(real.childLoudWithin(900)).toBe(true);
  });
});
