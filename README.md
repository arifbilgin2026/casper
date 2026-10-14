# söyle — a talking picture game for toddlers

*Demo project for the Casper interview.*

A web page shows one picture. A voice asks the child what it is. The child
says it out loud. The voice reacts — praise, a star, confetti, the next
picture — or gently asks again. Ages roughly 2–4; Turkish, Russian and
English, same code. **The child never touches the screen** — the whole
interaction is her voice and the agent's voice.

**Hosted:** https://soyle.peachyvoice.com — sign up (any email works), allow
the microphone, press Start, and say what you see. Use speakers rather than
headphones: the game expects to hear the child while it talks.

## Why it exists, and why Turkish and Russian came first

This is a family project before it is a tech demo. Our daughter is a year and
a half old, growing up between her mother's Russian and her father's Turkish —
two languages, one toddler collecting her first words in both at once. We
wanted something that lets her *practice saying things out loud* in each
parent's language, with infinite patience and a small celebration every time
she gets one out. Nothing on the market treats a pre-reader who can't
touch-target as the only user in the room. So: no buttons, no reading, just a
picture and her voice. English joined the way any language joins — a data
file, a voice id and a persona block.

## The principle the code is judged on

**Anything that has a correct answer is computed. Only things that need
judgement go to a model.**

Whether "Кошка" is the same word as "кошка" is a string comparison: instant,
free, testable, always right ([src/match.ts](src/match.ts)). Routing it
through a model made it slower, more expensive *and wrong* — in testing, a
child said the correct word three times and was not credited once. So code
decides the verdict, the star, the advancement and the confetti; the model
decides only what to *say* about it. [SPLIT.md](SPLIT.md) is the full note —
it matters as much as the code.

## Status note (what works / what's incomplete / how to run)

**Works, verified on the hosted link:**
- Parent accounts (scrypt + HMAC-signed session cookie): a script-free sign-in
  page, a separate create-account page with confirm password and a
  "how old is your child?" setting; the game socket is refused without a
  session. Stars and mastered words persist per family
  in DynamoDB across visits.
- The full voice loop in three languages: live STT (Deepgram), a persona
  (Claude Haiku on Bedrock) answering in a `{"think","say"}` envelope, and
  streaming TTS (ElevenLabs), with the first clause spoken while the rest of
  the model's reply is still arriving.
- Code-owned guarantees: instant celebration on a correct answer (no model on
  that path), answer-leak guard, repetition guard, narration detection, a
  no-repeat deck, animal cries announced from data at every card flip.
- Degradation: with the model slow, down or disabled (`SOYLE_NO_LLM=1`) the
  game runs at full speed on prepared/canned lines.
- 90 tests over the matcher, the sound-tolerance layer, all three decks, the persona protocol, the
  game guards, the recogniser settings and the audio framing:
  `npx vitest run` — no network or keys needed.
- A measured listening pipeline (next section), checked by two scripted
  children: `scripts/stt-bench.ts` and `scripts/browser-child.ts`.

**Incomplete / honest caveats:**
- The scripted children use an adult synthetic voice. They rank settings
  reliably, but a real toddler is quieter and less clear than any of them, so
  absolute accuracy on a real child will be lower than the numbers below.
- `lang` on the profile is set at signup; the in-game language switcher is
  just the `?lang=` query for now.
- One Fargate task, no autoscaling — it is a family demo, not a product.
- This project began as a Python prototype on an in-house voice library (it
  is in the git history); everything in HEAD is the TypeScript
  implementation, rebuilt for this submission.

## Hearing a toddler (measured, not guessed)

Short words from quiet children are the hard case for speech recognition, and
the first version handled them badly. So the listening path was rebuilt from
measurements. [scripts/stt-bench.ts](scripts/stt-bench.ts) synthesises the
deck's short words, plays them at the recogniser in real time (room noise
before and after, the microphone never stops) and scores each setting with the
game's own matcher. At a quiet, toddler-like level (about -16 dB):

| setting | words understood | final transcript arrives |
|---|---|---|
| nova-2, 250 ms endpoint (the first version) | 16 / 31 | 473 ms after the word ends |
| nova-3 | 25 / 31 | 448 ms |
| **nova-3 + the deck's words as keyterms** (now) | **27 / 31** | 455 ms |

What changed because of it:
- **Model and hints**: nova-3 with the ~66 deck words as keyterms
  ([src/ears.ts](src/ears.ts)). Hints are model-specific (`keyterm` vs
  `keywords`); the pairing is a tested guard because the wrong one is an HTTP
  400 and a silently deaf game.
- **Early commit**: the recogniser knows the word about 100 ms after it ends
  but calls it final ~350 ms later. When an interim transcript is *certainly*
  the answer (an exact word that is not the start of a longer card word:
  `saidExactly` in [src/match.ts](src/match.ts)) and holds still for 100 ms,
  it is judged at once. Measured end to end through a real browser:
  **about 180 ms from the word ending to the celebration sound, versus about
  440 ms waiting for the final.** When no interim arrives it falls back to the
  final, so it can only be faster, never wrong.
- **Words the recogniser mishears** (`kuş` heard as "Hoş", `bee` as "B") are
  recorded as accepted alternates in the deck data, found by the bench.
- **The microphone** runs on the audio thread
  ([web/mic-worklet.js](web/mic-worklet.js)): 20 ms chunks, 16 kHz, a proper
  anti-alias filter when the browser can't give 16 kHz natively, and browser
  noise suppression *off* (it clips the onset of quiet one-syllable words).
