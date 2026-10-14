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
    (game as { mouth: unknown }).mouth = { speaking: false };
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


describe("a sound the recogniser never turned into a word", () => {
  afterEach(() => { vi.useRealTimers(); });

  interface Step { kind: string; val: string }

  function room(ageBand: "baby" | "toddler") {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const io: GameIO = { sendJson: (o) => sent.push(o), sendPcm: () => {}, onStar: () => {}, log: () => {} };
    const real = new Game("tr", deckFile.words, deckFile.phrases, "v", io, { noLlm: true, ageBand });
    const g = real as unknown as Record<string, unknown>;
    const performed: Step[][] = [];
    const mouth = { speaking: false };
    g.ears = { feed() {}, finalize() {}, close() {} };
    g.mouth = mouth;
    g.chatter = new Chatter(null, "tr", deckFile.phrases);
    g.perform = async (script: Step[]) => { performed.push(script); };
    g.card = deckFile.words[0];                       // "kedi"
    g.seen = new Set([deckFile.words[0]!.word]);
    const chunk = (peak: number) => {
      const b = Buffer.alloc(640);
      for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? peak : -peak, i * 2);
      return b;
    };
    const hear = (peak: number, ms: number) => {
      for (let t = 0; t < ms; t += 20) { real.feed(chunk(peak)); vi.advanceTimersByTime(20); }
    };
    const tick = async () => { await (g.tick as () => Promise<void>).call(g); await vi.advanceTimersByTimeAsync(10); };
    return { real, g, performed, mouth, hear, tick, sent };
  }

  it("toddler: a sound with no words is met with an instant encouragement, not silence", async () => {
    const { performed, sent, hear, tick } = room("toddler");
    hear(130, 600); hear(2800, 400); hear(130, 1300);        // a babble, then quiet
    await tick();
    expect(sent).toContainEqual(expect.objectContaining({ type: "said", text: "…" }));
    expect(performed.length).toBe(1);
    const says = performed[0]!.filter((s) => s.kind === "say").map((s) => s.val);
    expect(deckFile.phrases.again).toContain(says[0]);
  });

  it("toddler: the third unheard try simply tells her the word and moves on", async () => {
    const { g, performed, hear, tick } = room("toddler");
    g.tries = 2;                                              // this will be the third
    hear(130, 600); hear(2800, 400); hear(130, 1300);
    await tick();
    const steps = performed[0]!;
    expect(steps[0]).toEqual({ kind: "say", val: "kedi!" });
    expect(steps.some((s) => s.kind === "card")).toBe(true);
    expect(steps.some((s) => s.kind === "star")).toBe(false); // told, not earned
  });

  it("baby: the same babble is a WIN — chime, star, and the word said for her", async () => {
    const { performed, hear, tick } = room("baby");
    hear(130, 600); hear(2800, 400); hear(130, 1300);
    await tick();
    const kinds = performed[0]!.map((s) => s.kind);
    expect(kinds).toContain("sound");
    expect(kinds).toContain("star");
    expect(performed[0]!.some((s) => s.kind === "say" && s.val === "kedi!")).toBe(true);
    expect(kinds).toContain("card");
  });

  it("a click or a cough is not an attempt", async () => {
    const { performed, hear, tick } = room("baby");
    hear(130, 600); hear(2800, 100); hear(130, 1500);
    await tick();
    expect(performed.length).toBe(0);
  });

  it("a sound the recogniser DID turn into text is handled as an answer, not as unheard", async () => {
    const { g, sent, hear, tick } = room("toddler");
    hear(130, 600); hear(2800, 400);
    (g.onPartial as (t: string) => void).call(g, "mama");      // it heard *something*
    hear(130, 1300);
    await tick();
    // Whatever the game does with "mama" (it judges the stuck interim as a
    // wrong answer), it is not the *unheard* path — only that one reports "…".
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "said", text: "…" }));
  });

  it("the game's own voice is never mistaken for her", async () => {
    const { mouth, performed, hear, tick } = room("baby");
    mouth.speaking = true;                                     // we are talking
    hear(2800, 600);                                           // echo of our own speech
    mouth.speaking = false;
    hear(130, 1500);
    await tick();
    expect(performed.length).toBe(0);
  });
});
