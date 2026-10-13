# The deterministic/model split

**Anything that has a correct answer is computed. Only things that need
judgement go to a model.**

A language model is excellent at *"what should I say about a frog to a
two-year-old"* and bad at *"is 'Кошка' the same word as 'кошка'"*. The second
is a string comparison: instant, free, testable, and always right. When it was
routed through the model it was slower, more expensive **and wrong** — in
testing, a child said the correct word three times and was not credited once.

## Who decides what

| decision | who | where |
|---|---|---|
| is the answer right? | **code** | `heardIt` in [src/match.ts](src/match.ts) |
| does she get the star | **code** | `ensureTurn` in [src/game.ts](src/game.ts) appends it if omitted |
| does the game advance | **code** | `ensureTurn` appends the next card |
| does confetti fire | **code** | `ensureTurn` prepends it |
| when may the agent act at all | **code** | the tick gates in `game.ts` |
| when is a stuck answer judged | **code** | the interim knobs in the tick |
| may our line contain the answer | **code** | `leaksAnswer` — not before she says it |
| may our line repeat | **code** | same words + same card + nothing new = no |
| what to say | **persona** | one envelope, streamed |
| which picture next | **persona** | `[card:word]` in its line |
| which sound, where in the sentence | **persona** | `♪name♪` in its line |

The persona chooses **how to celebrate, never whether to**. Its verdict is
handed to it as a computed fact ("THIS IS CORRECT") with an instruction to
trust it; if its line omits the star, the sound or the next card, `ensureTurn`
appends them. It stranded a child on an already-named card three times before
that rule existed.

## The envelope

The persona answers `{"think": "...", "say": "..."}` — the inner voice has a
key of its own, so the engine reads intent off a key instead of guessing with
a blocklist. Only `say` reaches the mouth; `think` goes to the log. (Before
the envelope, the model's inner voice — *"Cesaretlendir, kelimeyi söyleme"* —
was spoken to a child.) The blocklist, the leak guard and the repeat guard
stay on `say` as last-ditch insurance: a key says what the model *meant*, not
whether it is *safe*.

## The same split, applied to failure

The model is on the quality path, never the critical path:

- A **correct answer celebrates straight from the transcript** — confetti,
  a prepared line, the star, the next card — with no model call waiting.
- Its reply streams, and the first finished clause is spoken while the rest
  is still being written (`SayStream` extracts the `say` string incrementally,
  so the JSON envelope costs no latency).
- It gets 1.4 s to produce that clause. After that, a line it wrote *earlier*
  for this card (`chatter.warm`, prepared in the background) or a canned line
  from the deck file goes out instead.
- `SOYLE_NO_LLM=1` removes the model entirely and the game still runs at full
  speed — same stars, same advancement, plainer sentences.

So the floor of the experience is deterministic and the model only ever raises
the ceiling. A child never waits for it, and nothing it says or fails to say
can take away a reward she earned.
