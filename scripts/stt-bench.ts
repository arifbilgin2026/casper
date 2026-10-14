/* STT bench: the scripted child.
 *
 * Synthesises the deck's short words, plays them at a Deepgram socket in REAL
 * TIME the way the browser does (85 ms chunks, room noise before and after,
 * the mic never stops), and reports per variant:
 *
 *   - accuracy: would the game have credited the word? (the real heardIt)
 *   - lag: milliseconds after the word ENDS until the first interim that
 *     already contains it, and until the first final
 *
 * so model, endpointing and keyterm choices are decided by numbers instead of
 * by feel. The speaker is an adult TTS voice, so absolute accuracy is kinder
 * than a real toddler's; the comparison between variants is what to trust.
 *
 *   DEEPGRAM_API_KEY=… ELEVENLABS_API_KEY=… npx tsx scripts/stt-bench.ts [--gain 0.15] [--lang en]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { heardIt } from "../src/match.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1]! : d;
};
const GAIN = Number(arg("gain", "1"));
const ONLY = arg("lang", "");
const CHUNK_MS = Number(arg("chunk", "85"));        // what the browser sends per message
const PICK = arg("variants", "");                   // e.g. "CD" to run only those
const CACHE = path.join(HERE, "..", ".bench-cache");
mkdirSync(CACHE, { recursive: true });

const DG = process.env.DEEPGRAM_API_KEY ?? "";
const EL = process.env.ELEVENLABS_API_KEY ?? "";
if (!DG || !EL) throw new Error("set DEEPGRAM_API_KEY and ELEVENLABS_API_KEY");

type Lang = "tr" | "ru" | "en";
interface Card { word: string; also?: string[] }
const VOICES: Record<Lang, string> = {
  tr: "Et3hA9mm8aHhswBL5jmC", ru: "GN4wbsbejSnGSa1AzjH5", en: "21m00Tcm4TlvDq8ikWAM",
};
const deck = (l: Lang) => (JSON.parse(readFileSync(
  path.join(HERE, "..", "decks", `words_${l}.json`), "utf8")) as { words: Card[] }).words;

// What is spoken, and the card it is MEANT for. The normal set is the short,
// confusable real words; --set baby speaks the simplified forms a toddler
// produces (r→w, k→t, final consonant dropped…) to see what the recogniser
// makes of non-words.
interface Case { say: string; card: string }
const same = (...w: string[]): Case[] => w.map((x) => ({ say: x, card: x }));
const SETS: Record<string, Record<Lang, Case[]>> = {
  real: {
    tr: same("at", "ay", "fil", "muz", "kedi", "ev", "top", "süt", "deve", "kuş", "inek", "balık"),
    ru: same("дом", "кит", "лев", "сыр", "мяч", "лиса", "слон", "утка"),
    en: same("cat", "dog", "cow", "pig", "bee", "car", "sun", "ball", "duck", "horse", "bear"),
  },
  baby: {
    tr: [["tedi", "kedi"], ["pil", "fil"], ["balı", "balık"], ["köpe", "köpek"], ["ema", "elma"],
         ["aba", "araba"], ["kuş", "kuş"], ["tavşa", "tavşan"], ["uçak", "uçak"]]
        .map(([say, card]) => ({ say: say!, card: card! })),
    ru: [["кока", "кошка"], ["бака", "собака"], ["лоша", "лошадь"], ["мако", "молоко"],
         ["тица", "птица"], ["мяч", "мяч"], ["ябоко", "яблоко"]]
        .map(([say, card]) => ({ say: say!, card: card! })),
    en: [["tat", "cat"], ["dod", "dog"], ["fwog", "frog"], ["wabbit", "rabbit"], ["baw", "ball"],
         ["bea", "bear"], ["nana", "banana"], ["hoss", "horse"], ["guck", "duck"]]
        .map(([say, card]) => ({ say: say!, card: card! })),
  },
};
const babble = (card: string): Case[] =>
  ["ba ba ba", "da da", "mmm", "aaah", "uh oh", "ma ma", "gagaga", "brrr", "eee", "ooh"]
    .map((say) => ({ say, card }));
SETS.babble = { tr: babble("kedi"), ru: babble("кошка"), en: babble("cat") };
const SET = SETS[arg("set", "real")]!;
const TOL = arg("tol", "off") as "off" | "normal" | "high";

interface Variant {
  name: string; model: string; endpointing: number;
  keyterms?: boolean; keywords?: boolean; extra?: string;
}
const ALL_VARIANTS: Variant[] = [
  { name: "P nova-3 ep180 +keyterms (now)", model: "nova-3", endpointing: 180, keyterms: true },
  { name: "H nova-3 ep180 +keyterms +filler_words", model: "nova-3", endpointing: 180, keyterms: true, extra: "&filler_words=true" },
  { name: "F  … +alternatives=3 (any matches)", model: "nova-3", endpointing: 180, keyterms: true, extra: "&alternatives=3" },
  { name: "G  … +alternatives +filler_words", model: "nova-3", endpointing: 180, keyterms: true, extra: "&alternatives=3&filler_words=true" },
  { name: "A nova-2 ep250 (current)", model: "nova-2", endpointing: 250 },
  { name: "B nova-3 ep250", model: "nova-3", endpointing: 250 },
  { name: "C nova-3 ep250 +keyterms", model: "nova-3", endpointing: 250, keyterms: true },
  { name: "D nova-3 ep120 +keyterms", model: "nova-3", endpointing: 120, keyterms: true },
  { name: "E nova-2 ep250 +keywords", model: "nova-2", endpointing: 250, keywords: true },
];
const VARIANTS = PICK ? ALL_VARIANTS.filter((v) => PICK.includes(v.name[0]!)) : ALL_VARIANTS;

// ── audio ────────────────────────────────────────────────────────────────

async function synth(lang: Lang, word: string): Promise<Buffer> {
  const f = path.join(CACHE, `${lang}-${Buffer.from(word).toString("hex")}.pcm`);
  if (existsSync(f)) return readFileSync(f);
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICES[lang]}?output_format=pcm_16000`, {
      method: "POST",
      headers: { "xi-api-key": EL, "content-type": "application/json" },
      body: JSON.stringify({ text: word, model_id: "eleven_turbo_v2_5", language_code: lang }),
    });
  if (!r.ok) throw new Error(`tts ${r.status} for ${word}: ${await r.text()}`);
  const b = Buffer.from(await r.arrayBuffer());
  writeFileSync(f, b);
  return b;
}

/** Where the word actually starts/ends inside the clip (TTS pads silence). */
function speechSpan(pcm: Buffer): [startMs: number, endMs: number] {
  const win = 160;                                   // 10 ms @ 16 kHz
  const rms: number[] = [];
  for (let i = 0; i + win <= pcm.length / 2; i += win) {
    let s = 0;
    for (let j = 0; j < win; j++) { const v = pcm.readInt16LE((i + j) * 2); s += v * v; }
    rms.push(Math.sqrt(s / win));
  }
  const peak = Math.max(...rms), thr = peak * 0.1;
  const first = rms.findIndex((r) => r > thr);
  const last = rms.length - 1 - [...rms].reverse().findIndex((r) => r > thr);
  return [first * 10, (last + 1) * 10];
}

