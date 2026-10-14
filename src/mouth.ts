/* The mouth: ElevenLabs speech plus the generated chimes, through one pipe.
 *
 * The browser schedules whatever binary frames arrive gaplessly, so the
 * server's real jobs are (1) ACCOUNTING — knowing when its own sound will
 * stop coming out of the family's speaker, because everything the game gates
 * on ("never act while we are talking", the echo tail that keeps the ears
 * from hearing the agent) hangs off that one estimate — and (2) LATENCY: a
 * child should never wait for a voice that could have been fetched earlier.
 *
 * That second job is why speech is split into prepare() and play():
 *
 *   prepare(text)  starts the synthesis NOW and returns a Take — frames
 *                  accumulate in it as they arrive. Called for every line a
 *                  script will say before the script starts, so the requests
 *                  run while the confetti chime is still sounding.
 *   play(take)     forwards a Take's frames as they become available — from
 *                  memory if the synthesis already finished, streaming if not.
 *
 * Takes are memoised by (voice, text) for the life of the PROCESS, shared by
 * every family: the second time anyone needs a card's animal cry or a canned
 * line it costs nothing at all, and warm() fills the cache in the background.
 *
 * 24 kHz mono PCM16 = 48,000 bytes per second; the accounting is byte count.
 */

const RATE_BYTES_PER_S = 24000 * 2;
const MIN_BATCH = 2400;          // bytes (50 ms) — after the first chunk
const CACHE_LIMIT = 600;
const SHARED = new Map<string, Take>();    // (voice|text) → synthesis, process-wide

/** One synthesis: sample-aligned frames, arriving over time. */
export class Take {
  readonly frames: Buffer[] = [];
  done = false;
  /** Resolves when synthesis has ended (successfully or not). */
  readonly finished: Promise<void>;
  private end!: () => void;
  private wake: (() => void)[] = [];

  constructor() { this.finished = new Promise<void>((r) => { this.end = r; }); }

  push(b: Buffer): void { this.frames.push(b); this.notify(); }
  finish(): void { this.done = true; this.end(); this.notify(); }
  private notify(): void { const w = this.wake; this.wake = []; w.forEach((f) => f()); }

  async *iterate(): AsyncGenerator<Buffer> {
    for (let i = 0; ; ) {
      while (i < this.frames.length) yield this.frames[i++]!;
      if (this.done) return;
      await new Promise<void>((r) => this.wake.push(r));
    }
  }
}

export class Mouth {
  private until = 0;                       // epoch ms when all sent audio has played out

  constructor(
    private send: (pcm: Buffer) => void,   // one frame toward the browser
    private voice: string,
    private lang: string,
  ) {}

  get speaking(): boolean {
    return Date.now() < this.until;
  }

  private account(bytes: number): void {
    const start = Math.max(Date.now(), this.until);
    this.until = start + (bytes / RATE_BYTES_PER_S) * 1000;
  }

  /** Start synthesising `text` now (or return the one already started). */
  prepare(text: string): Take {
    const clean = text.trim();
    const key = `${this.voice}|${clean}`;
    const hit = SHARED.get(key);
    if (hit) return hit;
    const take = new Take();
    SHARED.set(key, take);
    if (SHARED.size > CACHE_LIMIT) SHARED.delete(SHARED.keys().next().value as string);
    void this.synthesise(clean, take, key);
    return take;
  }

  /** Fill the cache in the background, a few requests at a time (the voice
   *  service limits concurrent requests; a stampede would only get 429s). */
  async warm(texts: string[], concurrency = 3): Promise<void> {
    const queue = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
    const worker = async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
        await this.prepare(t).finished;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  private async synthesise(text: string, take: Take, cacheKey: string): Promise<void> {
    const key = process.env.ELEVENLABS_API_KEY ?? "";
    try {
      if (!key || !text) return;
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voice}/stream?output_format=pcm_24000`, {
          method: "POST",
          headers: { "xi-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({
            text, model_id: process.env.TTS_MODEL ?? "eleven_turbo_v2_5",
            language_code: this.lang, voice_settings: { speed: 0.95 },
          }),
        });
      if (!res.ok || !res.body) {
        console.log(`[mouth] tts ${res.status}: ${(await res.text()).slice(0, 120)}`);
        return;
      }
      // The HTTP stream splits on arbitrary BYTE boundaries, but a PCM16
      // sample is two bytes: forward an odd-length chunk and the browser
      // decodes everything after the split one byte off — a word turns to
      // static mid-syllable. Carry the remainder, emit only sample-aligned
      // frames; the FIRST goes out at once (latency), later ones batch to
      // 50 ms so the browser isn't scheduling confetti-sized buffers.
      let pending = Buffer.alloc(0), first = true;
      for await (const chunk of res.body) {
        pending = pending.length ? Buffer.concat([pending, Buffer.from(chunk)]) : Buffer.from(chunk);
        const aligned = pending.length - (pending.length % 2);
        if (aligned >= (first ? 2 : MIN_BATCH)) {
          take.push(pending.subarray(0, aligned));
          pending = Buffer.from(pending.subarray(aligned));
          first = false;
        }
      }
      if (pending.length) {                // the tail, padded to a whole sample
        take.push(pending.length % 2 ? Buffer.concat([pending, Buffer.from([0])]) : pending);
      }
    } catch (e) {
      console.log(`[mouth] tts failed: ${String(e).slice(0, 120)}`);
    } finally {
      take.finish();
      // A failed or empty synthesis must not poison the cache for later.
      if (!take.frames.length) SHARED.delete(cacheKey);
    }
  }

  /** Forward a Take's audio as it becomes available. `onFirst` fires when the
   *  first frame leaves for the browser (latency tracing). */
  async play(take: Take, onFirst?: () => void): Promise<void> {
    let first = true;
    for await (const frame of take.iterate()) {
      this.account(frame.length);
      this.send(frame);
      if (first) { first = false; onFirst?.(); }
    }
  }

  async say(text: string, onFirst?: () => void): Promise<void> {
    if (text.trim()) await this.play(this.prepare(text), onFirst);
  }

  /** Play an already-made PCM buffer (the chimes) through the same pipe and
   *  the same accounting, so a chime blocks the tick exactly like a word. */
  playPcm(pcm: Buffer, onFirst?: () => void): void {
    this.account(pcm.length);
    this.send(pcm);
    onFirst?.();
  }

  /** Resolve when our sound has stopped, with a ceiling so it can never hang. */
  async waitQuiet(ceilingMs = 10000): Promise<void> {
    const deadline = Date.now() + ceilingMs;
    while (this.speaking && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
