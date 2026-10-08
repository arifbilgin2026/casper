"""The persona: one character who runs the whole game.

Not a line-writer called with a job. It is told who it is, shown the state of
the room every couple of seconds, and asked one question: anything to say or do?
Most of the time the honest answer is no, and `PASS` is a first-class reply — a
toddler needs silence to think, and a voice that fills every gap teaches her to
stop listening.

It answers in ONE line that mixes words, sounds and actions:

    Молодец! ♪yes♪ [star] А это кто? [card:лягушка]

Everything in that line happens in the order it is written, so the picture turns
over at the point in the sentence where she would expect it to.
"""
from __future__ import annotations

import json
import re
from typing import List, Tuple

SOUNDS = ("confetti", "yes", "star", "again", "hello")
MARK = re.compile(r"♪\s*([a-z]+)\s*♪|\[\s*([a-z]+)\s*(?::\s*([^\]]+?))?\s*\]",
                  re.IGNORECASE)
#: Anything bracket- or note-shaped that we did NOT recognise. It must never be
#: read out: the model will sometimes invent [нечто:х] or leave a ♪ding unclosed,
#: and a child hearing "skobka necto" is worse than a missing sound. An unclosed
#: ♪ takes its word with it — "ding" alone is as baffling as the mark.
LEFTOVER = re.compile(r"\[[^\]]*\]|♪[^♪]*♪|♪\S*|[♪\[\]]")

WHO = {
    "tr": ("Sen bir yetişkinsin, 2-4 yaşındaki bir çocuğun yanında oturuyor ve "
           "ona resimli kartlar gösteriyorsun. Sıcak, neşeli, sabırlısın. Çok "
           "kısa konuşursun — bir cümle. Çocuğa düşünmesi için sessizlik "
           "bırakırsın."),
    "ru": ("Ты взрослый, сидишь рядом с ребёнком 2-4 лет и показываешь ему "
           "картинки. Тёплый, весёлый, терпеливый. Говоришь очень коротко — "
           "одно предложение. Оставляешь ребёнку тишину, чтобы подумать."),
}

