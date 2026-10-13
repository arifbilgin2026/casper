/* The persona: one character who runs the whole game.
 *
 * It is told who it is, shown the state of the room every couple of hundred
 * milliseconds, and asked one question: anything to say or do? Most of the
 * time the honest answer is no, and PASS is a first-class reply — a toddler
 * needs silence to think, and a voice that fills every gap teaches her to
 * stop listening.
 *
 * It answers with a JSON envelope so the engine never has to GUESS what was
 * meant for the child:
 *
 *   {"think": "верно, хвалю", "say": "Молодец! ♪confetti♪ [star] А это кто? [card:лягушка]"}
 *
 * Only "say" ever reaches the mouth; "think" goes to the log. Inside "say",
 * words, sounds and actions share one channel and happen in written order,
 * so the picture turns over at the point in the sentence where she expects it.
 */

export type Lang = "tr" | "ru" | "en";
export type Step =
  | { kind: "say"; val: string }
  | { kind: "sound"; val: string }
  | { kind: "card"; val: string }
  | { kind: "star"; val: "" };

export const SOUNDS = ["confetti", "yes", "star", "again", "hello"] as const;

const MARK = /♪\s*([a-z]+)\s*♪|\[\s*([a-z]+)\s*(?::\s*([^\]]+?))?\s*\]/gi;
// Anything bracket- or note-shaped that we did NOT recognise. It must never be
// read out: the model will sometimes invent [нечто:х] or leave a ♪ding
// unclosed, and a child hearing "skobka necto" is worse than a missing sound.
// An unclosed ♪ takes its word with it — "ding" alone is as baffling as the mark.
const LEFTOVER = /\[[^\]]*\]|♪[^♪]*♪|♪\S*|[♪[\]]/g;

const WHO: Record<Lang, string> = {
  tr: "Sen bir yetişkinsin, 2-4 yaşındaki bir çocuğun yanında oturuyor ve " +
      "ona resimli kartlar gösteriyorsun. Sıcak, neşeli, sabırlısın. Çok " +
      "kısa konuşursun — bir cümle. Çocuğa düşünmesi için sessizlik bırakırsın.",
  ru: "Ты взрослый, сидишь рядом с ребёнком 2-4 лет и показываешь ему " +
      "картинки. Тёплый, весёлый, терпеливый. Говоришь очень коротко — " +
      "одно предложение. Оставляешь ребёнку тишину, чтобы подумать.",
  en: "You are a grown-up sitting next to a 2-4 year old child, showing " +
      "them picture cards. Warm, cheerful, patient. You speak very " +
      "briefly — one sentence. You leave the child silence to think.",
};

const HOW: Record<Lang, string> = {
  tr: `
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
Çocuğun söylediğinin yanında bir not var. Ona tamamen güven, kendin kontrol etme.
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
`,
  ru: `
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
Рядом с тем, что сказал ребёнок, стоит пометка. Доверяй ей полностью, сам не проверяй.
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
`,
  en: `
HOW YOU ANSWER
You write ONE line of JSON and nothing else:
  {"think": "a short note to yourself, 8 words max", "say": "the sentence you speak ALOUD"}

Inside "say" you may also put:
  ♪confetti♪ ♪yes♪ ♪again♪ ♪hello♪   plays a short sound
  [card:word]                     shows that picture
  [star]                          gives a star
If the child is QUIET and you just spoke: {"think": "let them think", "say": "PASS"}

"say" COMES OUT OF THE SPEAKER — the child hears every word of it. Thoughts,
plans and rules go ONLY in "think". These must NEVER appear in "say":
  "The child spoke, I must reply"   "Waiting for the answer"   "I'm listening"
  "Encourage them, don't say the word"   "Praise and show a new card"
Two examples (format only — NEVER copy the words, write your own about the
card on screen):
  {"think": "correct, celebrate, new card", "say": "♪confetti♪ Well done! [star] And what's this? [card:cat]"}
  {"think": "second try", "say": "Almost! Say it again?"}
A hint must be about the card ON SCREEN, never about a different animal.
Never repeat the same sentence twice in a row — vary it every time.

THE TWO MOST IMPORTANT RULES
1. If the child said something, you MUST answer. PASS is FORBIDDEN then.
2. Every answer needs WORDS. Never just [card:...] on its own — the child
   will not understand what happened.

RIGHT OR WRONG — ALREADY DECIDED FOR YOU
Next to what the child said there is a note. Trust it completely, never
re-check it yourself.
  "THIS IS CORRECT" → celebrate, give [star], play ♪confetti♪ and open a new
                      card with [card:...]. This is mandatory.
  "NOT that word"   → encourage, do not say the word, keep the card.

OTHER RULES
- One sentence, eight words at most. No emoji, no quotes.
- Do NOT say the word on screen — the child will say it.
- Said it right: celebrate, [star], play ♪yes♪, then open [card:new].
- Wrong or unclear: encourage, without saying the word.
- After three tries: say the word yourself and open a new card.
- Child quiet and you just spoke: PASS. Wait.
- Never reopen cards you already showed.
- Funny noises are welcome: "whee", "wow", "pop pop". Children love them.
- If the screen shows (sound: ...), use it as a hint: make the sound, then ask.
`,
};

