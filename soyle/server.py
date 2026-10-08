"""söyle — a persona plays picture cards with a toddler.

The app owns nothing but the room: what is on the screen, how many stars, what
she just said, who is making noise. A persona is shown that room every couple of
seconds and asked one question — anything to say or do? It answers with one line
that mixes words, sounds and actions, or with PASS.

The tick is gated twice: it never fires while we are talking, and never while
she is talking. So the persona only ever speaks into a silence, which is what an
adult with flashcards actually does.

Everything beneath — streaming speech-to-text, streaming speech, frame-exact
playback, barge-in — is the voicecore library. `Wire` is the whole contract.

    python -m soyle.server      →  http://localhost:8600
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
import time
from http import HTTPStatus

import websockets
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

# Until voicecore is packaged this points at the repo it lives in. Once it is
# `pip install voicecore`, these two lines are the only ones that disappear.
sys.path.insert(0, str(pathlib.Path.home() / "workspace" / "dialtone"))
from dialtone.vcore.ears import Ears                  # noqa: E402
from dialtone.vcore.eleven_ws import ElevenLabsWsTts  # noqa: E402
from dialtone.vcore.llm import BedrockLLM             # noqa: E402
from dialtone.vcore.mouth import Mouth                # noqa: E402

from . import persona                                  # noqa: E402
from .chatter import Chatter                           # noqa: E402
from .match import heard_it, norm                      # noqa: E402
from .sounds import CUES                               # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
PORT = 8600
VOICES = {"tr": "Et3hA9mm8aHhswBL5jmC", "ru": "GN4wbsbejSnGSa1AzjH5"}

_DATA = {c: json.loads((HERE / f"words_{c}.json").read_text())
         for c in ("tr", "ru")}
DECKS = {c: d["words"] for c, d in _DATA.items()}
PHRASES = {c: d["phrases"] for c, d in _DATA.items()}
ALL = {c: [w["word"] for w in d] for c, d in DECKS.items()}

#: The game must run with the model disabled (canned lines only).
NO_LLM = os.environ.get("SOYLE_NO_LLM", "") == "1"

# --- the tick -------------------------------------------------------------
TICK = 0.2            # how often we consider asking
MIN_QUIET = 0.45      # she must have been quiet this long
MIN_SINCE_US = 0.6    # and we must not have just spoken
NUDGE_AFTER = 6.0     # a long silence always earns a look
ENDPOINT_MS = 250     # recogniser settles a segment after this much silence
FLUSH_NUDGE_S = 0.6   # interim stuck this long → tell the recogniser to settle
JUDGE_INTERIM_S = 1.2  # still stuck → judge the grey text as if it were final
FIRST_SOUND_S = 1.4   # the model has this long to start a clause; then canned
HEARD_QUIET = 0.1     # an answered final needs no silence gate — react NOW


def _first_clause(text: str):
    """Index just past the first thing worth saying aloud, or None yet.

    A marker ends a clause too, because [card:x] and ♪yes♪ are beats in the
    utterance — the picture should turn over exactly where it was written."""
    for i, ch in enumerate(text):
        if ch in ".!?…" and i >= 6:
            return i + 1
        if ch in "♪[" and i >= 4:
            return i
    return None


async def _drop(it) -> None:
    """Abandon a half-read model stream without leaking its task."""
    try:
        await it.aclose()
    except Exception:  # noqa: BLE001
        pass


class Wire:
    """The library's whole view of the outside world: two methods."""

    def __init__(self, ws) -> None:
        self._ws, self._q, self._task = ws, asyncio.Queue(), None

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self._pump())

    async def _pump(self) -> None:
        while True:
            item = await self._q.get()
            if item is None:
                return
            try:
                await self._ws.send(item)
            except Exception:  # noqa: BLE001
                return

    async def send(self, pcm: bytes) -> None:
        self._q.put_nowait(pcm)

    async def clear(self) -> None:
        try:
            while True:
                self._q.get_nowait()
        except asyncio.QueueEmpty:
            pass

    def say(self, obj: dict) -> None:
        self._q.put_nowait(json.dumps(obj))

    async def close(self) -> None:
        self._q.put_nowait(None)


class Room:
    """The state the persona is shown, and the only truth the app keeps."""

    def __init__(self, lang: str) -> None:
        self.lang = lang
        self.card: dict | None = None
        self.score = 0
        self.tries = 0
        self.seen: set = set()
        self.heard = ""          # her last settled words
        self.verdict = None      # True / False, decided by match.py
        self.talking = False
        self.last_voice = time.monotonic()
        self.last_us = 0.0