HOW = {
    "tr": """
NASIL CEVAP VERİRSİN
Tek satır JSON yazarsın, başka hiçbir şey yazmazsın:
  {"think": "kendine kısa not, en fazla 8 kelime", "say": "SESLİ söyleyeceğin cümle"}

"say" içine şunları da koyabilirsin:
  ♪confetti♪ ♪yes♪ ♪again♪ ♪hello♪   kısa bir ses çalar
  [card:kelime]                   ekranda o resmi açar
  [star]                          bir yıldız verir
Çocuk SESSİZSE ve sen az önce konuştuysan: {"think": "düşünsün", "say": "PASS"}

"say" HOPARLÖRDEN ÇIKAR — çocuk her kelimesini duyar. Düşüncen, planın,
kurallar SADECE "think" içine. Bunlar "say" içine ASLA giremez:
  "Çocuk söyledi, cevap vermem lazım"   "Cevabını bekliyorum"   "Dinliyorum"
  "Cesaretlendir, kelimeyi söyleme"      "Kutla ve yeni kart aç"
İki örnek (biçim için — sözleri HİÇBİR ZAMAN kopyalama, ekrandaki karta göre
kendin yaz):
  {"think": "doğru dedi, kutla, yeni kart", "say": "♪confetti♪ Aferin! [star] Peki bu ne? [card:kedi]"}
  {"think": "ikinci deneme", "say": "Az kaldı! Bir daha dene?"}
İpucu verirsen EKRANDAKİ kartla ilgili olsun, başka hayvanla değil.
Aynı cümleyi arka arkaya tekrar etme — her seferinde başka türlü söyle.

EN ÖNEMLİ İKİ KURAL
1. Çocuk bir şey söylediyse MUTLAKA cevap ver. O an PASS YASAK.
2. Her cevabında KELİME olsun. Sadece [card:...] yazıp sessizce kartı
   değiştirme — çocuk ne olduğunu anlamaz.

DOĞRU MU DEĞİL Mİ — SENİN İÇİN ZATEN KARARLAŞTIRILDI
Çocuğun söylediğinin yanında bir not var. Ona tamamen güven, kendin kontrol
etme.
  "BU DOĞRU"      → kutla, [star] ver, ♪confetti♪ çal ve [card:...] ile yeni kart
                     aç. Bu zorunlu.
  "bu kelime DEĞİL" → cesaretlendir, kelimeyi söyleme, kartı değiştirme.

DİĞER KURALLAR
- Bir cümle, en fazla sekiz kelime. Emoji yok, tırnak yok.
- Ekrandaki kelimeyi SEN SÖYLEME — çocuk söyleyecek.
- Çocuk doğru söylediyse: kutla, [star] ver, ♪yes♪ çal, sonra [card:yeni] aç.
- Yanlış ya da anlaşılmadıysa: cesaretlendir, kelimeyi söyleme.
- Üç kez denediyse: kelimeyi sen söyle ve yeni kart aç.
- Çocuk sessizse ve yeni konuştuysan: PASS. Bekle.
- Daha önce gösterdiğin kartları tekrar açma.
- Ses çıkarmak serbest: "hop", "vaa", "cik cik" gibi. Çocuklar buna bayılır.
- Ekranda (sesi: ...) yazıyorsa o sesi ipucu yap: sesi taklit et, sonra sor.
""",
    "ru": """
КАК ТЫ ОТВЕЧАЕШЬ
Пишешь одну строку JSON и больше ничего:
  {"think": "короткая заметка себе, максимум 8 слов", "say": "фраза ВСЛУХ"}

Внутрь "say" можно вставить:
  ♪confetti♪ ♪yes♪ ♪again♪ ♪hello♪   проиграет короткий звук
  [card:слово]                    покажет эту картинку
  [star]                          даст звёздочку
Ребёнок молчит, а ты только что говорил: {"think": "пусть думает", "say": "PASS"}

"say" ЗВУЧИТ ИЗ ДИНАМИКА — ребёнок слышит каждое слово. Мысли, план, правила —
ТОЛЬКО в "think". В "say" это попасть НЕ может:
  "Ребёнок сказал, надо ответить"   "Жду ответа"   "Я слушаю"
  "Подбодри, слово не называй"      "Похвали и покажи новую"
Два примера (только формат — слова НИКОГДА не копируй, пиши сам про карточку
на экране):
  {"think": "верно, хвалю, новая картинка", "say": "♪confetti♪ Молодец! [star] А это кто? [card:кошка]"}
  {"think": "вторая попытка", "say": "Почти! Скажи ещё раз?"}
Подсказка — только про карточку НА ЭКРАНЕ, не про другое животное.
Не повторяй одну и ту же фразу подряд — каждый раз говори по-новому.

ДВА ГЛАВНЫХ ПРАВИЛА
1. Если ребёнок что-то сказал — ОБЯЗАТЕЛЬНО ответь. PASS тогда ЗАПРЕЩЁН.
2. В каждом ответе должны быть СЛОВА. Нельзя написать только [card:...]
   и молча поменять картинку — ребёнок не поймёт, что произошло.

ВЕРНО ИЛИ НЕТ — УЖЕ РЕШЕНО ЗА ТЕБЯ
Рядом с тем, что сказал ребёнок, стоит пометка. Доверяй ей полностью, сам
не проверяй.
  "ЭТО ПРАВИЛЬНО"  → похвали, дай [star], сыграй ♪confetti♪ и покажи новую
                      картинку через [card:...]. Это обязательно.
  "НЕ то слово"     → подбодри, слово не называй, картинку не меняй.

ОСТАЛЬНЫЕ ПРАВИЛА
- Одно предложение, максимум восемь слов. Без эмодзи и кавычек.
- САМО слово с картинки не называй — его должен сказать ребёнок.
- Сказал правильно: похвали, дай [star], сыграй ♪yes♪, потом [card:новое].
- Ошибся или непонятно: подбодри, слово не называй.
- Если попробовал три раза: назови слово сам и покажи новую картинку.
- Ребёнок молчит, а ты только что говорил: PASS. Подожди.
- Не показывай картинки, которые уже были.
- Смешные звуки приветствуются: "оп", "ух ты", "кап-кап". Дети это любят.
- Если на экране есть (звук: ...) — используй его как подсказку: изобрази
  звук, потом спроси.
""",
}


