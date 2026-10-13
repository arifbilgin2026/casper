# söyle — a talking picture game for toddlers

*Demo project for the Casper interview.*

A web page shows one picture. A voice asks the child what it is. The child
says it out loud. The voice reacts — praise, a star, confetti, the next
picture — or gently asks again. Ages roughly 2–4, Turkish and Russian, same
code. The child never touches the screen.

## Run it

Prerequisites: Python 3.11+, the dialtone repo checked out next to this one
(the voice library lives inside it), and two pip packages:

```sh
pip install websockets boto3 httpx
```

Keys, read from the environment:

| variable | what for |
|---|---|
| `DEEPGRAM_API_KEY` | speech-to-text (model `nova-2`) |
| `ELEVENLABS_API_KEY` | the voice (`eleven_turbo_v2_5`) |
| AWS credentials, Bedrock in `us-east-1` | the persona (Haiku 4.5) |
| `SOYLE_NO_LLM=1` | optional: run with the model disabled, canned lines only |

Then:

```sh
python -m soyle.server
# →  http://localhost:8600          Türkçe
# →  http://localhost:8600/?lang=ru по-русски
```

Open it in a browser, allow the microphone, and say what you see. The page is
one static file ([soyle/web/index.html](soyle/web/index.html)); everything
else happens server-side over one websocket.

The import of the voice library expects `~/workspace/dialtone` (see the top of
[soyle/server.py](soyle/server.py)). The standalone `voicecore` repo is a stale
extraction and is not used.

## Tests

```sh
python -m pytest tests/
```

They cover the matcher (the part that must never regress), the whole deck in
both languages (no word fails itself, no alternate is rejected, zero
cross-matches, no canned prompt contains an answer), and the persona line
protocol (marks run in written order, unknown marks are stripped and never
spoken, narration is detected). No network, no keys needed.

## Adding a word, adding a language

The deck and the canned phrases live in one data file per language:
[soyle/words_tr.json](soyle/words_tr.json), [soyle/words_ru.json](soyle/words_ru.json).
Adding a word is one line (`word`, `emoji`, `also` — what a toddler plausibly
says instead). Adding a language is a new file plus a voice id in
`VOICES` — no code path changes.

## Why the code is shaped like this

See [SPLIT.md](SPLIT.md). The one-sentence version: **anything with a correct
answer is computed; only things that need judgement go to the model** — and
when the model is slow, down, or switched off, prepared or canned lines keep
the game at full speed, because a child never waits for a model.