class Game:
    def __init__(self, ws, lang: str = "tr") -> None:
        self.lang = lang if lang in DECKS else "tr"
        self.deck = DECKS[self.lang]
        self.room = Room(self.lang)
        self.wire = Wire(ws)
        self.busy = asyncio.Lock()
        self._mute_until = 0.0
        self._thinking = False
        self.asked = 0
        self.last_said = ""
        self.passed = 0
        # Trap 5: a toddler says one syllable and stops; the recogniser waits
        # for more speech that never comes. Track the stuck interim so the tick
        # can nudge a flush and, failing that, judge the grey text itself.
        self._interim = ""           # last changed partial transcript
        self._interim_at = 0.0       # when it last changed
        self._nudged = False         # finalize() already requested for it
        self._judged = ("", 0.0)     # normed text we judged + when (dedupe)
        self._last_speech = ""       # normed words of our previous line
        self._last_card = None       # the card they were said over

    # ------------------------------------------------------------- setup
    async def start(self) -> None:
        self.tts = ElevenLabsWsTts(voice=VOICES[self.lang], language=self.lang,
                                   model="eleven_turbo_v2_5", speed=0.95)
        self.wire.start()
        self.mouth = Mouth(self.wire, self.tts, lead_s=0.15)
        self.ears = Ears(self._partial, self._final, language=self.lang,
                         model="nova-2", endpointing=ENDPOINT_MS)
        self.llm = None if NO_LLM else BedrockLLM()
        self.chatter = Chatter(self.llm, self.lang, PHRASES[self.lang],
                               log=lambda m: print(m, flush=True))
        await self.mouth.start()
        await self.ears.start()
        await self.tts.warmup()

    # ------------------------------------------------- our own voice/sound
    def _deaf(self) -> bool:
        return (self.mouth.speaking or self.busy.locked()
                or asyncio.get_running_loop().time() < self._mute_until)

    def _leaks_answer(self, text: str) -> bool:
        """The card's word in OUR mouth before she has said it hands her the
        answer ("Hop, at!" was asked about the horse card). Computed, like the
        verdict: saying it is legitimate only once she got it, or after three
        tries when the persona is supposed to say it and move on."""
        card = self.room.card
        if not card or self.room.verdict or self.room.tries >= 3:
            return False
        toks = set(norm(text).split())
        return bool(toks & set(norm(card["word"]).split()))

    async def _perform(self, script) -> None:
        """Do one persona line, in the order it was written."""
        said = norm(" ".join(v for k, v in script if k == "say"))
        async with self.busy:
            for kind, val in script:
                if kind == "say":
                    self.mouth.begin()
                    await self.mouth.say(val)
                    await self.mouth.end_reply()
                elif kind == "sound" and val in CUES:
                    await self.mouth.play_pcm(CUES[val], "")
                elif kind == "card":
                    before = (self.room.card or {}).get("word")
                    self._show(val)
                    card = self.room.card or {}
                    # The animal introduces itself the instant it appears —
                    # "hav hav hav!" — from data, before any model word.
                    if card.get("word") == before or not card.get("cry"):
                        continue
                    self.mouth.begin()
                    await self.mouth.say(card["cry"] + "!")
                    await self.mouth.end_reply()
                elif kind == "star":
                    self.room.score += 1
                    self.wire.say({"type": "score", "score": self.room.score})
                    continue
                for _ in range(500):
                    if not self.mouth.speaking:
                        break
                    await asyncio.sleep(0.02)
            self.room.heard = ""
            self._interim, self._nudged = "", False   # our speech staled it
            if said:
                self._last_speech = said
                self._last_card = (self.room.card or {}).get("word")
            self.room.last_us = time.monotonic()
            self._mute_until = asyncio.get_running_loop().time() + 0.35

    def _show(self, word: str) -> None:
        word = (word or "").strip()
        # No picture repeats until the deck is exhausted — the model sometimes
        # picks a card it already showed; whether one is left is computable.
        current = (self.room.card or {}).get("word")
        if word in self.room.seen and word != current \
                and any(w["word"] not in self.room.seen for w in self.deck):
            word = self._unseen()
        found = next((w for w in self.deck if w["word"].lower() == word.lower()), None)
        if found is None:                     # it invented one; keep the picture
            return
        self.room.card = found
        self.room.tries = 0
        # A new card is a fresh question. Without this, the verdict of the LAST
        # card stayed True and _ensure_turn kept awarding stars and flipping
        # cards on every later line — stars for silence.
        self.room.verdict = None
        self.room.seen.add(found["word"])
        self.chatter.warm(found["word"])      # its lines are ready before needed
        self.wire.say({"type": "card", "emoji": found["emoji"],
                       "word": found["word"], "score": self.room.score})

    # ------------------------------------------------------------- ears in
    async def _partial(self, text: str) -> None:
        if self._deaf():
            return
        if text.strip():
            self.room.talking = True
            self.room.last_voice = time.monotonic()
            if text.strip() != self._interim:
                self._interim = text.strip()
                self._interim_at = self.room.last_voice
                self._nudged = False
            self.wire.say({"type": "hearing", "text": text})

    async def _final(self, text: str) -> None:
        if self._deaf() or not text.strip():
            return
        judged, when = self._judged
        if judged and norm(text) == judged and time.monotonic() - when < 2.0:
            return     # the recogniser settled on what we already judged
        self._interim, self._nudged = "", False
        self.room.heard = text.strip()
        card = self.room.card
        self.room.verdict = bool(card) and heard_it(
            self.room.heard, card["word"], card.get("also", []), ALL[self.lang])
        self.room.talking = False
        self.room.last_voice = time.monotonic()
        self.room.tries += 1
        self.wire.say({"type": "said", "text": self.room.heard,
                       "ok": self.room.verdict})
        if self.room.verdict and not self._thinking:
            # A right answer is rewarded NOW. No tick, no quiet gate, no model:
            # the reward is code's job, and a missed or late one is what makes
            # a child give up.
            self._thinking = True
            asyncio.ensure_future(self._celebrate())

    def feed(self, pcm: bytes) -> None:
        self.ears.feed(pcm)

    # ----------------------------------------------------------- the tick
    async def tick(self) -> None:
        """Ask the persona, but only into a silence."""
        while True:
            await asyncio.sleep(TICK)
            if self._thinking or self._deaf():
                continue
            now = time.monotonic()
            # A single syllable often never finalises: nudge the recogniser to
            # settle, and if it still will not, judge the grey text ourselves.
            if self._interim:
                stuck = now - self._interim_at
                if stuck > JUDGE_INTERIM_S:
                    text, self._interim = self._interim, ""
                    await self._final(text)
                    self._judged = (norm(text), now)   # drop its echo, once
                elif stuck > FLUSH_NUDGE_S and not self._nudged:
                    self._nudged = True
                    try:
                        self.ears.finalize()
                    except Exception:  # noqa: BLE001
                        pass
            quiet = now - self.room.last_voice
            since_us = now - self.room.last_us if self.room.last_us else 99.0
            if self.room.talking and quiet < MIN_QUIET:
                continue
            # something to react to, or a silence long enough to earn a nudge
            if self.room.heard and (now - self.room.last_voice) > 12.0:
                self.room.heard = ""      # too old to still be answering
            worth_asking = (self.room.heard
                            or self.room.card is None
                            or quiet >= NUDGE_AFTER)
            # A settled answer already waited out the recogniser's endpointing;
            # making her sit through another silence gate reads as being slow.
            need_quiet = HEARD_QUIET if self.room.heard else MIN_QUIET
            if not worth_asking or quiet < need_quiet or since_us < MIN_SINCE_US:
                continue
            self._thinking = True
            try:
                await self._ask(quiet, since_us)
            finally:
                self._thinking = False

    async def _ask(self, quiet: float, since_us: float) -> None:
        if self.llm is None:          # model disabled: the game plays itself
            await self._fallback()
            return
        state = persona.state_text(
            self.lang, card=self.room.card, score=self.room.score,
            heard=self.room.heard, talking=self.room.talking, quiet_s=quiet,
            since_us=since_us, tries=self.room.tries, seen=self.room.seen,
            deck=self.deck, last_said=self.last_said,
            verdict=self.room.verdict)
        # Speak the first clause while the rest is still being written. This is
        # the whole reason the phone agent feels instant, and waiting for the
        # full line before making a sound was costing about a second per turn.
        # And the model gets FIRST_SOUND_S to produce that clause; after that a
        # prepared or canned line goes out instead — a child never waits for it.
        out, spoken_upto, started = [], 0, False
        saystream = persona.SayStream()   # the "say" string, as it arrives
        deadline = time.monotonic() + FIRST_SOUND_S
        it = self.llm.stream([{"role": "user", "text": state}],
                             system=persona.system(self.lang)).__aiter__()
        try:
            while True:
                try:
                    if started:
                        piece = await it.__anext__()
                    else:
                        piece = await asyncio.wait_for(
                            it.__anext__(),
                            max(0.05, deadline - time.monotonic()))
                except StopAsyncIteration:
                    break
                out.append(piece)
                saystream.feed(piece)
                if started:
                    continue
                sofar = saystream.text
                cut = _first_clause(sofar)
                if cut and not persona.is_narration(sofar[:cut]) \
                        and not self._leaks_answer(sofar[:cut]):
                    head, _ = persona.parse(sofar[:cut])
                    if any(k == "say" for k, _ in head) and not any(
                            k in ("star", "card") for k, _ in head):
                        started = True
                        spoken_upto = cut
                        asyncio.ensure_future(self._perform(head))
        except asyncio.TimeoutError:
            await _drop(it)
            print("[fallback] model too slow", flush=True)
            await self._fallback()
            return
        except Exception as exc:  # noqa: BLE001
            print("persona:", repr(exc), flush=True)
            await self._fallback()
            return
        think, line = persona.unwrap("".join(out).strip())
        if saystream.text and not line:
            line = saystream.text.strip()   # the envelope broke after say did
        if think:
            print(f"[think] {think}", flush=True)
        if started:
            # The head is already out loud; the rest still gets the same vetting
            # word by word — narration and the card's word are dropped, the
            # marks survive, and _ensure_turn keeps every code-owned guarantee.
            # (spoken_upto indexes saystream's text, so slice that, not line.)
            rest = saystream.text[spoken_upto:].strip()
            script, _ = persona.parse(rest)
            script = [(k, v) for k, v in script if k != "say"
                      or not (persona.is_narration(v) or self._leaks_answer(v))]
            script = self._ensure_turn(script)
            print(f"[persona] {line}", flush=True)
            self.last_said = line
            if script:
                await self._perform(script)
            return
        self.asked += 1
        if persona.is_narration(line) and not line.upper().startswith("PASS"):
            # It described the room instead of talking to her. Say nothing —
            # unless she just spoke: a canned answer beats being ignored.
            print(f"[narration dropped] {line}", flush=True)
            if self.room.heard:
                await self._fallback()
            else:
                self.passed += 1
            return
        script, passed = persona.parse(line)
        # A line that would hand her the answer loses those words and only
        # those; its marks and the code-owned guarantees survive.
        script = [(k, v) for k, v in script
                  if k != "say" or not self._leaks_answer(v)]
        says = norm(" ".join(v for k, v in script if k == "say"))
        if (says and says == self._last_speech and not self.room.heard
                and (self.room.card or {}).get("word") == self._last_card):
            # "Hop, at!" four times in a row teaches her to stop listening.
            # Same words, same card, nothing new from her: vary it ourselves.
            print(f"[repeat dropped] {line}", flush=True)
            await self._fallback()
            return
        said_something = self.room.heard
        if passed or not script:
            # Silence is a fine answer to silence. It is NOT a fine answer to a
            # child who just spoke: being ignored is the one thing that stops
            # her trying. Ask once more, saying so.
            if said_something:
                line = await self._retry(state)
                if persona.is_narration(line):
                    line = ""             # narrated twice; the canned line wins
                script, passed = persona.parse(line)
                script = [(k, v) for k, v in script
                          if k != "say" or not self._leaks_answer(v)]
            if passed or not script:
                if said_something:        # she will not be ignored twice
                    await self._fallback()
                else:
                    self.passed += 1
                return
        if not any(k == "say" for k, _ in script):
            # A card flipping over in silence reads as a glitch, not a turn.
            if self.room.verdict or self.room.heard:
                await self._fallback()    # her answer still gets its due
            else:
                self.passed += 1
            return
        script = self._ensure_turn(script)
        print(f"[persona] {line}", flush=True)
        self.last_said = line
        await self._perform(script)

    async def _celebrate(self) -> None:
        """Confetti, a prepared line, the star, the next picture — fired straight
        from the final transcript. The persona never sits on this path; its
        prepared per-card lines (or the canned ones) carry the words."""
        try:
            card = self.room.card
            nxt = self._unseen()
            script = [("sound", "confetti"),
                      ("say", self.chatter.line("yes", card["word"])),
                      ("star", ""),
                      ("card", nxt),
                      ("say", self.chatter.line("ask", nxt))]
            self.last_said = " ".join(v for k, v in script if k == "say")
            print(f"[celebrate] {self.last_said}", flush=True)
            await self._perform(script)
        finally:
            self._thinking = False

    async def _fallback(self) -> None:
        """The model is slow, down, or switched off. The game does not wait:
        a prepared or canned line goes out now, and the code-owned guarantees
        (star, confetti, next card) are kept exactly as they would be."""
        card = self.room.card
        if card is None:
            self._show(self._unseen())
            card = self.room.card
            script = [("say", self.chatter.line("ask", card["word"]))]
        elif self.room.verdict:
            script = self._ensure_turn(
                [("say", self.chatter.line("yes", card["word"]))])
            nxt = next((v for k, v in script if k == "card"), None)
            if nxt:
                script.append(("say", self.chatter.line("ask", nxt)))
        elif self.room.heard:
            script = [("say", self.chatter.line("again", card["word"]))]
        else:
            script = [("say", self.chatter.line("ask", card["word"]))]
        self.last_said = " ".join(v for k, v in script if k == "say")
        print(f"[fallback] {self.last_said}", flush=True)
        await self._perform(script)

    def _unseen(self) -> str:
        """A picture she has not had yet, or any other one once they run out."""
        import random
        left = [w["word"] for w in self.deck
                if w["word"] not in self.room.seen]
        if not left:
            self.room.seen = {self.room.card["word"]} if self.room.card else set()
            left = [w["word"] for w in self.deck
                    if not self.room.card or w["word"] != self.room.card["word"]]
        return random.choice(left)

    def _ensure_turn(self, script: list) -> list:
        """A right answer always earns the star AND the next picture.

        The persona decides how to celebrate; it does not get to decide whether
        she is rewarded, or whether the game moves on. Leaving her on a card she
        has already named — which it did, three times running — is the one
        failure that makes a two-year-old give up.
        """
        if not self.room.verdict:
            return script
        if not any(k == "star" for k, _ in script):
            script.append(("star", ""))
        if not any(k == "sound" for k, _ in script):
            script.insert(0, ("sound", "confetti"))
        if not any(k == "card" for k, _ in script):
            script.append(("card", self._unseen()))
        return script

    async def _retry(self, state: str) -> str:
        nudge = ("Ребёнок только что говорил. Ответь ему — PASS сейчас нельзя."
                 if self.lang == "ru" else
                 "Çocuk az önce konuştu. Ona cevap ver — şimdi PASS olmaz.")
        out = []
        try:
            async for piece in self.llm.stream(
                    [{"role": "user", "text": state + "\n\n" + nudge}],
                    system=persona.system(self.lang)):
                out.append(piece)
        except Exception:  # noqa: BLE001
            return ""
        return persona.unwrap("".join(out).strip())[1]

    async def close(self) -> None:
        ch = getattr(self, "chatter", None)
        print(f"asked {self.asked}, passed {self.passed}"
              + (f", lines: {ch.used_llm} written / {ch.used_canned} canned"
                 if ch else ""), flush=True)
        for name in ("mouth", "ears", "tts", "chatter", "wire"):
            obj = getattr(self, name, None)   # start() may have died early
            fn = getattr(obj, "close", None) or getattr(obj, "aclose", None)
            if fn is None:
                continue
            try:
                await fn()
            except Exception:  # noqa: BLE001
                pass