def state_text(lang: str, *, card, score, heard, talking, quiet_s,
               since_us, tries, seen, deck, last_said="", verdict=None) -> str:
    """What the persona is shown. Compact on purpose — it is sent every tick."""
    L = lang == "ru"
    if card:
        on = f"{card['emoji']} {card['word']}"
        if card.get("cry"):
            on += (f" (звук: {card['cry']})" if L else f" (sesi: {card['cry']})")
    else:
        on = "нет" if L else "yok"
    # The verdict is computed, not guessed: whether the word matches is a
    # string question with a right answer, and a model is the wrong tool for it.
    if heard:
        mark = {True: (" — ЭТО ПРАВИЛЬНО" if L else " — BU DOĞRU"),
                False: (" — это НЕ то слово" if L else " — bu kelime DEĞİL"),
                None: ""}[verdict]
        said = f"{heard}{mark}"
    else:
        said = "—"
    if talking:
        live = "ребёнок ГОВОРИТ сейчас" if L else "çocuk ŞU AN konuşuyor"
    elif heard:
        # Never tell her she is quiet while her answer is sitting unanswered.
        live = ("только что ответил, ждёт тебя" if L
                else "az önce cevap verdi, seni bekliyor")
    else:
        live = f"молчит {quiet_s:.1f}с" if L else f"{quiet_s:.1f}sn sessiz"
    left = [w["word"] for w in deck if w["word"] not in seen][:40]
    if L:
        mine = f"Ты сказал в прошлый раз: {last_said}\n" if last_said else ""
        return (mine + f"На экране: {on}\nЗвёздочек: {score}\nПопыток на этой карточке: {tries}\n"
                f"Ребёнок сказал: {said}\nСейчас: {live}\n"
                f"Ты говорил {since_us:.1f}с назад\nУже показывали: "
                f"{', '.join(sorted(seen)) or 'ничего'}\nМожно показать: {', '.join(left)}")
    mine = f"Sen geçen sefer dedin: {last_said}\n" if last_said else ""
    return (mine + f"Ekranda: {on}\nYıldız: {score}\nBu kartta deneme: {tries}\n"
            f"Çocuk dedi: {said}\nŞu an: {live}\n"
            f"Sen {since_us:.1f}sn önce konuştun\nGösterilenler: "
            f"{', '.join(sorted(seen)) or 'hiç'}\nGösterilebilir: {', '.join(left)}")


def system(lang: str) -> str:
    lang = lang if lang in WHO else "tr"
    return WHO[lang] + "\n" + HOW[lang]


#: Phrases that mean the model described the situation instead of speaking to
#: her. Reciting the brief at a two-year-old is worse than silence, so these are
#: dropped rather than cleaned up.
NARRATION = (
    "ребёнок", "ребенок", "жду", "слушаю", "отвечу", "похвалю", "надо ответить",
    "çocuk ", "bekliyorum", "dinliyorum", "cevap vermem", "söyleyeceğim",
    "lazım", "pass",
    # The model also echoes its own RULES ("Cesaretlendir, kelimeyi söyleme,
    # kartı değiştirme" was read to a child verbatim). Imperatives addressed to
    # the agent are never speech for her.
    "cesaretlendir", "kutla", "kelimeyi", "kartı", "tutturamadı", "denemesini",
    "подбодри", "похвали", "попроси", "не называй", "не меняй",
)


def is_narration(line: str) -> bool:
    low = (line or "").lower()
    return any(p in low for p in NARRATION)


