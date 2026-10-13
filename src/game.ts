/* One game: one child, one deck, one persona — and the line between them.
 *
 * THE RULE THE WHOLE FILE ANSWERS TO: anything with a correct answer is
 * computed; only things that need judgement go to the model. Whether she said
 * the word is string comparison (match.ts). Whether she gets the star, whether
 * the game advances, whether confetti fires — code, always, instantly. What to
 * SAY about it, which picture comes next, which sound where — the persona.
 * The persona chooses how to celebrate, never whether to.
 *
 * The model is also never on the critical path: a correct answer celebrates
 * straight from the transcript with prepared lines (celebrate()), and every
 * model failure mode — slow, down, narrating, repeating itself, leaking the
 * answer — lands in a code-owned fallback rather than in the child's ears.
 */
import { Brain } from "./llm.js";
import { Chatter } from "./chatter.js";
import { Ears } from "./ears.js";
import { Mouth } from "./mouth.js";
import { CUES } from "./sounds.js";
import {
  Card, Lang, SayStream, Step, firstClause, isNarration, parse, stateText,
  system, unwrap,
} from "./persona.js";
import { heardIt, norm } from "./match.js";

const TICK_MS = 200;          // how often we consider asking
const MIN_QUIET_S = 0.45;     // she must have been quiet this long…
const HEARD_QUIET_S = 0.1;    // …unless a settled answer is already waiting
const MIN_SINCE_US_S = 0.6;   // and we must not have just spoken
const NUDGE_AFTER_S = 6;      // a long silence always earns a look
const FLUSH_NUDGE_S = 0.6;    // interim stuck this long → ask the ears to settle
const JUDGE_INTERIM_S = 1.2;  // still stuck → judge the grey text ourselves
const FIRST_SOUND_S = 1.4;    // the model has this long to start a clause
const ECHO_TAIL_MS = 350;     // the ears keep ignoring us this long after we stop

export interface GameIO {
  sendJson(obj: unknown): void;
  sendPcm(pcm: Buffer): void;
  /** Called on every star so progress outlives the session (auth's whole point). */
  onStar(word: string, score: number): void;
  log(line: string): void;
}

export class Game {
  // the room — the only truth the app keeps
  private card: Card | null = null;
  private score: number;
  private tries = 0;
  private seen = new Set<string>();
  private heard = "";
  private verdict: boolean | null = null;
  private talking = false;
  private lastVoice = Date.now();
  private lastUs = 0;

  private ears!: Ears;
  private mouth!: Mouth;
  private chatter!: Chatter;
  private brain: Brain | null;

