/* söyle — the browser half of the game.
 *
 * Everything intelligent lives on the server. This file does exactly four
 * jobs, and nothing else:
 *
 *   1. MICROPHONE  capture audio, downsample it to what the server expects,
 *                  and stream it over the websocket as raw bytes.
 *   2. SPEAKER     receive raw audio bytes from the server and play them
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
 *     binary            16 kHz mono PCM16 microphone audio, ~4096-sample
 *                       chunks (the server's recogniser wants 16 kHz)
 *     "next"            the skip button: deal another picture
 *
 *   server → browser
 *     binary            24 kHz mono PCM16 speech/sound to play
 *     {type:"ready"}                      session is live, start the mic ring
 *     {type:"card", emoji, word, score}   show this picture
 *     {type:"hearing", text}              grey interim transcript (she is
 *                                         still speaking)
 *     {type:"said", text, ok}             settled transcript; ok is the
 *                                         verdict COMPUTED BY THE SERVER:
 *                                         true → green + pop, false → amber +
 *                                         shake, null → neutral (no card yet).
 *                                         The browser never judges anything.
 *     {type:"score", score}               a star was awarded: confetti
 *
 * Nothing about the child is stored anywhere in here — no recordings, no
 * localStorage, nothing survives a reload.
 */
(function () {
  "use strict";

  /* ── Language of the UI chrome (the GAME language is the server's; both
     come from the same ?lang= query so they always agree). ─────────────── */
  const L = new URLSearchParams(location.search).get("lang") || "tr";
  const T = {
    tr: {go: "Başla",  skip: "başka →",  hint: "söyle",
         mic: "mikrofon izni gerekli",          end: "bitti"},
    ru: {go: "Начали", skip: "другое →", hint: "скажи",
         mic: "нужен доступ к микрофону",       end: "конец"},
    en: {go: "Start",  skip: "another →", hint: "say it",
         mic: "microphone permission needed",   end: "the end"},
  }[L] || {};
  document.documentElement.lang = L;

  /* ── Audio constants. IN is what the server's recogniser expects from the
     mic; OUT is what its mouth produces. Neither is negotiable — they mirror
     the voicecore frame contract on the server side. ────────────────────── */
  const IN = 16000;
  let OUT = 24000;

  let ws, ctx, mic, src;
  let at = 0;          // next scheduled playback time (gapless queueing)
  let q = [];          // sources currently scheduled, so "next" can cut them
  let live = false;    // gate: no audio is sent before the server says ready

  const $ = (id) => document.getElementById(id);
  const card = $("card"), emoji = $("emoji"), heard = $("heard"),
        stars = $("stars");

  /* ── 1. MICROPHONE ───────────────────────────────────────────────────────
     The AudioContext runs at whatever rate the hardware likes (44.1/48 kHz).
     The server wants 16 kHz, so each block is downsampled by simple
     averaging — crude but plenty for speech, and dependency-free. */

  function down(f, rate) {
    if (rate === IN) return f;
    const r = rate / IN, out = new Float32Array(Math.round(f.length / r));
    for (let i = 0; i < out.length; i++) {
      const a = Math.round(i * r), b = Math.min(Math.round((i + 1) * r), f.length);
      let s = 0;
      for (let j = a; j < b; j++) s += f[j];
      out[i] = s / Math.max(1, b - a);
    }
    return out;
  }

  /* Float [-1,1] → little-endian PCM16, the only format the wire carries. */
  function pcm16(f) {
    const b = new ArrayBuffer(f.length * 2), v = new DataView(b);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return b;
  }

  /* ── 2. SPEAKER ──────────────────────────────────────────────────────────
     Chunks arrive faster than real time. Each one is scheduled to start the
     moment the previous one ends (`at` carries the running clock), which is
     what makes the voice sound continuous instead of choppy. */

  function play(buf) {
    if (!ctx) return;
    const p = new Int16Array(buf), b = ctx.createBuffer(1, p.length, OUT),
          c = b.getChannelData(0);
    for (let i = 0; i < p.length; i++) c[i] = p[i] / 0x8000;
    const s = ctx.createBufferSource();
    s.buffer = b; s.connect(ctx.destination);
    const now = ctx.currentTime;
    if (at < now) at = now + 0.02;          // fell behind: restart just ahead
    s.start(at); at += b.duration;
    q.push(s);
    s.onended = () => { q = q.filter((x) => x !== s); };
  }

  /* Stop everything queued but not yet heard — used by the skip button so a
     new card does not play on top of the old card's sentence. */
  function flush() {
    q.forEach((s) => { try { s.stop(); } catch (e) {} });
    q = []; at = 0;
  }

  /* ── 4. CONFETTI ─────────────────────────────────────────────────────────
     A one-shot particle burst on a full-screen canvas. Rectangles with
     gravity, drag and spin; cheap enough for a tablet, honest enough to
     respect prefers-reduced-motion. */

  const cv = $("confetti"), cx = cv.getContext("2d");
  let bits = [], raf = null;
  const COLORS = ["#ff5d8f", "#ffd166", "#5fd3a5", "#5aa9ff", "#c58bff", "#ff9f45"];

  function size() {
    const r = window.devicePixelRatio || 1;
    cv.width = innerWidth * r; cv.height = innerHeight * r;
    cx.setTransform(r, 0, 0, r, 0, 0);
  }
  size(); addEventListener("resize", size);

  function burst() {
    if (window.matchMedia("(prefers-reduced-motion:reduce)").matches) return;
    const box = card.getBoundingClientRect();
    const ox = box.left + box.width / 2, oy = box.top + box.height / 2;
    for (let i = 0; i < 110; i++) {
      const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 9;
      bits.push({x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 5,
                 w: 5 + Math.random() * 7, h: 8 + Math.random() * 10,
                 rot: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 0.4,
                 c: COLORS[(Math.random() * COLORS.length) | 0], life: 1});
    }
    if (!raf) raf = requestAnimationFrame(step);
  }

  function step() {
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

  /* Retrigger a one-shot CSS animation (.ok pop / .no shake) on the card. */
  function pulse(cls) {
    card.classList.remove("ok", "no");
    void card.offsetWidth;                   // forces a reflow between runs
    card.classList.add(cls);
  }

  /* ── 3. SCREEN + session wiring ─────────────────────────────────────── */

  async function start() {
    try {
      mic = await navigator.mediaDevices.getUserMedia({audio: {
        channelCount: 1, echoCancellation: true,
        noiseSuppression: true, autoGainControl: true}});
    } catch (e) {
      heard.textContent = T.mic || "mikrofon izni gerekli";
      return;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    $("go").hidden = true; $("skip").hidden = false;

    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://")
                       + location.host + "/ws?lang=" + L);
    ws.binaryType = "arraybuffer";

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") { play(ev.data); return; }
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "ready") {
        live = true; card.classList.add("live");
      } else if (m.type === "card") {
        emoji.textContent = m.emoji; heard.textContent = "…";
        stars.textContent = "⭐".repeat(Math.min(m.score || 0, 10));
      } else if (m.type === "hearing") {
        heard.textContent = m.text;
      } else if (m.type === "said") {
        // The verdict arrives with the transcript, decided server-side.
        heard.textContent = "";
        const el = document.createElement(
          m.ok === true ? "b" : (m.ok === false ? "i" : "span"));
        el.textContent = m.text; heard.appendChild(el);
        if (m.ok === true) pulse("ok"); else if (m.ok === false) pulse("no");
      } else if (m.type === "score") {
        pulse("ok"); burst();
        stars.textContent = "⭐".repeat(Math.min(m.score || 0, 10));
      }
    };

    ws.onclose = () => {
      live = false; card.classList.remove("live");
      heard.textContent = T.end || "bitti";
      $("go").hidden = false; $("skip").hidden = true;
    };

    /* ScriptProcessor is deprecated in favour of AudioWorklet, but it works
       in every browser a parent will actually hand a toddler, needs no extra
       file or CSP tweak, and 4096 samples ≈ 85 ms of latency — irrelevant
       next to the recogniser's own endpointing. A worklet buys nothing here. */
    src = ctx.createMediaStreamSource(mic);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (!live || !ws || ws.readyState !== 1) return;
      ws.send(pcm16(down(e.inputBuffer.getChannelData(0), ctx.sampleRate)));
    };
    src.connect(node);
    node.connect(ctx.destination);           // required for onaudioprocess to fire
  }

  if (T.go) {
    $("golabel").textContent = T.go;
    $("skip").textContent = T.skip;
    heard.textContent = T.hint;
  }
  $("go").onclick = start;
  $("skip").onclick = () => {
    if (ws && ws.readyState === 1) { flush(); ws.send("next"); }
  };
})();
