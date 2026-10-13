/* Sound as something the game can PLAY, not something it says.
 *
 * The chimes are generated here at boot rather than shipped as files: no
 * assets, no network, no licence, and a melody is three numbers to change.
 * Everything is 24 kHz mono PCM16 — the same format the voice arrives in,
 * so the browser plays both through one pipe.
 */

export const RATE = 24000;

function hz(note: string): number {
  const names: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
  const step = (names[note[0]!] ?? 0) + (note.includes("#") ? 1 : 0);
  const octave = parseInt(note[note.length - 1]!, 10);
  return 440 * 2 ** (step / 12) * 2 ** (octave - 4);
}

/** One soft note: two partials and a gentle bell envelope, so it sounds like
 *  a toy glockenspiel rather than a test signal. */
function tone(freq: number, secs: number, gain = 0.22): number[] {
  const n = Math.floor(RATE * secs), out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.min(1, t / 0.012) * Math.exp((-3.2 * t) / secs);
    const v = Math.sin(2 * Math.PI * freq * t) + 0.28 * Math.sin(4 * Math.PI * freq * t);
    out.push((env * gain * v) / 1.28);
  }
  return out;
}

function toPcm(buf: number[]): Buffer {
  const b = Buffer.alloc(buf.length * 2);
  buf.forEach((v, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  return b;
}

function melody(notes: string[], noteS = 0.14, gapS = 0.01): Buffer {
  let buf: number[] = [];
  for (const name of notes) {
    buf = buf.concat(tone(hz(name), noteS), new Array(Math.floor(RATE * gapS)).fill(0));
  }
  buf = buf.concat(new Array(Math.floor(RATE * 0.1)).fill(0)); // let it ring out
  return toPcm(buf);
}

/** Confetti: a fast run up the scale with a shimmer over it. Short overlapped
 *  notes so it reads as a burst rather than a tune. */
function sparkle(): Buffer {
  const buf: number[] = [];
  const add = (name: string, at: number, secs: number, gain: number) => {
    const t = tone(hz(name), secs, gain);
    const start = Math.floor(RATE * at);
    while (buf.length < start + t.length) buf.push(0);
    t.forEach((v, i) => { buf[start + i]! += v; });
  };
  ["C5", "E5", "G5", "C6", "E6", "G6"].forEach((n, k) => add(n, k * 0.055, 0.3, 0.17));
  add("C6", 0.2, 0.22, 0.09); add("G6", 0.3, 0.22, 0.09); add("E6", 0.4, 0.22, 0.09);
  return toPcm(buf.concat(new Array(Math.floor(RATE * 0.12)).fill(0)));
}

// Built once at import — a few hundred KB, and no note is ever synthesised
// while a child is waiting.
export const CUES: Record<string, Buffer> = {
  confetti: sparkle(),                              // a right answer
  yes: melody(["C5", "E5", "G5"]),                  // got it
  star: melody(["C5", "E5", "G5", "C6"], 0.12),     // every award
  again: melody(["E4", "C4"], 0.17),                // soft, not a buzzer
  hello: melody(["G4", "C5", "E5"], 0.16),          // start of play
};