  private thinking = false;     // an ask/celebrate cycle is in flight
  private busy = false;         // a script is being performed (audio going out)
  private muteUntil = 0;
  private lastSaid = "";
  private lastSpeech = "";      // normed words of our previous line
  private lastCard: string | null = null;
  private interim = "";
  private interimAt = 0;
  private nudged = false;
  private judged: [string, number] = ["", 0];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private lang: Lang,
    private deck: Card[],
    private phrases: Record<"ask" | "yes" | "again", string[]>,
    private voice: string,
    private io: GameIO,
    opts: { noLlm?: boolean; startScore?: number } = {},
  ) {
    this.brain = opts.noLlm ? null : new Brain();
    this.score = opts.startScore ?? 0;
  }

  async start(): Promise<void> {
    this.mouth = new Mouth((pcm) => this.io.sendPcm(pcm), this.voice, this.lang);
    this.chatter = new Chatter(this.brain, this.lang, this.phrases);
    this.ears = new Ears(this.lang,
      (t) => this.onPartial(t), (t) => { void this.onFinal(t); });
    await this.ears.start();
    this.io.sendJson({ type: "ready" });
    this.show(this.deck[0]!.word);            // a picture is up before we speak
    const cry = this.card?.cry;
    if (cry) void this.perform([{ kind: "say", val: cry + "!" }]);
    this.ticker = setInterval(() => { void this.tick(); }, TICK_MS);
  }

  feed(pcm: Buffer): void { this.ears.feed(pcm); }

  next(): void {                              // the skip button
    this.heard = "";
    this.verdict = null;                      // the old card's verdict dies with it
    this.card = null;                         // let the persona choose the next one
  }

  close(): void {
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ears.close();
    this.io.log(`game over: score ${this.score}, `
      + `lines ${this.chatter.usedLlm} written / ${this.chatter.usedCanned} canned`);
  }

  // ── our own voice ──────────────────────────────────────────────────────

  private deaf(): boolean {
    return this.mouth.speaking || this.busy || Date.now() < this.muteUntil;
  }

  /** Do one line, in the order it was written. */
  private async perform(script: Step[]): Promise<void> {
    const said = norm(script.filter((s) => s.kind === "say").map((s) => s.val).join(" "));
    this.busy = true;
    try {
      for (const step of script) {
        if (step.kind === "say") {
          await this.mouth.say(step.val);
          await this.mouth.waitQuiet();
        } else if (step.kind === "sound" && CUES[step.val]) {
          this.mouth.playPcm(CUES[step.val]!);
          await this.mouth.waitQuiet();
        } else if (step.kind === "card") {
          const before = this.card?.word;
          this.show(step.val);
          // The animal introduces itself the instant it appears — "hav hav
          // hav!" — from data, before any model word.
          const cry = this.card?.cry;
          if (this.card?.word !== before && cry) {
            await this.mouth.say(cry + "!");
            await this.mouth.waitQuiet();
          }
        } else if (step.kind === "star") {
          this.score += 1;
          this.io.sendJson({ type: "score", score: this.score });
          if (this.card) this.io.onStar(this.card.word, this.score);
        }
      }
      this.heard = "";
      this.interim = ""; this.nudged = false;   // our speech staled it
      if (said) { this.lastSpeech = said; this.lastCard = this.card?.word ?? null; }
      this.lastUs = Date.now();
      this.muteUntil = Date.now() + ECHO_TAIL_MS;
    } finally {
      this.busy = false;
    }
  }

  private show(word: string): void {
    word = (word ?? "").trim();
    // No picture repeats until the deck is exhausted — the model sometimes
    // picks a card it already showed; whether one is left is computable.
    if (this.seen.has(word) && word !== this.card?.word
        && this.deck.some((w) => !this.seen.has(w.word))) {
      word = this.unseen();
    }
    const found = this.deck.find((w) => w.word.toLowerCase() === word.toLowerCase());
    if (!found) return;                       // it invented one; keep the picture
    this.card = found;
    this.tries = 0;
    // A new card is a fresh question — without this, the LAST card's verdict
    // stayed true and ensureTurn kept paying stars for silence.
    this.verdict = null;
    this.seen.add(found.word);
    this.chatter.warm(found.word);            // its lines are ready before needed
    this.io.sendJson({ type: "card", emoji: found.emoji, word: found.word,
                       score: this.score });
  }

  private unseen(): string {
    let left = this.deck.filter((w) => !this.seen.has(w.word)).map((w) => w.word);
    if (!left.length) {
      this.seen = new Set(this.card ? [this.card.word] : []);
      left = this.deck.map((w) => w.word).filter((w) => w !== this.card?.word);
    }
    return left[Math.floor(Math.random() * left.length)]!;
  }

  // ── ears in ────────────────────────────────────────────────────────────

  private onPartial(text: string): void {
    if (this.deaf() || !text.trim()) return;  // trap 2: never hear ourselves
    this.talking = true;
    this.lastVoice = Date.now();
    if (text.trim() !== this.interim) {
      this.interim = text.trim();
      this.interimAt = this.lastVoice;
      this.nudged = false;
    }
    this.io.sendJson({ type: "hearing", text });
  }

  private async onFinal(text: string): Promise<void> {
    if (this.deaf() || !text.trim()) return;
    const [judgedText, when] = this.judged;
    if (judgedText && norm(text) === judgedText && Date.now() - when < 2000) {
      return;        // the recogniser settled on what we already judged
    }
    this.interim = ""; this.nudged = false;
    this.heard = text.trim();
    this.verdict = this.card
      ? heardIt(this.heard, this.card.word, this.card.also ?? [],
                this.deck.map((w) => w.word))
      : null;
    this.talking = false;
    this.lastVoice = Date.now();
    this.tries += 1;
    this.io.sendJson({ type: "said", text: this.heard, ok: this.verdict });
    if (this.verdict && !this.thinking) {
      // A right answer is rewarded NOW. No tick, no quiet gate, no model: the
      // reward is code's job, and a late one is what makes a child give up.
      this.thinking = true;
      void this.celebrate();
    }
  }

  // ── the tick: the persona only ever acts into a silence ───────────────

  private async tick(): Promise<void> {
    if (this.closed || this.thinking || this.deaf()) return;
    const now = Date.now();

    // Trap 5: a toddler says one syllable and stops; the recogniser waits for
    // more speech that never comes. Nudge a flush, then judge the grey text.
    if (this.interim) {
      const stuck = (now - this.interimAt) / 1000;
      if (stuck > JUDGE_INTERIM_S) {
        const text = this.interim;
        this.interim = "";
        await this.onFinal(text);
        this.judged = [norm(text), Date.now()];   // drop its echo, once
        return;
      }
      if (stuck > FLUSH_NUDGE_S && !this.nudged) {
        this.nudged = true;
        this.ears.finalize();
      }
    }

    const quiet = (now - this.lastVoice) / 1000;
    const sinceUs = this.lastUs ? (now - this.lastUs) / 1000 : 99;
    if (this.talking && quiet < MIN_QUIET_S) return;
    if (this.heard && quiet > 12) this.heard = "";  // too old to still be answering
    const worth = this.heard || this.card === null || quiet >= NUDGE_AFTER_S;
    // A settled answer already waited out endpointing; no second silence gate.
    const needQuiet = this.heard ? HEARD_QUIET_S : MIN_QUIET_S;
    if (!worth || quiet < needQuiet || sinceUs < MIN_SINCE_US_S) return;

    this.thinking = true;
    try { await this.ask(quiet, sinceUs); }
    finally { this.thinking = false; }
  }

  // ── code-owned guarantees ──────────────────────────────────────────────

  /** A right answer always earns the star AND the next picture. The persona
   *  decides how to celebrate; it never decides whether. */
  private ensureTurn(script: Step[]): Step[] {
    if (!this.verdict) return script;
    if (!script.some((s) => s.kind === "star")) script.push({ kind: "star", val: "" });
    if (!script.some((s) => s.kind === "sound")) script.unshift({ kind: "sound", val: "confetti" });
    if (!script.some((s) => s.kind === "card")) script.push({ kind: "card", val: this.unseen() });
    return script;
  }

  /** The card's word in OUR mouth before she has said it hands her the answer
   *  ("Hop, at!" was asked about the horse card). Computed, like the verdict:
   *  saying it is legitimate once she got it, or after three tries. */
  private leaksAnswer(text: string): boolean {
    if (!this.card || this.verdict || this.tries >= 3) return false;
    const toks = new Set(norm(text).split(/\s+/));
    return norm(this.card.word).split(/\s+/).some((t) => toks.has(t));
  }

  /** Confetti, a prepared line, the star, the next picture — straight from
   *  the transcript. The persona never sits on this path. */
  private async celebrate(): Promise<void> {
    try {
      const word = this.card!.word;
      const next = this.unseen();
      const script: Step[] = [
        { kind: "sound", val: "confetti" },
        { kind: "say", val: this.chatter.line("yes", word) },
        { kind: "star", val: "" },
        { kind: "card", val: next },
        { kind: "say", val: this.chatter.line("ask", next) },
      ];
      this.lastSaid = script.filter((s) => s.kind === "say").map((s) => s.val).join(" ");
      this.io.log(`[celebrate] ${this.lastSaid}`);
      await this.perform(script);
    } catch (e) {
      this.io.log(`celebrate: ${String(e)}`);
    } finally {
      this.thinking = false;
    }
  }

  /** The model is slow, down, or switched off. The game does not wait: a
   *  prepared or canned line goes out now, guarantees intact. */
  private async fallback(): Promise<void> {
    if (!this.card) {
      this.show(this.unseen());
      await this.perform([{ kind: "say", val: this.chatter.line("ask", this.card!.word) }]);
      return;
    }
    let script: Step[];
    if (this.verdict) {
      script = this.ensureTurn([{ kind: "say", val: this.chatter.line("yes", this.card.word) }]);
      const next = script.find((s) => s.kind === "card")?.val;
      if (next) script.push({ kind: "say", val: this.chatter.line("ask", next) });
    } else if (this.heard) {
      script = [{ kind: "say", val: this.chatter.line("again", this.card.word) }];
    } else {
      script = [{ kind: "say", val: this.chatter.line("ask", this.card.word) }];
    }
    this.lastSaid = script.filter((s) => s.kind === "say").map((s) => s.val).join(" ");
    this.io.log(`[fallback] ${this.lastSaid}`);
    await this.perform(script);
  }

  // ── the ask: one question to the persona, with every exit guarded ─────

  private async ask(quietS: number, sinceUs: number): Promise<void> {
    if (!this.brain) { await this.fallback(); return; }
    const state = stateText(this.lang, {
      card: this.card, score: this.score, heard: this.heard,
      talking: this.talking, quietS, sinceUs, tries: this.tries,
      seen: this.seen, deck: this.deck, lastSaid: this.lastSaid,
      verdict: this.verdict,
    });

    // Speak the first clause while the rest is still being written — the
    // biggest latency win in the game — and give the model FIRST_SOUND_S to
    // produce it; after that a prepared or canned line goes out instead.
    const say = new SayStream();
    let out = "", started = false, spokenUpto = 0;
    let headDone: Promise<void> = Promise.resolve();
    const deadline = Date.now() + FIRST_SOUND_S * 1000;
    try {
      const stream = this.brain.stream(state, system(this.lang));
      for (;;) {
        let piece: string;
        if (started) {
          const n = await stream.next();
          if (n.done) break;
          piece = n.value;
        } else {
          const left = Math.max(50, deadline - Date.now());
          const n = await Promise.race([
            stream.next(),
            new Promise<"timeout">((r) => setTimeout(() => r("timeout"), left)),
          ]);
          if (n === "timeout") {
            void stream.return?.(undefined);
            this.io.log("[fallback] model too slow");
            await this.fallback();
            return;
          }
          if (n.done) break;
          piece = n.value;
        }
        out += piece;
        say.feed(piece);
        if (started) continue;
        const cut = firstClause(say.text);
        if (cut !== null && !isNarration(say.text.slice(0, cut))
            && !this.leaksAnswer(say.text.slice(0, cut))) {
          const [head] = parse(say.text.slice(0, cut));
          if (head.some((s) => s.kind === "say")
              && !head.some((s) => s.kind === "star" || s.kind === "card")) {
            started = true;
            spokenUpto = cut;
            headDone = this.perform(head);
          }
        }
      }
    } catch (e) {
      this.io.log(`persona: ${String(e)}`);
      await this.fallback();
      return;
    }

    const [think, unwrapped] = unwrap(out.trim());
    let line = say.text ? say.text.trim() : unwrapped;
    if (think) this.io.log(`[think] ${think}`);

    if (started) {
      // The head is already out loud; the rest gets the same vetting word by
      // word — narration and the card's word are dropped, marks survive, and
      // ensureTurn keeps every code-owned guarantee.
      await headDone;
      const rest = say.text.slice(spokenUpto).trim();
      let [script] = parse(rest);
      script = script.filter((s) => s.kind !== "say"
        || (!isNarration(s.val) && !this.leaksAnswer(s.val)));
      script = this.ensureTurn(script);
      this.io.log(`[persona] ${line}`);
      this.lastSaid = line;
      if (script.length) await this.perform(script);
      return;
    }

    if (isNarration(line) && !line.toUpperCase().startsWith("PASS")) {
      // It described the room instead of talking to her. Say nothing —
      // unless she just spoke: a canned answer beats being ignored.
      this.io.log(`[narration dropped] ${line}`);
      if (this.heard) await this.fallback();
      return;
    }
    let [script, passed] = parse(line);
    script = script.filter((s) => s.kind !== "say" || !this.leaksAnswer(s.val));
    const says = norm(script.filter((s) => s.kind === "say").map((s) => s.val).join(" "));
    if (says && says === this.lastSpeech && !this.heard
        && this.card?.word === this.lastCard) {
      // "Hop, at!" four times in a row teaches her to stop listening. Same
      // words, same card, nothing new from her: vary it ourselves.
      this.io.log(`[repeat dropped] ${line}`);
      await this.fallback();
      return;
    }
    const saidSomething = !!this.heard;
    if (passed || !script.length) {
      // Silence is a fine answer to silence. It is NOT a fine answer to a
      // child who just spoke. Ask once more, saying so; then canned.
      if (saidSomething) {
        line = await this.retry(state);
        if (isNarration(line)) line = "";
        [script, passed] = parse(line);
        script = script.filter((s) => s.kind !== "say" || !this.leaksAnswer(s.val));
      }
      if (passed || !script.length) {
        if (saidSomething) await this.fallback();   // she will not be ignored twice
        return;
      }
    }
    if (!script.some((s) => s.kind === "say")) {
      // A card flipping over in silence reads as a glitch, not a turn.
      if (this.verdict || this.heard) await this.fallback();
      return;
    }
    script = this.ensureTurn(script);
    this.io.log(`[persona] ${line}`);
    this.lastSaid = line;
    await this.perform(script);
  }

  private async retry(state: string): Promise<string> {
    const nudge = this.lang === "ru"
      ? "Ребёнок только что говорил. Ответь ему — PASS сейчас нельзя."
      : this.lang === "en"
        ? "The child just spoke. Answer them — PASS is not allowed right now."
        : "Çocuk az önce konuştu. Ona cevap ver — şimdi PASS olmaz.";
    try {
      let out = "";
      for await (const p of this.brain!.stream(state + "\n\n" + nudge, system(this.lang))) out += p;
      return unwrap(out.trim())[1];
    } catch { return ""; }
  }
}