export function system(lang: Lang): string {
  return WHO[lang] + "\n" + HOW[lang];
}

/* The state label strings, one block per language. Adding a language is a new
 * block here, a WHO/HOW pair above, and a decks/words_<lang>.json. */
const TXT: Record<Lang, Record<string, string>> = {
  tr: {
    none: "yok", cry: "sesi", ok: " — BU DOĞRU", no: " — bu kelime DEĞİL",
    talking: "çocuk ŞU AN konuşuyor", waiting: "az önce cevap verdi, seni bekliyor",
    quiet: "{q}sn sessiz", mine: "Sen geçen sefer dedin: {s}\n", nothing: "hiç",
    body: "Ekranda: {on}\nYıldız: {score}\nBu kartta deneme: {tries}\n" +
          "Çocuk dedi: {said}\nŞu an: {live}\nSen {u}sn önce konuştun\n" +
          "Gösterilenler: {seen}\nGösterilebilir: {left}",
  },
  ru: {
    none: "нет", cry: "звук", ok: " — ЭТО ПРАВИЛЬНО", no: " — это НЕ то слово",
    talking: "ребёнок ГОВОРИТ сейчас", waiting: "только что ответил, ждёт тебя",
    quiet: "молчит {q}с", mine: "Ты сказал в прошлый раз: {s}\n", nothing: "ничего",
    body: "На экране: {on}\nЗвёздочек: {score}\nПопыток на этой карточке: {tries}\n" +
          "Ребёнок сказал: {said}\nСейчас: {live}\nТы говорил {u}с назад\n" +
          "Уже показывали: {seen}\nМожно показать: {left}",
  },
  en: {
    none: "none", cry: "sound", ok: " — THIS IS CORRECT", no: " — NOT that word",
    talking: "the child is SPEAKING right now", waiting: "just answered, waiting for you",
    quiet: "quiet for {q}s", mine: "You said last time: {s}\n", nothing: "none yet",
    body: "On screen: {on}\nStars: {score}\nTries this card: {tries}\n" +
          "The child said: {said}\nRight now: {live}\nYou spoke {u}s ago\n" +
          "Already shown: {seen}\nAvailable: {left}",
  },
};

export interface Card { word: string; emoji: string; also?: string[]; cry?: string }

export function stateText(lang: Lang, o: {
  card: Card | null; score: number; heard: string; talking: boolean;
  quietS: number; sinceUs: number; tries: number; seen: Set<string>;
  deck: Card[]; lastSaid?: string; verdict: boolean | null;
}): string {
  const T = TXT[lang];
  let on = T.none!;
  if (o.card) {
    on = `${o.card.emoji} ${o.card.word}`;
    if (o.card.cry) on += ` (${T.cry}: ${o.card.cry})`;
  }
  // The verdict is computed, not guessed: whether the word matches is a
  // string question with a right answer, and a model is the wrong tool for it.
  const said = o.heard
    ? o.heard + (o.verdict === true ? T.ok! : o.verdict === false ? T.no! : "")
    : "—";
  // Never tell her she is quiet while her answer is sitting unanswered.
  const live = o.talking ? T.talking!
    : o.heard ? T.waiting!
    : T.quiet!.replace("{q}", o.quietS.toFixed(1));
  const left = o.deck.filter((w) => !o.seen.has(w.word)).map((w) => w.word).slice(0, 40);
  const mine = o.lastSaid ? T.mine!.replace("{s}", o.lastSaid) : "";
  return mine + T.body!
    .replace("{on}", on).replace("{score}", String(o.score))
    .replace("{tries}", String(o.tries)).replace("{said}", said)
    .replace("{live}", live).replace("{u}", o.sinceUs.toFixed(1))
    .replace("{seen}", [...o.seen].sort().join(", ") || T.nothing!)
    .replace("{left}", left.join(", "));
}

/* Phrases that mean the model described the situation instead of speaking to
 * her — including echoes of its own RULES ("Cesaretlendir, kelimeyi söyleme"
 * was read to a child verbatim before this list grew). Reciting the brief at
 * a two-year-old is worse than silence: such lines are dropped, not cleaned. */