def parse(line: str) -> Tuple[List[Tuple[str, str]], bool]:
    """Split one persona line into an ordered script.

    Returns [("say", text) | ("sound", name) | ("card", word) | ("star", "")]
    and whether it was a PASS. Anything we do not recognise is dropped rather
    than spoken: a stray bracket must never reach the child's ears.
    """
    line = (line or "").strip()
    if not line or line.upper().startswith("PASS"):
        return [], True
    script: List[Tuple[str, str]] = []
    pos = 0
    for m in MARK.finditer(line):
        words = _clean(line[pos:m.start()])
        if words:
            script.append(("say", words))
        pos = m.end()
        sound, action, arg = m.group(1), m.group(2), m.group(3)
        if sound and sound.lower() in SOUNDS:
            script.append(("sound", sound.lower()))
        elif action:
            a = action.lower()
            if a == "card" and arg:
                script.append(("card", arg.strip()))
            elif a == "star":
                script.append(("star", ""))
            elif a in SOUNDS:                      # [yes] written as an action
                script.append(("sound", a))
        # anything else: dropped
    tail = _clean(line[pos:])
    if tail:
        script.append(("say", tail))
    return script, False


def _clean(text: str) -> str:
    """Strip marks we did not understand, and tidy the spacing they leave."""
    return re.sub(r"\s{2,}", " ", LEFTOVER.sub(" ", text)).strip()


# --- the think/say envelope -------------------------------------------------
# The model answers {"think": "...", "say": "..."}. Inner voice has its own key
# so the engine never has to GUESS what was meant for the child: only "say"
# reaches the mouth, "think" goes to the log. Parse strictly, fail silently —
# a broken envelope means a canned line, never JSON read aloud.

_SAY_RE = re.compile(r'"say"\s*:\s*"((?:[^"\\]|\\.)*)"')


def unwrap(raw: str) -> Tuple[str, str]:
    """(think, say) out of one model reply.

    Tolerates code fences and trailing junk. A bare un-JSON line is treated as
    say (an older model, or one that forgot the envelope). Something that LOOKS
    structured but cannot be read yields silence rather than noise.
    """
    raw = (raw or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-z]*\s*|\s*```$", "", raw).strip()
    if "{" in raw:
        try:
            obj = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
            if isinstance(obj, dict):
                return (str(obj.get("think") or "").strip(),
                        str(obj.get("say") or "").strip())
        except Exception:  # noqa: BLE001
            pass
    m = _SAY_RE.search(raw)
    if m:
        try:
            return "", json.loads(f'"{m.group(1)}"').strip()
        except Exception:  # noqa: BLE001
            return "", m.group(1).strip()
    if "{" in raw or '"say"' in raw:
        return "", ""                  # structured but broken: say nothing
    return "", raw                     # a bare line; the say is the line


_UNESC = {"n": " ", "t": " ", "r": " "}


class SayStream:
    """Pulls the "say" string out of a STREAMING reply, as it arrives.

    Speaking the first clause before the reply is finished is the biggest
    latency win in the game; the JSON envelope must not take it away. Feed it
    every piece; `.text` grows as the say string does and stops at its
    closing quote.
    """

    def __init__(self) -> None:
        self._buf = ""
        self.text = ""
        self.done = False
        self._in = False
        self._esc = False
        self._uni = ""        # pending \\uXXXX hex digits, "" when not in one

    def feed(self, piece: str) -> None:
        if self.done:
            return
        if not self._in:
            self._buf += piece
            m = re.search(r'"say"\s*:\s*"', self._buf)
            if not m:
                return
            self._in = True
            tail, self._buf = self._buf[m.end():], ""
            self._take(tail)
        else:
            self._take(piece)

    def _take(self, s: str) -> None:
        for c in s:
            if self._uni != "":
                self._uni += c
                if len(self._uni) == 5:          # "u" + 4 hex digits
                    try:
                        self.text += chr(int(self._uni[1:], 16))
                    except ValueError:
                        pass
                    self._uni = ""
                continue
            if self._esc:
                self._esc = False
                if c == "u":
                    self._uni = "u"
                else:
                    self.text += _UNESC.get(c, c)
                continue
            if c == "\\":
                self._esc = True
            elif c == '"':
                self.done = True
                return
            else:
                self.text += c