/** Room noise ≈ −47 dBFS, so silence is never digital zero (a real mic's isn't). */
function noise(ms: number): Buffer {
  const n = Math.floor(16 * ms), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round((Math.random() - 0.5) * 260), i * 2);
  return b;
}

function scene(word: Buffer): { pcm: Buffer; leadMs: number } {
  const g = Buffer.alloc(word.length);
  for (let i = 0; i < word.length / 2; i++) {
    const v = Math.round(word.readInt16LE(i * 2) * GAIN + (Math.random() - 0.5) * 260);
    g.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  const leadMs = 600;
  return { pcm: Buffer.concat([noise(leadMs), g, noise(2200)]), leadMs };
}

// ── one run: one word, one variant, real time ────────────────────────────

interface Result { heard: string; ok: boolean; interimLag: number | null; finalLag: number | null; err?: string }

function url(v: Variant, lang: Lang): string {
  let u = `wss://api.deepgram.com/v1/listen?model=${v.model}&encoding=linear16`
    + `&sample_rate=16000&channels=1&language=${lang}&interim_results=true`
    + `&endpointing=${v.endpointing}&punctuate=true`;
  const words = deck(lang).map((w) => w.word);
  if (v.keyterms) u += words.map((w) => `&keyterm=${encodeURIComponent(w)}`).join("");
  if (v.extra) u += v.extra;
  if (v.keywords) u += words.map((w) => `&keywords=${encodeURIComponent(w)}:2`).join("");
  return u;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function run(v: Variant, lang: Lang, card: Card, word: Buffer): Promise<Result> {
  let altOk = false;
  const all = deck(lang).map((w) => w.word);
  const [, wordEnd] = speechSpan(word);
  const { pcm, leadMs } = scene(word);
  const endAt = leadMs + wordEnd;                    // ms into the stream
  const ws = new WebSocket(url(v, lang), { headers: { Authorization: `Token ${DG}` } });
  try {
    await new Promise<void>((ok, bad) => { ws.once("open", () => ok()); ws.once("error", bad); });
  } catch (e) { return { heard: "", ok: false, interimLag: null, finalLag: null, err: String(e).slice(0, 80) }; }

  let t0 = 0, finals = "", interimLag: number | null = null, finalLag: number | null = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    const text: string = m.channel?.alternatives?.[0]?.transcript ?? "";
    if (!text.trim()) return;
    const lag = Date.now() - t0 - endAt;
    if (m.is_final && v.extra?.includes("alternatives")) {
      for (const a of (m.channel?.alternatives ?? []) as { transcript?: string }[]) {
        if (a.transcript && heardIt(a.transcript, card.word, card.also ?? [], all, TOL)) altOk = true;
      }
    }
    const good = heardIt(text, card.word, card.also ?? [], all, TOL);
    if (good && interimLag === null) interimLag = lag;
    if (m.is_final) {
      finals += (finals ? " " : "") + text;
      if (finalLag === null) finalLag = lag;
    }
  });

  const CH = Math.round(CHUNK_MS * 32);              // bytes per chunk (16 kHz × 2 B)
  t0 = Date.now();
  for (let i = 0; i * CH < pcm.length; i++) {
    await sleep(t0 + i * CHUNK_MS - Date.now());
    ws.send(pcm.subarray(i * CH, (i + 1) * CH));
  }
  ws.send(JSON.stringify({ type: "CloseStream" }));
  await sleep(500);
  ws.close();
  return { heard: finals, ok: altOk || heardIt(finals, card.word, card.also ?? [], all, TOL), interimLag, finalLag };
}

