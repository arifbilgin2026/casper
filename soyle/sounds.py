"""Sound as something the game can PLAY, not something it says.

The Mouth takes frames of audio. Until now every frame came from a voice, but
nothing in it cares where they came from — so a chime is the same kind of thing
as a sentence, and goes out through the same pipe, under the same rule that only
one thing owns the mouth at a time.

The notes are generated here rather than shipped as files: no assets, no
network, no licence, and a melody is three numbers to change.
"""
from __future__ import annotations

import math
import struct

RATE = 24000                 # what the Mouth expects
FRAME = 960                  # bytes: 20 ms of 24 kHz mono PCM16

#: equal temperament, A4 = 440
def _hz(note: str) -> float:
    names = {"C": -9, "D": -7, "E": -5, "F": -4, "G": -2, "A": 0, "B": 2}
    step = names[note[0]] + (1 if "#" in note else 0)
    octave = int(note[-1])
    return 440.0 * (2 ** (step / 12.0)) * (2 ** (octave - 4))


def _tone(freq: float, secs: float, gain: float = 0.22) -> list:
    """One soft note. Two partials and a gentle bell envelope, so it sounds
    like a toy glockenspiel rather than a test signal."""
    n = int(RATE * secs)
    out = []
    for i in range(n):
        t = i / RATE
        env = min(1.0, t / 0.012) * math.exp(-3.2 * t / secs)   # quick in, soft out
        v = (math.sin(2 * math.pi * freq * t)
             + 0.28 * math.sin(4 * math.pi * freq * t))         # one octave up
        out.append(env * gain * v / 1.28)
    return out


def _melody(notes, note_s=0.14, gap_s=0.01) -> bytes:
    buf = []
    for name in notes:
        buf += _tone(_hz(name), note_s)
        buf += [0.0] * int(RATE * gap_s)
    buf += [0.0] * int(RATE * 0.10)              # let it ring out
    return b"".join(struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))
                    for v in buf)


def frames(pcm: bytes) -> list:
    """Chop to the exact 960-byte frames the Mouth counts in, padding the tail."""
    out = []
    for i in range(0, len(pcm), FRAME):
        chunk = pcm[i:i + FRAME]
        if len(chunk) < FRAME:
            chunk += b"\x00" * (FRAME - len(chunk))
        out.append(chunk)
    return out


# Built once at import — a few hundred KB, and no note is ever synthesised
# while a child is waiting.
def _sparkle() -> bytes:
    """Confetti: a fast run up the scale with a shimmer over it. Short notes so
    it reads as a burst rather than a tune — the point is the moment, not the
    melody."""
    buf = []
    run = ["C5", "E5", "G5", "C6", "E6", "G6"]
    step = int(RATE * 0.055)
    for k, name in enumerate(run):
        tone = _tone(_hz(name), 0.30, gain=0.17)
        start = k * step
        if len(buf) < start + len(tone):
            buf += [0.0] * (start + len(tone) - len(buf))
        for i, v in enumerate(tone):           # overlap them: a shimmer, not a scale
            buf[start + i] += v
    for name, when in (("C6", 0.20), ("G6", 0.30), ("E6", 0.40)):
        tone = _tone(_hz(name), 0.22, gain=0.09)
        start = int(RATE * when)
        if len(buf) < start + len(tone):
            buf += [0.0] * (start + len(tone) - len(buf))
        for i, v in enumerate(tone):
            buf[start + i] += v
    buf += [0.0] * int(RATE * 0.12)
    return b"".join(struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))
                    for v in buf)


CUES = {
    "confetti": frames(_sparkle()),                              # a right answer
    "yes":     frames(_melody(["C5", "E5", "G5"])),              # got it
    "star":    frames(_melody(["C5", "E5", "G5", "C6"], 0.12)),   # every 5th
    "again":   frames(_melody(["E4", "C4"], 0.17)),               # soft, not a buzzer
    "hello":   frames(_melody(["G4", "C5", "E5"], 0.16)),         # start of play
}
