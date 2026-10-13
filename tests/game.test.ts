/* Code-owned guards around the model's mouth, and the code-owned celebration.
 * Whether a line hands the child the answer is a string question with a
 * correct answer — so it is computed, never prompted. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
