"""Code-owned guards around the model's mouth.

Whether a line hands the child the answer is a string question with a correct
answer — so it is computed, never prompted.
"""
import asyncio

from soyle.chatter import Chatter
from soyle.server import PHRASES, Game


def game(**room):
    g = Game(None, "tr")
    g.room.card = {"word": "at", "also": ["a"]}
    for k, v in room.items():
        setattr(g.room, k, v)
    return g


def test_card_word_in_our_mouth_is_a_leak():
    g = game()
    assert g._leaks_answer("Hop, at!")          # heard in play, four times
    assert g._leaks_answer("At nerede?")
    assert not g._leaks_answer("Bu ne?")


def test_leak_is_token_based_not_substring():
    g = game()
    assert not g._leaks_answer("Hadi atla!")    # "atla" is not "at"


def test_saying_it_is_fine_once_she_got_it():
    assert not game(verdict=True)._leaks_answer("Evet, at!")


def test_saying_it_is_fine_after_three_tries():
    assert not game(tries=3)._leaks_answer("Bu bir at.")


def test_no_card_no_leak():
    g = Game(None, "tr")
    assert not g._leaks_answer("At!")


def _playable():
    g = Game(None, "tr")
    g.chatter = Chatter(None, "tr", PHRASES["tr"])
    done = []

    async def fake(script):          # the real _perform, minus the audio
        done.append(script)
        for k, v in script:
            if k == "card":
                g._show(v)
            elif k == "star":
                g.room.score += 1
        g.room.heard = ""
    g._perform = fake
    return g, done


def test_celebrate_rewards_and_advances_without_the_model():
    async def run():
        g, done = _playable()
        g._show(g.deck[0]["word"])
        first = g.room.card["word"]
        g.room.heard, g.room.verdict = first, True
        g._thinking = True
        await g._celebrate()
        assert [k for k, _ in done[-1]] == ["sound", "say", "star", "card", "say"]
        assert g.room.card["word"] != first
        assert g.room.score == 1
        assert g.room.verdict is None      # fresh question on the new card
        assert g._thinking is False
    asyncio.run(run())


def test_model_cannot_reshow_a_seen_card():
    g, _ = _playable()
    g._show("kedi")
    g._show("köpek")
    g._show("kedi")                        # seen; other cards remain
    assert g.room.card["word"] != "kedi"
