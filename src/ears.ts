/* The ears: a live Deepgram socket.
 *
 * 16 kHz mono PCM16 goes in; interim and final transcripts come back through
 * two callbacks. What the settings are, and why (all measured with
 * scripts/stt-bench.ts against a quiet, toddler-level voice — see README):
 *
 *   - nova-3, not nova-2. On quiet short words nova-2 understood 16 of 31;
 *     nova-3 with keyterms understood 27. A toddler is quiet and far from
 *     the microphone, so this is the difference between "she said it" and
 *     "the game never heard her".
 *   - the deck's words are sent as keyterms, biasing the recogniser toward
 *     the ~66 words this game can possibly be about. Keyword hints are
 *     MODEL-SPECIFIC (`keyterm` on nova-3, `keywords` on nova-2): the wrong
 *     one is an HTTP 400, the socket never opens, and the game is silently
 *     deaf — hence the explicit guard below.
 *   - endpointing 180 ms: a toddler says one syllable and stops, so the
 *     default wait for speech that never comes is wasted; much shorter and a
 *     hesitating "ke… di" gets cut in two.
 *   - finalize() asks Deepgram to settle the current buffer NOW, used by the
 *     game's flush nudge when an interim has been stuck for 0.6 s.
 */
import WebSocket from "ws";

const MODEL = process.env.STT_MODEL ?? "nova-3";
const ENDPOINTING_MS = Number(process.env.STT_ENDPOINTING_MS ?? 180);

export class Ears {
  private ws: WebSocket | null = null;
  private alive = false;
  private keep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private lang: string,
    private hints: string[],
    private onPartial: (text: string) => void,
    private onFinal: (text: string) => void,
    private trace: (line: string) => void = () => {},
  ) {}

  /** The query string; exported shape-wise via a method so tests can check
   *  the model/hint pairing without opening a socket. */
  url(): string {
    let u = "wss://api.deepgram.com/v1/listen"
      + `?model=${MODEL}&encoding=linear16&sample_rate=16000&channels=1`
      + `&language=${this.lang}&interim_results=true&endpointing=${ENDPOINTING_MS}`;
    const hint = (param: string, suffix = "") =>
      this.hints.slice(0, 80).map((w) => `&${param}=${encodeURIComponent(w)}${suffix}`).join("");
    if (MODEL.startsWith("nova-3")) u += hint("keyterm");
    else if (MODEL.startsWith("nova-2")) u += hint("keywords", ":2");
    return u;
  }

  async start(): Promise<void> {
    const key = process.env.DEEPGRAM_API_KEY ?? "";
    if (!key) throw new Error("no Deepgram key: set DEEPGRAM_API_KEY");
    this.ws = new WebSocket(this.url(), { headers: { Authorization: `Token ${key}` } });
    await new Promise<void>((ok, bad) => {
      this.ws!.once("open", () => ok());
      this.ws!.once("error", bad);
    });
    this.alive = true;
    this.ws.on("message", (raw) => {
      let m: { channel?: { alternatives?: { transcript?: string }[] }; is_final?: boolean;
               speech_final?: boolean; start?: number; duration?: number };
      try { m = JSON.parse(String(raw)); } catch { return; }
      const text = m.channel?.alternatives?.[0]?.transcript ?? "";
      if (process.env.STT_TRACE === "1" && text.trim()) {
        this.trace(`[dg] ${m.is_final ? "final" : "interim"}${m.speech_final ? "+speech_final" : ""}`
          + ` "${text}" audio ${m.start?.toFixed(2)}s+${m.duration?.toFixed(2)}s`);
      }
      if (!text.trim()) return;
      if (m.is_final) this.onFinal(text); else this.onPartial(text);
    });
    this.ws.on("close", () => { this.alive = false; });
    // Deepgram drops a socket that goes quiet; the child thinking IS quiet.
    this.keep = setInterval(() => {
      if (this.alive) this.ws?.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5000);
  }

  feed(pcm: Buffer): void {
    if (this.alive && this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
  }

  /** Settle the current buffer immediately instead of waiting out endpointing. */
  finalize(): void {
    if (this.alive) this.ws?.send(JSON.stringify({ type: "Finalize" }));
  }

  close(): void {
    if (this.keep) clearInterval(this.keep);
    try { this.ws?.close(); } catch { /* already gone */ }
    this.alive = false;
  }
}