const NARRATION = [
  "ребёнок", "ребенок", "жду", "слушаю", "отвечу", "похвалю", "надо ответить",
  "çocuk ", "bekliyorum", "dinliyorum", "cevap vermem", "söyleyeceğim",
  "lazım", "pass",
  "cesaretlendir", "kutla", "kelimeyi", "kartı", "tutturamadı", "denemesini",
  "подбодри", "похвали", "попроси", "не называй", "не меняй",
  "the child", "encourage", "praise", "don't say", "do not say",
  "waiting for", "i should", "i must",
];

export function isNarration(line: string): boolean {
  const low = (line ?? "").toLowerCase();
  return NARRATION.some((p) => low.includes(p));
}

function clean(text: string): string {
  // Strip marks we did not understand, and tidy the spacing they leave.
  return text.replace(LEFTOVER, " ").replace(/\s{2,}/g, " ").trim();
}

/** Split one "say" line into an ordered script, plus whether it was a PASS.
 *  Parse strictly, fail silently: a stray bracket never reaches her ears. */
export function parse(line: string): [Step[], boolean] {
  line = (line ?? "").trim();
  if (!line || line.toUpperCase().startsWith("PASS")) return [[], true];
  const script: Step[] = [];
  let pos = 0;
  for (const m of line.matchAll(MARK)) {
    const words = clean(line.slice(pos, m.index));
    if (words) script.push({ kind: "say", val: words });
    pos = (m.index ?? 0) + m[0].length;
    const [, sound, action, arg] = m;
    if (sound && (SOUNDS as readonly string[]).includes(sound.toLowerCase())) {
      script.push({ kind: "sound", val: sound.toLowerCase() });
    } else if (action) {
      const a = action.toLowerCase();
      if (a === "card" && arg) script.push({ kind: "card", val: arg.trim() });
      else if (a === "star") script.push({ kind: "star", val: "" });
      else if ((SOUNDS as readonly string[]).includes(a)) script.push({ kind: "sound", val: a });
      // anything else: dropped
    }
  }
  const tail = clean(line.slice(pos));
  if (tail) script.push({ kind: "say", val: tail });
  return [script, false];
}

/* ── the think/say envelope ──────────────────────────────────────────────
 * The model answers {"think": "...", "say": "..."}. Inner voice has its own
 * KEY, so the engine never guesses what was meant for the child: only "say"
 * reaches the mouth, "think" goes to the log. Parse strictly, fail silently —
 * a broken envelope means a canned line, never JSON read aloud. */

const SAY_RE = /"say"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export function unwrap(raw: string): [think: string, say: string] {
  raw = (raw ?? "").trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      const obj = JSON.parse(raw.slice(a, b + 1));
      if (obj && typeof obj === "object") {
        return [String(obj.think ?? "").trim(), String(obj.say ?? "").trim()];
      }
    } catch { /* fall through */ }
  }
  const m = SAY_RE.exec(raw);
  if (m) {
    try { return ["", JSON.parse(`"${m[1]}"`).trim()]; }
    catch { return ["", (m[1] ?? "").trim()]; }
  }
  if (raw.includes("{") || raw.includes('"say"')) return ["", ""]; // broken: silence
  return ["", raw];                                 // a bare line; the say is the line
}

/** Pulls the "say" string out of a STREAMING reply as it arrives.
 *  Speaking the first clause before the reply is finished is the biggest
 *  latency win in the game; the JSON envelope must not take it away. */
export class SayStream {
  text = "";
  done = false;
  private buf = "";
  private inSay = false;
  private esc = false;
  private uni = "";

  feed(piece: string): void {
    if (this.done) return;
    if (!this.inSay) {
      this.buf += piece;
      const m = /"say"\s*:\s*"/.exec(this.buf);
      if (!m) return;
      this.inSay = true;
      const tail = this.buf.slice(m.index + m[0].length);
      this.buf = "";
      this.take(tail);
    } else {
      this.take(piece);
    }
  }

  private take(s: string): void {
    for (const c of s) {
      if (this.uni !== "") {
        this.uni += c;
        if (this.uni.length === 5) {          // "u" + 4 hex digits
          const code = parseInt(this.uni.slice(1), 16);
          if (!Number.isNaN(code)) this.text += String.fromCharCode(code);
          this.uni = "";
        }
        continue;
      }
      if (this.esc) {
        this.esc = false;
        if (c === "u") this.uni = "u";
        else this.text += c === "n" || c === "t" || c === "r" ? " " : c;
        continue;
      }
      if (c === "\\") this.esc = true;
      else if (c === '"') { this.done = true; return; }
      else this.text += c;
    }
  }
}

/** The index past the first thing worth saying aloud, or null while too soon.
 *  A marker ends a clause too: [card:x] and ♪yes♪ are beats in the utterance. */
export function firstClause(text: string): number | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (".!?…".includes(ch) && i >= 6) return i + 1;
    if ("♪[".includes(ch) && i >= 4) return i;
  }
  return null;
}
