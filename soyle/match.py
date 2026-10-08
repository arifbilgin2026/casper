"""Did the toddler say the word? Deliberately generous.

A two-year-old saying "apa" for "elma" has done the thing we are asking of
them. Scoring that as a miss teaches them the game is unwinnable, so this
accepts a near miss and leaves the judging of "near" in one small, readable
place rather than inside a model.
"""
from __future__ import annotations

import unicodedata

_FOLD = str.maketrans("âîûäëïöüÂÎÛ", "aiuaeiouAIU")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", (s or "").strip().lower())
    s = s.translate(_FOLD)
    return "".join(c for c in s if c.isalnum() or c.isspace())


def _distance(a: str, b: str) -> int:
    """Levenshtein, short strings only."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                           prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def heard_it(said: str, target: str, also=(), others=()) -> bool:
    """True if `said` is a fair attempt at `target`.

    `others` is every OTHER word in the deck. Being generous about near misses
    is right for a toddler, but not so generous that naming the wrong animal
    earns a star: "kedi" is one edit from "keçi" and "at" from "ay". So a near
    miss only counts when the target is the BEST fit in the whole deck — if
    some other card fits as well or better, she named that one instead, and we
    ask again. This keeps the matcher forgiving about pronunciation and strict
    about which animal it is.
    """
    s, t = norm(said), norm(target)
    if not s:
        return False
    alts = {norm(a) for a in also}
    if s in alts:                              # a two-word attempt, e.g. "köpek balığı"
        return True
    rivals = [norm(o) for o in others if norm(o) != t]
    for word in s.split():                     # they may say "bu elma"
        if word == t or word in alts:
            return True                        # exact, or a hand-listed attempt

        # A clean prefix is strong evidence: "til" starts tilki and starts no
        # other card. Judge it only against cards it could ALSO be the start
        # of — not against every word that happens to be one letter away,
        # which would let "fil" veto "tilki".
        if len(word) >= 2 and (t.startswith(word) or word.startswith(t)):
            if not any(r.startswith(word) or word.startswith(r) for r in rivals):
                return True
            continue

        # Otherwise a near miss counts only if nothing else fits as well.
        d = _distance(word, t)
        if d > max(1, len(t) // 3):
            continue
        if any(_distance(word, r) <= d for r in rivals):
            continue
        return True
    return False
