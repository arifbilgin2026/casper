"""The persona protocol: one line in, an ordered script out.

Parse strictly, fail silently: a stray bracket must never reach her ears, and
the model describing the room must never be read aloud.
"""
from soyle import persona


def test_script_runs_in_written_order():
    script, passed = persona.parse(
        "Молодец! ♪confetti♪ [star] А это кто? [card:лягушка]")
    assert not passed
    assert script == [("say", "Молодец!"), ("sound", "confetti"),
                      ("star", ""), ("say", "А это кто?"),
                      ("card", "лягушка")]


def test_pass_is_first_class():
    assert persona.parse("PASS") == ([], True)
    assert persona.parse("  pass") == ([], True)
    assert persona.parse("") == ([], True)


def test_unknown_marks_are_stripped_never_spoken():
    script, _ = persona.parse("[нечто:х] Привет!")
    assert script == [("say", "Привет!")]


def test_unclosed_note_takes_its_word_with_it():
    script, _ = persona.parse("Аферин! ♪ding")
    assert script == [("say", "Аферин!")]
    assert not any("ding" in v for _, v in script)


def test_unknown_sound_name_is_dropped():
    script, _ = persona.parse("♪kaboom♪ Bak!")
    assert script == [("say", "Bak!")]


def test_sound_written_as_action_still_plays():
    script, _ = persona.parse("[yes] Doğru!")
    assert ("sound", "yes") in script


def test_narration_is_detected_both_languages():
    assert persona.is_narration("Ребёнок сказал слово, надо ответить")
    assert persona.is_narration("Çocuk konuştu, cevap vermem lazım")
    assert persona.is_narration("Жду ответа")
    assert not persona.is_narration("Молодец! А это кто?")
    assert not persona.is_narration("Aferin! Bu ne?")


def test_rule_echo_is_narration():
    # Heard in play, verbatim: the model reading its own rules to a child.
    assert persona.is_narration("Cesaretlendir, kelimeyi söyleme, kartı değiştirme.")
    assert persona.is_narration("Подбодри и попроси попробовать ещё")
    assert persona.is_narration("Kutla ve yeni kart aç")
    assert not persona.is_narration("Aferin, çok güzel!")
    assert not persona.is_narration("Вот это да, точно!")


def _state(lang, **kw):
    base = dict(card={"emoji": "🐘", "word": "слон"}, score=3, heard="",
                talking=False, quiet_s=2.4, since_us=1.4, tries=1,
                seen={"слон"}, deck=[{"word": "слон"}, {"word": "кот"}],
                last_said="", verdict=None)
    base.update(kw)
    return persona.state_text(lang, **base)


def test_never_quiet_while_an_answer_is_pending():
    # Trap: "silent for 2.4s" next to an unanswered utterance makes the
    # persona tell a child who just spoke that she is being quiet.
    s = _state("ru", heard="сон", verdict=True)
    assert "молчит" not in s
    assert "ждёт" in s
    s = _state("tr", card={"emoji": "🐘", "word": "fil"}, heard="fil",
               verdict=True, deck=[{"word": "fil"}], seen={"fil"})
    assert "sessiz" not in s


def test_verdict_is_shown_as_fact():
    assert "ЭТО ПРАВИЛЬНО" in _state("ru", heard="сон", verdict=True)
    assert "НЕ то слово" in _state("ru", heard="дом", verdict=False)


# --- the think/say envelope -------------------------------------------------

def test_unwrap_splits_inner_voice_from_speech():
    think, say = persona.unwrap(
        '{"think": "doğru dedi, kutla", "say": "Aferin! [star] [card:kedi]"}')
    assert think == "doğru dedi, kutla"
    assert say == "Aferin! [star] [card:kedi]"


def test_unwrap_tolerates_code_fences():
    _, say = persona.unwrap('```json\n{"think": "x", "say": "Bu ne?"}\n```')
    assert say == "Bu ne?"


def test_unwrap_pass():
    _, say = persona.unwrap('{"think": "düşünsün", "say": "PASS"}')
    assert persona.parse(say) == ([], True)


def test_unwrap_broken_json_still_finds_say():
    _, say = persona.unwrap('{"think": "oops, "say": "Молодец!"')
    assert say == "Молодец!"


def test_unwrap_structured_but_unreadable_is_silence():
    think, say = persona.unwrap('{"think": "a", "sa')
    assert (think, say) == ("", "")


def test_unwrap_bare_line_is_say():
    assert persona.unwrap("Aferin! Bu ne?") == ("", "Aferin! Bu ne?")


def test_saystream_streams_the_say_string_only():
    s = persona.SayStream()
    for piece in ['{"think": "ikinci dene', 'me, ipucu", "sa',
                  'y": "Az kal', 'dı! Bir daha', ' dene?"}']:
        s.feed(piece)
    assert s.text == "Az kaldı! Bir daha dene?"
    assert s.done
    assert "ipucu" not in s.text          # think never reaches the mouth


def test_saystream_handles_escapes_split_across_pieces():
    s = persona.SayStream()
    for piece in ['{"say": "O dedi \\', '"hav\\" bana", "think": "x"}']:
        s.feed(piece)
    assert s.text == 'O dedi "hav" bana'
    assert s.done


def test_saystream_unicode_escape():
    s = persona.SayStream()
    s.feed('{"say": "\\u0410ferin!"}')
    assert s.text == "Аferin!"
