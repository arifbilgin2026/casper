"""Every deck, whole: no word fails itself, no alternate is rejected, and no
utterance can score the wrong card. A data bug here once let "banana" score a
pig — these run over every pair so it cannot come back.
"""
import json
import pathlib

import pytest

from soyle.match import heard_it, norm

HERE = pathlib.Path(__file__).resolve().parent.parent / "soyle"
DATA = {lang: json.loads((HERE / f"words_{lang}.json").read_text())
        for lang in ("tr", "ru", "en")}
LANGS = list(DATA)


def deck(lang):
    return DATA[lang]["words"]


def words(lang):
    return [w["word"] for w in deck(lang)]


@pytest.mark.parametrize("lang", LANGS)
def test_every_word_matches_itself(lang):
    all_words = words(lang)
    for w in deck(lang):
        assert heard_it(w["word"], w["word"], w.get("also", []), all_words), \
            f"{lang}: {w['word']!r} does not match itself"


@pytest.mark.parametrize("lang", LANGS)
def test_every_alternate_is_accepted(lang):
    all_words = words(lang)
    for w in deck(lang):
        for alt in w.get("also", []):
            assert heard_it(alt, w["word"], w.get("also", []), all_words), \
                f"{lang}: alternate {alt!r} rejected for {w['word']!r}"


@pytest.mark.parametrize("lang", LANGS)
def test_zero_cross_matches(lang):
    # Saying one card's word must never score another card.
    all_words = words(lang)
    for target in deck(lang):
        for other in deck(lang):
            if other["word"] == target["word"]:
                continue
            assert not heard_it(other["word"], target["word"],
                                target.get("also", []), all_words), \
                f"{lang}: saying {other['word']!r} scores {target['word']!r}"


@pytest.mark.parametrize("lang", LANGS)
def test_no_alternate_is_another_cards_word(lang):
    # The "banana scored a pig" assert, over the whole deck, normed.
    for w in deck(lang):
        for alt in w.get("also", []):
            for other in deck(lang):
                if other["word"] == w["word"]:
                    continue
                assert norm(alt) != norm(other["word"]), \
                    f"{lang}: {w['word']!r} alternate {alt!r} IS card {other['word']!r}"


# NOTE deliberately absent: a test that an alternate serves only ONE card.
# "bağa" is an honest toddler attempt at both kurbağa and kaplumbağa, and the
# card on screen disambiguates. Only a collision with another card's full
# word (the test above) can mis-credit.


@pytest.mark.parametrize("lang", LANGS)
def test_cards_are_unique_and_complete(lang):
    names = [norm(w["word"]) for w in deck(lang)]
    assert len(names) == len(set(names)), f"{lang}: duplicate card"
    for w in deck(lang):
        assert w.get("emoji"), f"{lang}: {w['word']!r} has no picture"


@pytest.mark.parametrize("lang", LANGS)
def test_phrases_exist_for_every_kind(lang):
    phrases = DATA[lang]["phrases"]
    for kind in ("ask", "yes", "again"):
        assert phrases.get(kind), f"{lang}: no canned {kind!r} lines"
        assert all(0 < len(p) <= 120 for p in phrases[kind])


@pytest.mark.parametrize("lang", LANGS)
def test_cries_never_collide_with_answers(lang):
    # The cry is spoken BY US at every flip and echoed by toddlers. If a cry
    # token equalled any card's word, the echo would score the wrong card.
    deck_words = {norm(w["word"]) for w in deck(lang)}
    for w in deck(lang):
        for token in norm(w.get("cry", "")).split():
            assert token not in deck_words, \
                f"{lang}: cry of {w['word']!r} contains deck word {token!r}"


@pytest.mark.parametrize("lang", LANGS)
def test_canned_prompts_never_contain_a_deck_word(lang):
    # An "ask"/"again" line that contains the answer hands the child the word.
    # Canned lines serve EVERY card, so they may contain NO deck word at all.
    deck_words = {norm(w["word"]) for w in deck(lang)}
    phrases = DATA[lang]["phrases"]
    for kind in ("ask", "again"):
        for p in phrases[kind]:
            for token in norm(p).split():
                assert token not in deck_words, \
                    f"{lang}: canned {kind} line {p!r} contains deck word {token!r}"
