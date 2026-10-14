/* The microphone, on the AUDIO thread.
 *
 * This replaces a main-thread ScriptProcessor, for three reasons that each
 * cost a toddler's short word:
 *
 *   1. Isolation. The main thread also draws confetti and animates the card;
 *      when it janks, a ScriptProcessor drops audio frames, and a one-syllable
 *      word is exactly the thing that fits inside the gap. A worklet is
 *      scheduled by the audio engine and never waits for the page.
 *   2. Resampling done properly. The old code averaged input samples with
 *      window edges rounded independently per block — no anti-alias filter, and
 *      on 44.1 kHz hardware an uneven decimation clock. Fricatives (s, ş, ç —
 *      the sounds that tell "sun" from "son") smeared into the 0–8 kHz band.
 *      When the page could not get a 16 kHz context, this applies a 4th-order
 *      Butterworth low-pass below the new Nyquist and decimates with a
 *      fractional position carried across blocks. When it could (the usual
 *      case), the ratio is 1 and the audio passes through untouched.
 *   3. Latency. It posts 20 ms chunks instead of ~85 ms ones.
 *
 * Output: little-endian PCM16 at 16 kHz mono, 640 bytes (20 ms) per message —
 * what the server and the recogniser expect.
 */
const TARGET = 16000;
const CHUNK = 320;                       // samples = 20 ms @ 16 kHz

/** One RBJ low-pass biquad section. */
class Biquad {
  constructor(fc, fs, q) {
    const w = 2 * Math.PI * fc / fs, cos = Math.cos(w), alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0; this.b1 = (1 - cos) / a0; this.b2 = this.b0;
    this.a1 = -2 * cos / a0; this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class Mic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET;    // 1 when the context already runs at 16 kHz
    this.out = new Int16Array(CHUNK);
    this.n = 0;
    this.t = 0;                          // next output position, in input samples
    this.last = 0;                       // last filtered input sample of the previous block
    if (this.ratio > 1) {                // Butterworth-4: two sections, Q = 0.5412 / 1.3066
      const fc = 0.45 * TARGET;          // 7.2 kHz: below the new Nyquist (8 kHz)
      this.lp = [new Biquad(fc, sampleRate, 0.5412), new Biquad(fc, sampleRate, 1.3066)];
    }
  }

  emit(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.n === CHUNK) {
      this.port.postMessage(this.out.buffer, [this.out.buffer]);
      this.out = new Int16Array(CHUNK);
      this.n = 0;
    }
  }

  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < x.length; i++) this.emit(x[i]);
      return true;
    }
    const n = x.length, y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = this.lp[1].step(this.lp[0].step(x[i]));
    // Output sample k sits at input position t; t may be -1..0, which means
    // "between the last sample of the previous block and this block's first".
    let t = this.t;
    while (t < n - 1) {
      const i = Math.floor(t), f = t - i;
      const a = i < 0 ? this.last : y[i];
      this.emit(a + (y[i + 1] - a) * f);
      t += this.ratio;
    }
    this.t = t - n;
    this.last = y[n - 1];
    return true;
  }
}

registerProcessor("mic", Mic);
