/* The scripted child, through the REAL browser path.
 *
 * Starts a local server, signs a throwaway family up, launches headless Chrome
 * with its microphone replaced by a looping buffer (a synthesised word,
 * room noise between), presses Start, and reports what the server heard and
 * how long the child waited for the reply: transcripts, verdicts, and the
 * answer → first-sound latency, all from the server's own trace.
 *
 * That exercises everything the unit tests cannot: the AudioWorklet, the
 * 16 kHz capture, the websocket, Deepgram, early commit, and the audio coming
 * back. Chrome is muted (--mute-audio) and killed when the run ends.
 *
 *   DEEPGRAM_API_KEY=… ELEVENLABS_API_KEY=… \
 *     npx tsx scripts/browser-child.ts [--lang tr] [--word kedi] [--gain 0.3] [--secs 45]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1]! : d;
};
const LANG = arg("lang", "tr"), WORD = arg("word", "kedi");
const GAIN = Number(arg("gain", "0.3")), SECS = Number(arg("secs", "45"));
const MODE = arg("mode", "");                       // baby | toddler (blank = the family default)
const PORT = 8611, CDP = 9333, PERIOD_S = 9;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VOICES: Record<string, string> = {
  tr: "Et3hA9mm8aHhswBL5jmC", ru: "GN4wbsbejSnGSa1AzjH5", en: "21m00Tcm4TlvDq8ikWAM",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the child's microphone: noise, the word, noise — looped ──────────────

async function word16k(): Promise<Buffer> {
  const dir = path.join(HERE, "..", ".bench-cache");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${LANG}-${Buffer.from(WORD).toString("hex")}.pcm`);
  if (existsSync(f)) return readFileSync(f);
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICES[LANG]}?output_format=pcm_16000`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ text: WORD, model_id: "eleven_turbo_v2_5", language_code: LANG }),
    });
  const b = Buffer.from(await r.arrayBuffer());
  writeFileSync(f, b);
  return b;
}

async function makeRaw(): Promise<Buffer> {
  const word = await word16k();
  const noise = (s: number) => {
    const b = Buffer.alloc(16000 * s * 2);
    for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round((Math.random() - 0.5) * 260), i * 2);
    return b;
  };
  const w = Buffer.alloc(word.length);
  for (let i = 0; i < word.length / 2; i++) {
    w.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(word.readInt16LE(i * 2) * GAIN))), i * 2);
  }
  // one loop = the word, then room noise out to PERIOD_S
  const used = word.length / 2 / 16000;
  return Buffer.concat([noise(1), w, noise(Math.max(1, PERIOD_S - 1 - Math.ceil(used)))]);
}

/** Replaces the page's microphone with this loop. Chrome's own fake-capture
 *  file feature proved unreliable (it delivered digital silence), and the
 *  point here is the app's path from getUserMedia onward, not Chrome's. */
function micOverride(raw: Buffer): string {
  return `(() => {
    const B64 = "${raw.toString("base64")}";
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.resume();
      const bin = atob(B64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const i16 = new Int16Array(u8.buffer), f = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
      const buf = ctx.createBuffer(1, f.length, 16000); buf.copyToChannel(f, 0);
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const dest = ctx.createMediaStreamDestination(); src.connect(dest); src.start();
      return dest.stream;
    };
  })();`;
}

// ── run ──────────────────────────────────────────────────────────────────

const raw = await makeRaw();
const log: string[] = [];
const server = spawn("npx", ["tsx", "src/server.ts"], {
  cwd: path.join(HERE, ".."),
  env: { ...process.env, PORT: String(PORT), SOYLE_NO_LLM: "1", STT_TRACE: "1" },
  detached: true,                     // its own process group, so cleanup can take the grandchildren too
});
for (const s of [server.stdout, server.stderr]) {
  s.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log.push(`${Date.now()} ${l}`)));
}
let chrome: ReturnType<typeof spawn> | null = null;
const killGroup = (c: { pid?: number } | null) => {
  if (c?.pid) { try { process.kill(-c.pid, "SIGKILL"); } catch { try { process.kill(c.pid, "SIGKILL"); } catch { /* gone */ } } }
};
const cleanup = () => { killGroup(chrome); killGroup(server); };
process.on("SIGINT", () => { cleanup(); process.exit(1); });