// ── report ───────────────────────────────────────────────────────────────

const med = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : NaN;
const rows = new Map<string, { ok: number; n: number; il: number[]; fl: number[]; miss: string[]; early: number }>();
for (const v of VARIANTS) rows.set(v.name, { ok: 0, n: 0, il: [], fl: [], miss: [], early: 0 });

for (const lang of ["tr", "ru", "en"] as Lang[]) {
  if (ONLY && ONLY !== lang) continue;
  const cards = deck(lang);
  for (const c of SET[lang]) {
    const card = cards.find((x) => x.word === c.card);
    if (!card) { console.log(`(skip: ${c.card} not in ${lang} deck)`); continue; }
    const pcm = await synth(lang, c.say);
    const results = await Promise.all(VARIANTS.map((v) => run(v, lang, card, pcm)));
    VARIANTS.forEach((v, i) => {
      const r = results[i]!, row = rows.get(v.name)!;
      row.n++;
      if (r.ok) row.ok++; else row.miss.push(`${lang}:${c.say}→${c.card} heard "${r.heard}"${r.err ? " " + r.err : ""}`);
      if (r.ok && r.interimLag !== null) row.il.push(r.interimLag);
      if (r.ok && r.finalLag !== null) row.fl.push(r.finalLag);
      if (r.ok && r.interimLag !== null && r.finalLag !== null && r.finalLag - r.interimLag > 80) row.early++;
    });
    console.log(`${lang} ${c.say.padEnd(8)}→ ${c.card.padEnd(8)} ` + results.map((r) =>
      (r.ok ? "✓" : "✗") + (r.finalLag !== null ? `${r.finalLag}`.padStart(5) : "   --")).join("  "));
  }
}

console.log(`\nset ${arg("set", "real")}, tolerance ${TOL}, chunk ${CHUNK_MS} ms, gain ${GAIN}   accuracy | median ms after word ends: first correct interim / first final`);
for (const [name, r] of rows) {
  console.log(`${name.padEnd(30)} ${r.ok}/${r.n}   interim ${String(med(r.il)).padStart(5)}   final ${String(med(r.fl)).padStart(5)}   interim-before-final in ${r.early}/${r.ok}`);
}
console.log("\nmisses:");
for (const [name, r] of rows) console.log(`  ${name}: ${r.miss.join("  ") || "none"}`);
