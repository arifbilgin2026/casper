"""The matcher is the part that must never regress.

Forgiving about pronunciation, strict about identity: "maz" for muz is a win,
"kedi" for keçi is not — she named a different animal.
"""
from soyle.match import heard_it, norm

DECK = ["kedi", "keçi", "tilki", "fil", "muz", "elma", "at", "ay",
        "karpuz", "karınca", "köpek", "köpekbalığı"]


def test_exact_word_matches_itself():
    assert heard_it("kedi", "kedi", [], DECK)


def test_case_and_diacritics_fold():
    # The brief's founding example: 'Кошка' IS 'кошка' — a string question.
    assert heard_it("Кошка", "кошка", [], ["кошка", "собака"])
    assert heard_it("KEDI", "kedi", [], DECK)


def test_word_inside_a_small_sentence():
    assert heard_it("bu elma", "elma", [], DECK)


def test_listed_alternate_counts():
    assert heard_it("apa", "elma", ["apa"], DECK)


def test_two_word_alternate_counts_whole():
    assert heard_it("köpek balığı", "köpekbalığı", ["köpek balığı"], DECK)


def test_near_miss_wins_when_target_is_best_fit():
    assert heard_it("maz", "muz", [], DECK)      # one vowel off, nothing closer


def test_wrong_animal_never_scores():
    # One edit away, but it IS another card. She named a different animal.
    assert not heard_it("kedi", "keçi", [], DECK)
    assert not heard_it("at", "ay", [], DECK)


def test_clean_prefix_beats_coincidental_edit_distance():
    # "til" starts tilki and starts no other card — "fil" being one letter
    # away must not veto it.
    assert heard_it("til", "tilki", [], DECK)


def test_ambiguous_prefix_does_not_score():
    # "kar" starts karpuz AND karınca: she has not named either yet.
    assert not heard_it("kar", "karpuz", [], DECK)


def test_empty_and_noise():
    assert not heard_it("", "kedi", [], DECK)
    assert not heard_it("   ", "kedi", [], DECK)


def test_punctuation_is_ignored():
    assert heard_it("muz!", "muz", [], DECK)


def test_norm_strips_marks_and_folds():
    assert norm("  Muz! ") == "muz"
    assert norm("Кошка") == "кошка"
