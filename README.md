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
- Parent signup/login (scrypt + HMAC-signed session cookie); the game socket
  is refused without a session. Stars and mastered words persist per family
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
- 53 tests over the matcher, all three decks, the persona protocol and the
  game guards: `npx vitest run` — no network or keys needed.

**Incomplete / honest caveats:**
- The scripted-child acceptance harness (synthesised toddler answers played
  at the game) is designed but not built; acceptance was checked by hand.
- `lang` on the profile is set at signup; the in-game language switcher is
  just the `?lang=` query for now.
- One Fargate task, no autoscaling — it is a family demo, not a product.
- This project began as a Python prototype on an in-house voice library (it
  is in the git history); everything in HEAD is the TypeScript
  implementation, rebuilt for this submission.

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
