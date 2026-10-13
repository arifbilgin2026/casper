/* The mouth: ElevenLabs speech plus the generated chimes, through one pipe.
 *
 * The browser schedules whatever binary frames arrive gaplessly, so the
 * server's only real job here is ACCOUNTING: knowing when its own sound will
 * stop coming out of the family's speaker. Everything the game gates on —
 * "never act while we are talking", the echo tail that keeps the ears from
 * hearing the agent — hangs off that one estimate, which is why it lives in
 * one place. 24 kHz mono PCM16 = 48,000 bytes per second; the math is the
 * byte count.
 */

const RATE_BYTES_PER_S = 24000 * 2;

export class Mouth {
  private until = 0;            // epoch ms when everything sent has played out

  constructor(
    private send: (pcm: Buffer) => void,      // one frame toward the browser
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

  /** Speak one line. Audio is forwarded the moment each chunk arrives from
   *  the synthesiser; the promise resolves when the last chunk is SENT (not
   *  played — callers wait on `speaking` with a ceiling, as the game does). */
  async say(text: string): Promise<void> {
    const key = process.env.ELEVENLABS_API_KEY ?? "";
    if (!key || !text.trim()) return;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voice}/stream`
      + "?output_format=pcm_24000&optimize_streaming_latency=3";
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text, model_id: "eleven_turbo_v2_5", language_code: this.lang,
        voice_settings: { speed: 0.95 },
      }),
    });
    if (!res.ok || !res.body) {
      console.log(`[mouth] tts ${res.status}: ${(await res.text()).slice(0, 120)}`);
      return;
    }
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      this.account(buf.length);
      this.send(buf);
    }
  }

  /** Play an already-made PCM buffer (the chimes) through the same pipe and
   *  the same accounting, so a chime blocks the tick exactly like a word. */
  playPcm(pcm: Buffer): void {
    this.account(pcm.length);
    this.send(pcm);
  }

  /** Resolve when our sound has stopped, with a ceiling so it can never hang. */
  async waitQuiet(ceilingMs = 10000): Promise<void> {
    const deadline = Date.now() + ceilingMs;
    while (this.speaking && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
