/* Keyword hints are MODEL-SPECIFIC: `keyterm` on nova-3, `keywords` on nova-2.
 * The wrong one is an HTTP 400, the socket never opens, and the game is
 * silently deaf (trap 10). The pairing is checked without opening a socket. */
import { afterEach, describe, expect, it, vi } from "vitest";

async function urlFor(model: string | undefined, hints: string[]): Promise<string> {
  vi.resetModules();
  if (model) process.env.STT_MODEL = model; else delete process.env.STT_MODEL;
  const { Ears } = await import("../src/ears.js");
  return new Ears("tr", hints, () => {}, () => {}).url();
}

afterEach(() => { delete process.env.STT_MODEL; });

describe("Ears url", () => {
  it("defaults to nova-3 with keyterm hints (never keywords)", async () => {
    const u = await urlFor(undefined, ["kedi", "köpek"]);
    expect(u).toContain("model=nova-3");
    expect(u).toContain("keyterm=kedi");
    expect(u).toContain("keyterm=k%C3%B6pek");
    expect(u).not.toContain("keywords=");
  });

  it("nova-2 gets boosted keywords, never keyterm", async () => {
    const u = await urlFor("nova-2", ["kedi"]);
    expect(u).toContain("keywords=kedi:2");
    expect(u).not.toContain("keyterm=");
  });

  it("an unknown model gets no hints at all rather than a 400", async () => {
    const u = await urlFor("some-future-model", ["kedi"]);
    expect(u).not.toContain("keyterm=");
    expect(u).not.toContain("keywords=");
  });

  it("asks for interim results and a short endpoint", async () => {
    const u = await urlFor(undefined, []);
    expect(u).toContain("interim_results=true");
    expect(u).toMatch(/endpointing=\d{2,3}\b/);
  });
});