async def handle(ws) -> None:
    import urllib.parse as _up
    req = getattr(ws, "request", None)
    q = _up.parse_qs(_up.urlparse(req.path if req else "").query)
    game = Game(ws, (q.get("lang") or ["tr"])[0])
    ticker = None
    try:
        await game.start()
        await ws.send(json.dumps({"type": "ready"}))
        game._show(DECKS[game.lang][0]["word"])   # a picture is up before we speak
        cry = (game.room.card or {}).get("cry")
        if cry:                                   # it introduces itself at once
            asyncio.ensure_future(game._perform([("say", cry + "!")]))
        ticker = asyncio.get_running_loop().create_task(game.tick())
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                game.feed(bytes(msg))
            elif msg == "next":
                game.room.heard = ""
                game.room.verdict = None   # the old card's verdict dies with it
                game.room.card = None      # let the persona choose the next one
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as exc:  # noqa: BLE001
        print("session error:", repr(exc), flush=True)
    finally:
        if ticker:
            ticker.cancel()
        await game.close()


def http(connection, request):
    path = (request.path or "/").split("?")[0]
    if path == "/health":
        return connection.respond(HTTPStatus.OK, "ok\n")
    if path in ("/", "/index.html"):
        body = (HERE / "web" / "index.html").read_bytes()
        return Response(HTTPStatus.OK, "OK",
                        Headers([("Content-Type", "text/html; charset=utf-8"),
                                 ("Content-Length", str(len(body))),
                                 ("Cache-Control", "no-store")]), body)
    return None


async def main() -> None:
    async with serve(handle, "0.0.0.0", PORT, process_request=http,
                     server_header=None, max_size=2 ** 20):
        print(f"söyle → http://localhost:{PORT}        (Türkçe)\n"
              f"       → http://localhost:{PORT}/?lang=ru  (по-русски)",
              flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