try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  console.log("server up; signing up…");
  const su = await fetch(`http://localhost:${PORT}/signup`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "child@test.dev", password: "secret1", confirm: "secret1", childName: "T", lang: LANG }),
  });
  const sid = (su.headers.get("set-cookie") ?? "").match(/sid=([^;]+)/)?.[1];
  if (!sid) throw new Error("signup failed");
  console.log("signed up; launching chrome…");

  chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP}`, "--mute-audio",
    "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    "--user-data-dir=/tmp/soyle-chrome-profile", "--no-first-run", "about:blank",
  ], { stdio: "ignore", detached: true });
  let target = "";
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() as
        { type: string; webSocketDebuggerUrl: string }[];
      target = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch { /* chrome booting */ }
  }
  if (!target) throw new Error("no chrome page");
  console.log("chrome up; driving the page…");

  const cdp = new WebSocket(target);
  await new Promise((r) => cdp.once("open", r));
  let id = 0;
  const call = (method: string, params: object = {}) => new Promise<unknown>((ok) => {
    const me = ++id;
    const on = (raw: WebSocket.RawData) => {
      const m = JSON.parse(String(raw));
      if (m.id === me) { cdp.off("message", on); ok(m.result); }
    };
    cdp.on("message", on);
    cdp.send(JSON.stringify({ id: me, method, params }));
  });
  cdp.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.method === "Runtime.exceptionThrown") {
      log.push(`${Date.now()} [browser error] ${JSON.stringify(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)}`);
    }
  });
  await call("Runtime.enable");
  await call("Network.setCookie", { name: "sid", value: sid, url: `http://localhost:${PORT}/` });
  await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: micOverride(raw) });
  await call("Page.navigate", { url: `http://localhost:${PORT}/game${MODE ? "?mode=" + MODE : ""}` });
  await sleep(2000);
  await call("Runtime.evaluate", { expression: "document.getElementById('go').click()", userGesture: true });
  console.log(`playing "${WORD}" (${LANG}) at gain ${GAIN} through headless Chrome for ${SECS}s…`);
  const probe = await call("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `
    (async () => {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const c = new AudioContext(), a = c.createAnalyser(); a.fftSize = 2048;
      c.createMediaStreamSource(s).connect(a);
      const buf = new Float32Array(a.fftSize); let peak = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 3500) {
        a.getFloatTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        await new Promise((r) => setTimeout(r, 30));
      }
      return peak;
    })()` }) as { result?: { value?: number } };
  console.log(`probe: raw fake-device peak seen by an independent analyser = ${probe?.result?.value}`);
  await sleep(SECS * 1000);
} finally {
  cleanup();
}

const keep = log.filter((l) => /\[(stt|dg|lat|celebrate|fallback|browser error)\]|said|session start failed|error/i.test(l));
const t0 = Number(keep[0]?.split(" ")[0] ?? 0);
console.log("\n   t(s)  event");
for (const l of keep) {
  const [ts, ...rest] = l.split(" ");
  console.log(`${((Number(ts) - t0) / 1000).toFixed(1).padStart(7)}  ${rest.join(" ").replace(/^\[[^\]]*@[^\]]*\] /, "")}`);
}
const lat = keep.map((l) => l.match(/first sound (\d+) ms/)?.[1]).filter(Boolean).map(Number);
console.log(`\nanswers heard: ${keep.filter((l) => /\[stt\] final/.test(l)).length}   `
  + `answer → first sound ms: ${lat.join(", ") || "none"}`);

process.exit(0);
