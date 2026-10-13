/* The ears: a live Deepgram socket.
 *
 * 16 kHz mono PCM16 goes in; interim and final transcripts come back through
 * two callbacks. Three details carry the whole toddler experience:
 *
 *   - endpointing is 250 ms, because a toddler says one syllable and stops —
 *     the default would wait for speech that never comes;
 *   - finalize() asks Deepgram to settle the current buffer NOW, used by the
 *     game's flush nudge when an interim has been stuck for 0.6 s;
 *   - keyword hints are deliberately NOT sent: they are model-specific
 *     (`keyterm` on nova-3, `keywords` before it) and the wrong one is an
 *     HTTP 400 and a game that is silently deaf.
 */
import WebSocket from "ws";

export class Ears {
  private ws: WebSocket | null = null;
  private alive = false;
  private keep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private lang: string,
    private onPartial: (text: string) => void,
    private onFinal: (text: string) => void,
  ) {}

  async start(): Promise<void> {
    const key = process.env.DEEPGRAM_API_KEY ?? "";
    if (!key) throw new Error("no Deepgram key: set DEEPGRAM_API_KEY");
    const url = "wss://api.deepgram.com/v1/listen"
      + "?model=nova-2&encoding=linear16&sample_rate=16000&channels=1"
      + `&language=${this.lang}&interim_results=true&endpointing=250&punctuate=true`;
    this.ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
    await new Promise<void>((ok, bad) => {
      this.ws!.once("open", () => ok());
      this.ws!.once("error", bad);
    });
    this.alive = true;
    this.ws.on("message", (raw) => {
      let m: { channel?: { alternatives?: { transcript?: string }[] }; is_final?: boolean };
      try { m = JSON.parse(String(raw)); } catch { return; }
      const text = m.channel?.alternatives?.[0]?.transcript ?? "";
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
