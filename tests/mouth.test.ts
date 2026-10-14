/* The mouth must only ever emit whole PCM16 samples. The synthesiser's HTTP
 * stream splits on arbitrary byte boundaries; forwarding an odd-length chunk
 * shifted every later sample by one byte — a word turned to static
 * mid-syllable. Also: a repeated line is synthesised once. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mouth } from "../src/mouth.js";

function streamOf(chunks: Buffer[]): Response {
  return new Response(new ReadableStream({
    start(c) { chunks.forEach((b) => c.enqueue(new Uint8Array(b))); c.close(); },
  }), { status: 200 });
}

afterEach(() => { vi.unstubAllGlobals(); delete process.env.ELEVENLABS_API_KEY; });

describe("Mouth", () => {
  it("emits only sample-aligned frames, whatever the chunking, losing no audio", async () => {
    process.env.ELEVENLABS_API_KEY = "test";
    const audio = Buffer.alloc(20000, 7);
    // cut at deliberately awkward (odd) boundaries
    const cuts = [1, 4999, 5000, 5001, 9001, 13333, 20000];
    const chunks: Buffer[] = [];
    let prev = 0;
    for (const c of cuts) { chunks.push(audio.subarray(prev, c)); prev = c; }
    vi.stubGlobal("fetch", vi.fn(async () => streamOf(chunks)));

    const frames: Buffer[] = [];
    const mouth = new Mouth((f) => frames.push(f), "voice", "tr");
    await mouth.say("hello");

    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.length % 2, "odd-length frame").toBe(0);
    expect(frames.reduce((n, f) => n + f.length, 0)).toBe(20000);
  });

  it("pads a dangling final byte instead of shifting or dropping it", async () => {
    process.env.ELEVENLABS_API_KEY = "test";
    vi.stubGlobal("fetch", vi.fn(async () => streamOf([Buffer.alloc(3001, 1)])));
    const frames: Buffer[] = [];
    await new Mouth((f) => frames.push(f), "v", "tr").say("x");
    expect(frames.every((f) => f.length % 2 === 0)).toBe(true);
  });

  it("synthesises a repeated line once (cries and canned lines are free the second time)", async () => {
    process.env.ELEVENLABS_API_KEY = "test";
    const fetchMock = vi.fn(async () => streamOf([Buffer.alloc(4000, 1)]));
    vi.stubGlobal("fetch", fetchMock);
    const mouth = new Mouth(() => {}, "v", "tr");
    await mouth.say("miyav miyav!");
    await mouth.say("miyav miyav!");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accounts for the audio it sent: speaking is true until it has played out", async () => {
    process.env.ELEVENLABS_API_KEY = "test";
    vi.stubGlobal("fetch", vi.fn(async () => streamOf([Buffer.alloc(48000, 1)]))); // 1 s
    const mouth = new Mouth(() => {}, "v", "tr");
    await mouth.say("one second");
    expect(mouth.speaking).toBe(true);
  });
});
