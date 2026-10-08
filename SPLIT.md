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
| is the answer right? | **code** | `match.heard_it` — called in `server._final` |
| does she get the star | **code** | `server._ensure_turn` appends it if omitted |
| does the game advance | **code** | `server._ensure_turn` appends the next card |
| does confetti fire | **code** | `server._ensure_turn` prepends it |
| when may the agent act at all | **code** | the tick gates in `server.tick` |
| when is a stuck answer judged | **code** | interim knobs in `server.tick` |
| what to say | **persona** | one line, streamed |
| which picture next | **persona** | `[card:word]` in that line |
| which sound, and where in the sentence | **persona** | `♪name♪` in that line |

The persona answers in an envelope — `{"think": "...", "say": "..."}` — so its
inner voice has a key of its own (`persona.unwrap` / `persona.SayStream`):
only `say` reaches the mouth, `think` goes to the log, and whether a sentence
was meant for the child is read off a key, not guessed by a blocklist. The
blocklist (`persona.is_narration`), the answer-leak guard and the repeat guard
stay on `say` as last-ditch insurance.

The persona chooses **how to celebrate, never whether to**. Its verdict is
handed to it as a computed fact ("THIS IS CORRECT") with an instruction to
trust it; if its line omits the star, the sound, or the next card,
`_ensure_turn` appends them. It stranded a child on an already-named card
three times before that rule existed.

## The same split, applied to failure

The model is on the quality path, never the critical path:

- Its reply streams, and the first finished clause is spoken while the rest is
  still being written.
- It gets `FIRST_SOUND_S` (1.8 s) to produce that clause. After that, a line
  it wrote *earlier* for this card (`chatter.warm`, prepared in the background)
  or a canned line from the data file goes out instead.
- `SOYLE_NO_LLM=1` removes the model entirely and the game still runs at full
  speed — same stars, same advancement, plainer sentences.

So the floor of the experience is deterministic and the model only ever raises
the ceiling. A child never waits for it, and nothing it says or fails to say
can take away a reward she earned.