- **The game stops talking over her.** Two bugs found only by watching real
  traces: a "still there?" nudge that re-fired every tick and kept the game
  deaf most of the time, and a nudge that started 250 ms after she finished a
  word, before the recogniser had reported it. The server now watches her
  audio level directly and holds its tongue while she is speaking or has just
  spoken.
- **Replies don't wait for the voice**: a correct answer plays the chime
  immediately while the praise, the animal's cry and the next question are
  already being synthesised; a wrong answer gets a prepared line at once (a
  process-wide audio cache means a canned line costs one synthesis per
  deploy). Measured: a wrong answer gets its spoken reply within 1 ms when the
  line is cached and within about 250 ms when it must be synthesised fresh.

To see the numbers for yourself:

```sh
npx tsx scripts/stt-bench.ts --gain 0.15        # settings compared, quiet voice
npx tsx scripts/browser-child.ts --lang tr --word kedi   # real Chrome, real worklet
```

Both need the two speech keys; set `STT_TRACE=1` on the server to log each
transcript with its lag after the word ended (off by default: they are a
child's words).

## Forgiving a baby (and what to do when the recogniser hears nothing)

A 1-2 year old does not say words, she says *sounds* — and a recogniser is
built to hear words. Measured with the bench (synthetic voice, so the pattern
matters more than the exact figures):

- Pure babble ("mmm", "eee", "brrr", "ba ba") comes back **blank about 40% of
  the time**, and as a confident *wrong guess* ("Mama", "Gagaga", "A") the rest.
- Deepgram's n-best `alternatives` are not available on live audio (the socket
  returns nothing), and `filler_words` changes nothing. Both were tried and
  dropped.

So the game does not rely on the recogniser alone:

- **Tolerance on sound, not spelling** ([src/phonetic.ts](src/phonetic.ts)).
  Children simplify words systematically (r→w "wabbit", k→t "tat", a dropped
  final consonant "ca", a collapsed cluster "fwog", a dropped first syllable
  "nana"). Both sides are reduced to a coarse sound skeleton and compared
  there. On baby-style forms this credits 14/25 with it off, 15/25 at the
  default and 19/25 for babies. The identity rule is unchanged: a word that
  is another card's exact word is never credited to this one, and a test
  proves that for every card in every language at every tolerance level.
- **A sound is an attempt even when it is not a word.** The server watches the
  audio level ([src/game.ts](src/game.ts)): a stretch of her voice that the
  recogniser never turned into text is an *unheard attempt*, and a child who
  is ignored stops trying. Toddlers get an instant "try again" (and on the
  third try are simply told the word); the game's own voice is never mistaken
  for hers.
- **Baby mode** (chosen at signup, or `?mode=baby` on the game URL) makes
  every attempt a win: a match, a wrong guess, or a gurgle all get the chime,
  a star and the word said for her ("cat!"), then the next picture. The code
  still knows whether she actually said it; it just doesn't say no to a baby.
  Be aware that this rewards *any* vocalisation, a parent's included.

## Run it locally

Node 22+. Two external services need keys (the voice itself); the model and
the database degrade gracefully without AWS:

```sh
npm install
DEEPGRAM_API_KEY=...        # deepgram.com — speech-to-text
ELEVENLABS_API_KEY=...      # elevenlabs.io — the voice
npm start                   # → http://localhost:8600
```

- No `SOYLE_TABLE` set → accounts live in memory (everything works, nothing
  survives a restart).
- No AWS credentials → set `SOYLE_NO_LLM=1` and the persona runs on canned
  lines; with credentials, Bedrock (Claude Haiku) writes the lines.
- `npx vitest run` for the tests; no keys needed.

## How it's put together

```
  microphone ──► ears (Deepgram) ──► matcher ──┐
                                               ├──► game state ──► persona (LLM)
  screen state, score, timers ─────────────────┘         │
                                                         ▼
                        mouth (ElevenLabs + chimes) ◄── {"think","say"}
```

- [src/game.ts](src/game.ts) — the loop: a 200 ms tick, gated so the persona
  only ever acts into a silence; every guard the hard way taught us.
- [src/match.ts](src/match.ts) — the verdict. Forgiving about pronunciation,
  strict about identity.
- [src/persona.ts](src/persona.ts) — who the agent is, the think/say
  envelope, the strict mark parser.
- [src/chatter.ts](src/chatter.ts) — lines prepared in the background, so a
  child never waits for a model.
- [src/auth.ts](src/auth.ts) / [src/store.ts](src/store.ts) — families:
  scrypt, signed cookies, DynamoDB (or memory).
- [web/login.html](web/login.html) — the sign-in gate at `/`: plain HTML
  forms and redirects, no script. [web/game.html](web/game.html) — the game
  at `/game`, served only to a signed-in session.
- [web/app.ts](web/app.ts) — the game's browser half; its header documents
  the whole wire protocol.
- [decks/](decks/) — one data file per language: words, toddler alternates,
  animal cries, canned phrases. Adding a word is one line.
- [infra/](infra/) — the CDK stack: Fargate behind an ALB speaking WSS, a
  certificate, a DNS name, one DynamoDB table.

Privacy: no recordings are kept, nothing about the child is stored beyond a
first name and star counts, and the browser stores only the session cookie.
