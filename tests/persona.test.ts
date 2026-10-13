/* The persona protocol: an envelope in, an ordered script out. Parse
 * strictly, fail silently — a stray bracket must never reach her ears, and
 * the model describing the room must never be read aloud. */
import { describe, expect, it } from "vitest";
import {
  SayStream, firstClause, isNarration, parse, stateText, unwrap,
} from "../src/persona.js";

describe("parse", () => {
  it("runs the script in written order", () => {
    const [script, passed] = parse("Молодец! ♪confetti♪ [star] А это кто? [card:лягушка]");
    expect(passed).toBe(false);
    expect(script).toEqual([
      { kind: "say", val: "Молодец!" }, { kind: "sound", val: "confetti" },
      { kind: "star", val: "" }, { kind: "say", val: "А это кто?" },
      { kind: "card", val: "лягушка" },
    ]);
  });

  it("PASS is first-class", () => {
    expect(parse("PASS")).toEqual([[], true]);
    expect(parse("  pass")).toEqual([[], true]);
    expect(parse("")).toEqual([[], true]);
  });

  it("unknown marks are stripped, never spoken", () => {
    const [script] = parse("[нечто:х] Привет!");
    expect(script).toEqual([{ kind: "say", val: "Привет!" }]);
  });

  it("an unclosed note takes its word with it", () => {
    const [script] = parse("Аферин! ♪ding");
    expect(script).toEqual([{ kind: "say", val: "Аферин!" }]);
  });

  it("an unknown sound name is dropped; [yes] as an action still plays", () => {
    expect(parse("♪kaboom♪ Bak!")[0]).toEqual([{ kind: "say", val: "Bak!" }]);
    expect(parse("[yes] Doğru!")[0]).toContainEqual({ kind: "sound", val: "yes" });
  });
});

describe("isNarration", () => {
  it("detects inner voice in all three languages", () => {
    expect(isNarration("Ребёнок сказал слово, надо ответить")).toBe(true);
    expect(isNarration("Çocuk konuştu, cevap vermem lazım")).toBe(true);
    expect(isNarration("The child spoke, I must reply")).toBe(true);
  });

  it("detects rule-echo (heard in play, verbatim)", () => {
    expect(isNarration("Cesaretlendir, kelimeyi söyleme, kartı değiştirme.")).toBe(true);
    expect(isNarration("Подбодри и попроси попробовать ещё")).toBe(true);
    expect(isNarration("Encourage them, don't say the word")).toBe(true);
  });

  it("lets honest speech through", () => {
    expect(isNarration("Молодец! А это кто?")).toBe(false);
    expect(isNarration("Aferin! Bu ne?")).toBe(false);
    expect(isNarration("Well done! And what's this?")).toBe(false);
  });
});

describe("stateText", () => {
  const base = {
    card: { word: "слон", emoji: "🐘" }, score: 3, heard: "", talking: false,
    quietS: 2.4, sinceUs: 1.4, tries: 1, seen: new Set(["слон"]),
    deck: [{ word: "слон", emoji: "🐘" }, { word: "кот", emoji: "🐱" }],
    verdict: null as boolean | null,
  };

  it("never says quiet while an answer is pending", () => {
    const s = stateText("ru", { ...base, heard: "сон", verdict: true });
    expect(s).not.toContain("молчит");
    expect(s).toContain("ждёт");
  });

  it("shows the verdict as a computed fact", () => {
    expect(stateText("ru", { ...base, heard: "сон", verdict: true })).toContain("ЭТО ПРАВИЛЬНО");
    expect(stateText("en", { ...base, heard: "dog", verdict: false })).toContain("NOT that word");
  });

  it("shows the cry as a hint when the card has one", () => {
    const s = stateText("tr", { ...base, card: { word: "köpek", emoji: "🐶", cry: "hav hav" } });
    expect(s).toContain("(sesi: hav hav)");
  });
});

describe("the think/say envelope", () => {
  it("splits inner voice from speech", () => {
    const [think, say] = unwrap('{"think": "doğru dedi", "say": "Aferin! [star]"}');
    expect(think).toBe("doğru dedi");
    expect(say).toBe("Aferin! [star]");
  });

  it("tolerates code fences and PASS", () => {
    expect(unwrap('```json\n{"think": "x", "say": "Bu ne?"}\n```')[1]).toBe("Bu ne?");
    expect(parse(unwrap('{"think": "düşünsün", "say": "PASS"}')[1])).toEqual([[], true]);
  });

  it("finds say inside broken JSON; yields silence when unreadable", () => {
    expect(unwrap('{"think": "oops, "say": "Молодец!"')[1]).toBe("Молодец!");
    expect(unwrap('{"think": "a", "sa')).toEqual(["", ""]);
  });

  it("treats a bare line as the say", () => {
    expect(unwrap("Aferin! Bu ne?")).toEqual(["", "Aferin! Bu ne?"]);
  });
});

describe("SayStream", () => {
  it("streams only the say string, across arbitrary piece boundaries", () => {
    const s = new SayStream();
    for (const piece of ['{"think": "ikinci dene', 'me, ipucu", "sa',
                         'y": "Az kal', 'dı! Bir daha', ' dene?"}']) s.feed(piece);
    expect(s.text).toBe("Az kaldı! Bir daha dene?");
    expect(s.done).toBe(true);
    expect(s.text).not.toContain("ipucu");
  });

  it("handles escapes split across pieces and unicode escapes", () => {
    const a = new SayStream();
    for (const piece of ['{"say": "O dedi \\', '"hav\\" bana", "think": "x"}']) a.feed(piece);
    expect(a.text).toBe('O dedi "hav" bana');
    const b = new SayStream();
    b.feed('{"say": "\\u0410ferin!"}');
    expect(b.text).toBe("Аferin!");
  });
});

describe("firstClause", () => {
  it("cuts at the first sentence end or mark", () => {
    expect(firstClause("Aferin! Bir daha")).toBe(7);
    expect(firstClause("Молодец ♪yes♪")).toBe(8);
    expect(firstClause("Hop")).toBeNull();
  });
});
