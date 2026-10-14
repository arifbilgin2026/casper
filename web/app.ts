/* söyle — the browser half of the game (served only at /game, only to a
 * signed-in session; the login page is plain HTML with no script at all).
 *
 * Everything intelligent lives on the server. This file does four jobs:
 *
 *   1. MICROPHONE  capture audio on the AUDIO thread (mic-worklet.js), 16 kHz,
 *                  20 ms chunks, streamed over the websocket as raw bytes.
 *   2. SPEAKER     receive 24 kHz PCM16 from the server and play it
 *                  gaplessly, in order.
 *   3. SCREEN      react to five tiny JSON messages (the whole protocol).
 *   4. CONFETTI    draw the celebration. Pure decoration.
 *
 * The one websocket carries both kinds of traffic: binary frames are audio,
 * text frames are JSON. That split IS the protocol discriminator.
 *
 * ── The wire protocol ────────────────────────────────────────────────────
 *
 *   browser → server
 *     binary           16 kHz mono PCM16 microphone audio
 *     "next"           the skip button: deal another picture
 *
 *   server → browser
 *     binary           24 kHz mono PCM16 speech/sound to play
 *     {type:"ready"}                     session live, start the mic ring
 *     {type:"card", emoji, word, score}  show this picture
 *     {type:"hearing", text}             grey interim transcript
 *     {type:"said", text, ok}            settled transcript; ok is the verdict
 *                                        COMPUTED BY THE SERVER: true → green
 *                                        + pop, false → amber + shake. The
 *                                        browser never judges anything.
 *     {type:"score", score}              a star was awarded: confetti
 *
 * Nothing about the child is stored in the browser — no recordings, no
 * localStorage; progress lives in the parent's account server-side.
 */

type Lang = "tr" | "ru" | "en";
interface Me { email: string; childName: string; lang: Lang; stars: number; mastered: number }

const qlang = new URLSearchParams(location.search).get("lang") as Lang | null;
const qmode = new URLSearchParams(location.search).get("mode");   // baby | toddler
const T: Record<Lang, Record<string, string>> = {
  tr: { go: "Başla", skip: "başka →", hint: "söyle", mic: "mikrofon izni gerekli", end: "bitti" },
  ru: { go: "Начали", skip: "другое →", hint: "скажи", mic: "нужен доступ к микрофону", end: "конец" },
  en: { go: "Start", skip: "another →", hint: "say it", mic: "microphone permission needed", end: "the end" },
};

const IN = 16000, OUT = 24000;
let ws: WebSocket | null = null, ctx: AudioContext | null = null;
let at = 0, playing: AudioBufferSourceNode[] = [], live = false;
let lang: Lang = qlang ?? "tr";

const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;
const card = $("card"), emoji = $("emoji"), heard = $("heard"), stars = $("stars");

/* The server already refused this page to strangers; this fetch just brings
 * the family's language and star count. A dead session mid-visit goes back
 * to the login page. */
async function hello(): Promise<void> {
  const r = await fetch("/api/me");
  if (!r.ok) { location.replace("/"); return; }
  const user = await r.json() as Me;
  lang = qlang ?? user.lang;
  const t = T[lang]!;
  $("golabel").textContent = t.go!;
  $("skip").textContent = t.skip!;
  heard.textContent = t.hint!;
  document.documentElement.lang = lang;
  stars.textContent = "⭐".repeat(Math.min(user.stars, 10));
}

/* ── 1. MICROPHONE: see startMic() below and mic-worklet.js ───────────── */

/* ── 2. SPEAKER: schedule each chunk to start when the last one ends ───── */

function play(buf: ArrayBuffer): void {
  if (!ctx) return;
  const p = new Int16Array(buf), b = ctx.createBuffer(1, p.length, OUT);
  const c = b.getChannelData(0);
  for (let i = 0; i < p.length; i++) c[i] = p[i]! / 0x8000;
  const s = ctx.createBufferSource();
  s.buffer = b; s.connect(ctx.destination);
  const now = ctx.currentTime;
  if (at < now) at = now + 0.02;
  s.start(at); at += b.duration;
  playing.push(s);
  s.onended = () => { playing = playing.filter((x) => x !== s); };
}

function flush(): void {
  playing.forEach((s) => { try { s.stop(); } catch { /* done */ } });
  playing = []; at = 0;
}

/* ── 4. CONFETTI ───────────────────────────────────────────────────────── */

const cv = $<HTMLCanvasElement>("confetti"), cx = cv.getContext("2d")!;
interface Bit { x: number; y: number; vx: number; vy: number; w: number;
                h: number; rot: number; spin: number; c: string; life: number }
let bits: Bit[] = [], raf: number | null = null;
const COLORS = ["#ff5d8f", "#ffd166", "#5fd3a5", "#5aa9ff", "#c58bff", "#ff9f45"];

function size(): void {
  const r = window.devicePixelRatio || 1;
  cv.width = innerWidth * r; cv.height = innerHeight * r;
  cx.setTransform(r, 0, 0, r, 0, 0);
}
size(); addEventListener("resize", size);

