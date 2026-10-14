/* Lines written AHEAD of the moment they are needed.
 *
 * The rule that shapes this file: a child never waits for a model. Every
 * card's three lines (ask / yes / again) start being written the moment the
 * card is dealt, while she is still looking at it; when the game needs one
 * RIGHT NOW it takes the prepared line if it is ready and the canned line
 * from the deck file if it is not. The game runs at full speed with the
 * model switched off entirely.
 */
import type { Brain } from "./llm.js";
import { isNarration } from "./persona.js";
import type { Lang } from "./persona.js";

type Kind = "ask" | "yes" | "again";

const SYSTEM: Record<Lang, string> = {
  tr: "2-4 yaşındaki bir çocukla konuşan sıcak, neşeli bir sesin. SADECE " +
      "Türkçe. Tek cümle, en fazla sekiz kelime, konuşma dili. Emoji yok, " +
      "tırnak yok, açıklama yok — sadece söylenecek cümle.",
  ru: "Ты тёплый весёлый голос, который говорит с ребёнком 2-4 лет. ТОЛЬКО " +
      "по-русски. Одно предложение, максимум восемь слов, разговорно. Без " +
      "эмодзи, без кавычек, без пояснений — только сама фраза.",
  en: "You are a warm, cheerful voice talking with a 2-4 year old. ONLY " +
      "English. One sentence, eight words at most, conversational. No emoji, " +
      "no quotes, no explanations — only the sentence itself.",
};

const TASK: Record<Kind, Record<Lang, string>> = {
  ask: {
    tr: "Çocuğa resimdeki '{w}' kelimesini söylet. Kelimeyi SEN SÖYLEME.",
    ru: "Попроси ребёнка назвать картинку: '{w}'. САМО СЛОВО НЕ НАЗЫВАЙ.",
    en: "Get the child to say the picture's word: '{w}'. Do NOT say the word yourself.",
  },
  yes: {
    tr: "Çocuk '{w}' dedi ve doğru. Onu kutla ve {w} hakkında çok kısa, sevimli bir şey ekle.",
    ru: "Ребёнок сказал '{w}' — правильно! Похвали и добавь очень коротко что-нибудь милое про {w}.",
    en: "The child said '{w}' and it is right. Celebrate, then add one very short sweet thing about {w}.",
  },
  again: {
    tr: "Çocuk '{w}' demeye çalıştı ama tutturamadı. Cesaretlendir, tekrar denemesini iste. Kelimeyi SÖYLEME.",
    ru: "Ребёнок пытался сказать '{w}', но не вышло. Подбодри и попроси попробовать ещё. САМО СЛОВО НЕ НАЗЫВАЙ.",
    en: "The child tried to say '{w}' but did not get it. Cheer them on to try again. Do NOT say the word.",
  },
};

export class Chatter {
  usedLlm = 0;
  usedCanned = 0;
  private ready = new Map<string, string>();
  private used = new Set<string>();
  private pending = new Set<string>();

  constructor(
    private brain: Brain | null,
    private lang: Lang,
    private canned: Record<Kind, string[]>,
    /** Called when a prepared line lands, so the voice can be fetched too. */
    private onReady: (kind: Kind, text: string) => void = () => {},
  ) {}

  /** Start writing this card's three lines. Fire and forget. */
  warm(word: string): void {
    if (!this.brain) return;                 // model disabled: canned only
    for (const kind of ["ask", "yes", "again"] as Kind[]) {
      const key = `${kind}:${word}`;
      if (this.ready.has(key) || this.pending.has(key)) continue;
      this.pending.add(key);
      this.write(kind, word, key).catch(() => {}).finally(() => this.pending.delete(key));
    }
  }

  /** The line to say RIGHT NOW. Prepared if ready, canned if not. */
  line(kind: Kind, word: string): string {
    const key = `${kind}:${word}`;
    const got = this.ready.get(key);
    // A prepared line is said once; the second time (a second miss on the
    // same card) the canned pool varies it, so she never hears one sentence
    // twice in a row.
    if (got && !this.used.has(key)) { this.used.add(key); this.usedLlm++; return got; }
    this.usedCanned++;
    const pool = this.canned[kind];
    return pool[Math.floor(Math.random() * pool.length)] ?? "";
  }

  private async write(kind: Kind, word: string, key: string): Promise<void> {
    if (!this.brain) return;
    const msg = TASK[kind][this.lang].replaceAll("{w}", word);
    let out = "";
    const deadline = AbortSignal.timeout(8000);
    for await (const piece of this.brain.stream(msg, SYSTEM[this.lang])) {
      out += piece;
      if (deadline.aborted) return;
    }
    const line = out.trim().replace(/^["«]+|["»]+$/g, "").split("\n")[0] ?? "";
    // A model that ignores "don't say the word" would hand the child the
    // answer, and one that echoes its task would read the brief at her.
    // Drop both rather than correct them; the canned line is fine.
    if ((kind === "ask" || kind === "again")
        && line.toLowerCase().includes(word.toLowerCase())) return;
    if (isNarration(line)) return;
    if (line.length > 0 && line.length <= 120) {
      this.ready.set(key, line);
      this.onReady(kind, line);
    }
  }
}
