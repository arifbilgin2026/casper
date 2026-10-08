"""The lines the game says, written fresh each time by a small model.

Three canned prompts become "what is it? what is it? what is it?" within a
minute, which is how a two-year-old learns to stop listening. This writes a new
one for each picture — and knows what the picture IS, so it can be about the
elephant rather than about nothing.

The rule that shapes the whole file: **a child never waits for a model.** Every
line is prepared in the background while she is still answering the previous
card, and if it is not ready the canned line is used. The game runs at full
speed with the model switched off entirely.
"""
from __future__ import annotations

import asyncio
import random
from typing import Dict, List, Optional

from . import persona

SYSTEM = {
    "tr": ("2-4 yaşındaki bir çocukla konuşan sıcak, neşeli bir sesin. "
           "SADECE Türkçe. Tek cümle, en fazla sekiz kelime, konuşma dili. "
           "Emoji yok, tırnak yok, açıklama yok — sadece söylenecek cümle."),
    "ru": ("Ты тёплый весёлый голос, который говорит с ребёнком 2-4 лет. "
           "ТОЛЬКО по-русски. Одно предложение, максимум восемь слов, "
           "разговорно. Без эмодзи, без кавычек, без пояснений — только "
           "сама фраза."),
}

TASK = {
    "ask": {
        "tr": "Çocuğa resimdeki '{w}' kelimesini söylet. Kelimeyi SEN SÖYLEME.",
        "ru": "Попроси ребёнка назвать картинку: '{w}'. САМО СЛОВО НЕ НАЗЫВАЙ.",
    },
    "yes": {
        "tr": "Çocuk '{w}' dedi ve doğru. Onu kutla ve {w} hakkında çok kısa, "
              "sevimli bir şey ekle.",
        "ru": "Ребёнок сказал '{w}' — правильно! Похвали и добавь очень "
              "коротко что-нибудь милое про {w}.",
    },
    "again": {
        "tr": "Çocuk '{w}' demeye çalıştı ama tutturamadı. Cesaretlendir, "
              "tekrar denemesini iste. Kelimeyi SÖYLEME.",
        "ru": "Ребёнок пытался сказать '{w}', но не вышло. Подбодри и попроси "
              "попробовать ещё. САМО СЛОВО НЕ НАЗЫВАЙ.",
    },
}


class Chatter:
    """Writes lines ahead of time. Never blocks the game."""

    def __init__(self, llm, lang: str, canned: dict, log=lambda m: None) -> None:
        self._llm = llm
        self._lang = lang if lang in SYSTEM else "tr"
        self._canned = canned
        self._log = log
        self._ready: Dict[str, List[str]] = {}
        self._jobs: Dict[str, asyncio.Task] = {}
        self.used_llm = 0
        self.used_canned = 0

    # ------------------------------------------------------------ public
    def warm(self, word: str) -> None:
        """Start writing this card's three lines. Fire and forget."""
        if self._llm is None:          # model disabled: canned lines only
            return
        for kind in ("ask", "yes", "again"):
            key = f"{kind}:{word}"
            if key in self._ready or key in self._jobs:
                continue
            self._jobs[key] = asyncio.ensure_future(self._write(kind, word, key))

    def line(self, kind: str, word: str) -> str:
        """The line to say RIGHT NOW. Prepared if it is ready, canned if not."""
        got = self._ready.get(f"{kind}:{word}")
        if got:
            self.used_llm += 1
            return got.pop(0) if len(got) > 1 else got[0]
        self.used_canned += 1
        return random.choice(self._canned[kind])

    async def aclose(self) -> None:
        for t in self._jobs.values():
            t.cancel()

    # ----------------------------------------------------------- internal
    async def _write(self, kind: str, word: str, key: str) -> None:
        try:
            text = await asyncio.wait_for(self._one(kind, word), timeout=8.0)
        except Exception as exc:  # noqa: BLE001
            self._log(f"[chatter] {key}: {exc!r}")
            text = None
        finally:
            self._jobs.pop(key, None)
        if text:
            self._ready[key] = [text]

    async def _one(self, kind: str, word: str) -> Optional[str]:
        msg = TASK[kind][self._lang].format(w=word)
        out = []
        async for piece in self._llm.stream(
                [{"role": "user", "text": msg}], system=SYSTEM[self._lang]):
            out.append(piece)
        line = "".join(out).strip().strip('"').strip("«»").split("\n")[0]
        # A model that ignores "don't say the word" would hand the child the
        # answer, and one that echoes its task ("Cesaretlendir, tekrar
        # denemesini iste") would read the brief at her. Drop both rather than
        # correct them; the canned line is fine.
        if kind in ("ask", "again") and word.lower() in line.lower():
            return None
        if persona.is_narration(line):
            return None
        return line if 0 < len(line) <= 120 else None