function burst(): void {
  if (matchMedia("(prefers-reduced-motion:reduce)").matches) return;
  const box = card.getBoundingClientRect();
  const ox = box.left + box.width / 2, oy = box.top + box.height / 2;
  for (let i = 0; i < 110; i++) {
    const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 9;
    bits.push({ x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 5,
                w: 5 + Math.random() * 7, h: 8 + Math.random() * 10,
                rot: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 0.4,
                c: COLORS[(Math.random() * COLORS.length) | 0]!, life: 1 });
  }
  if (!raf) raf = requestAnimationFrame(step);
}

function step(): void {
  cx.clearRect(0, 0, innerWidth, innerHeight);
  bits = bits.filter((b) => b.life > 0);
  for (const b of bits) {
    b.vy += 0.32; b.vx *= 0.995; b.x += b.vx; b.y += b.vy;
    b.rot += b.spin; b.life -= 0.0085;
    cx.save(); cx.translate(b.x, b.y); cx.rotate(b.rot);
    cx.globalAlpha = Math.max(0, Math.min(1, b.life * 1.6));
    cx.fillStyle = b.c; cx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
    cx.restore();
  }
  raf = bits.length ? requestAnimationFrame(step)
                    : (cx.clearRect(0, 0, innerWidth, innerHeight), null);
}

function pulse(cls: "ok" | "no"): void {
  card.classList.remove("ok", "no");
  void card.offsetWidth;                   // forces a reflow between runs
  card.classList.add(cls);
}

/* ── 3. SCREEN + session wiring ────────────────────────────────────────── */

async function start(): Promise<void> {
  const t = T[lang]!;
  let mic: MediaStream;
  try {
    // Noise suppression is OFF on purpose: browsers' suppressors treat a short
    // quiet word as noise and clip its onset, and a one-syllable word is
    // mostly onset. Echo cancellation stays (the speakers are right there) and
    // so does auto-gain, which lifts a toddler's quiet voice to a usable level.
    mic = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true,
      noiseSuppression: false, autoGainControl: true } });
  } catch {
    heard.textContent = t.mic!;
    return;
  }
  ctx = new AudioContext();
  await ctx.resume();
  $("go").hidden = true; $("skip").hidden = false;

  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://")
    + location.host + "/ws?lang=" + lang
    + (qmode ? "&mode=" + qmode : ""));
  ws.binaryType = "arraybuffer";

  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") { play(ev.data as ArrayBuffer); return; }
    let m: { type: string; emoji?: string; text?: string; ok?: boolean | null; score?: number };
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "ready") { live = true; card.classList.add("live"); }
    else if (m.type === "card") {
      emoji.textContent = m.emoji ?? "🙂"; heard.textContent = "…";
      stars.textContent = "⭐".repeat(Math.min(m.score ?? 0, 10));
    } else if (m.type === "hearing") { heard.textContent = m.text ?? ""; }
    else if (m.type === "said") {
      // The verdict arrives with the transcript, decided server-side.
      heard.textContent = "";
      const el = document.createElement(m.ok === true ? "b" : m.ok === false ? "i" : "span");
      el.textContent = m.text ?? ""; heard.appendChild(el);
      if (m.ok === true) pulse("ok"); else if (m.ok === false) pulse("no");
    } else if (m.type === "score") {
      pulse("ok"); burst();
      stars.textContent = "⭐".repeat(Math.min(m.score ?? 0, 10));
    }
  };

  ws.onclose = () => {
    live = false; card.classList.remove("live");
    heard.textContent = t.end!;
    $("go").hidden = false; $("skip").hidden = true;
  };

  await startMic(mic);
}

/* The microphone runs in its OWN AudioContext, asked to run at 16 kHz so the
 * browser resamples natively and mic-worklet.js can pass the samples through
 * untouched. (Playback keeps the default context: a 16 kHz context would play
 * the 24 kHz voice through a worse resampler.) If the browser refuses a
 * 16 kHz context, or refuses to connect the mic to it, we fall back to the
 * hardware rate and the worklet does the filtering and decimation itself —
 * see mic-worklet.js for why neither path uses the main thread. */
async function startMic(mic: MediaStream): Promise<void> {
  let cap: AudioContext, src: MediaStreamAudioSourceNode;
  try {
    cap = new AudioContext({ sampleRate: IN });
    src = cap.createMediaStreamSource(mic);
  } catch {
    cap = new AudioContext();
    src = cap.createMediaStreamSource(mic);
  }
  await cap.resume();
  await cap.audioWorklet.addModule("/mic-worklet.js");
  const node = new AudioWorkletNode(cap, "mic", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    if (live && ws && ws.readyState === 1) ws.send(e.data);   // 20 ms of PCM16
  };
  src.connect(node);
  node.connect(cap.destination);            // silent; some browsers only run connected nodes
}

$("go").onclick = () => { void start(); };
$("skip").onclick = () => { if (ws?.readyState === 1) { flush(); ws.send("next"); } };
void hello();
