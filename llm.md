# LLM module

Per-situation prompt + interchangeable backend layer for everything in the
game that needs a generative model (character sprites today, monster
sprites / item views / scene descriptions in the future).

## Layout

```
server/llm/
├── index.js                          # callLLM(prompt, opts) dispatcher
├── providers/                        # one provider = one file (no shared logic)
│   ├── claude_cli.js                 # local Claude Code CLI
│   ├── groq.js                       # Groq /chat/completions
│   ├── gemini.js                     # Google AI Studio
│   ├── cloudflare.js                 # Workers AI
│   └── openrouter.js                 # OpenRouter free models
└── generators/
    └── character_sprite/             # complex generator → directory
        ├── index.js                  # public generate() facade
        ├── classify.js               # LLM "card" classifier (build/palette/hair_color/gender/...)
        ├── compose.js                # in-house SVG composer — picks parts from card
        ├── parts.js                  # body / hair / weapon / accent SVG fragments
        ├── palettes.js               # named palette + HAIR_COLORS matrix
        └── cache.js                  # in-memory (name|description) → SVG cache
```

`server/sprite.js` is a thin facade so `game.js` keeps its existing
`import { generateCharacterSprite } from './sprite.js'`.

**Why a directory for `character_sprite`.** The generator runs a two-stage
pipeline: an LLM call that produces a structured *card* (build/palette/hair/
gender/accent slots — see `classify.js`), then an in-house composer that
maps the card to SVG fragments (`compose.js` + `parts.js` + `palettes.js`)
without touching the LLM. Splitting these per file keeps the LLM prompt,
the SVG primitives, and the palette matrix independently editable, and lets
the cache key on the deterministic `(name|description)` input rather than
the LLM output. New simple generators that only need `prompt → text → parse`
can still ship as a single `<name>.js` file under `generators/`.

## Provider selection

`callLLM` resolves the backend in this order, highest wins:

1. `opts.provider` passed at the call site
2. `LLM_PROVIDER` env var
3. `'claude_cli'` (local dev default — the only provider that needs no API
   key, since it leans on the dev's existing Claude Code auth)

Same priority for `opts.model` → provider's `DEFAULT_MODEL`. Timeout defaults
to 60 s; pass `opts.timeoutMs` to tune.

Providers must never throw — they return the model output string on success
or `null` on any failure path (missing key, network error, non-2xx,
malformed body). Callers rely on that to fall back without try/catch.

## Provider matrix

| provider     | env vars                                       | default model                       | free-tier notes                                                                 |
|--------------|------------------------------------------------|-------------------------------------|---------------------------------------------------------------------------------|
| `claude_cli` | _(none — uses the user's `claude` CLI auth)_   | `claude-haiku-4-5`                  | Local dev only. CLI binary doesn't exist on hosted boxes.                       |
| `groq`       | `GROQ_API_KEY`                                 | `llama-3.3-70b-versatile`           | Best free SVG quality. Free tier capped by RPM + TPM per model.                 |
| `gemini`     | `GEMINI_API_KEY`                               | `gemini-2.5-flash-lite`             | Free tier on 2.5-flash-lite is reliably available across regions. 2.0-flash and 1.5-flash often return 429/404 on newly issued AI Studio keys. |
| `cloudflare` | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`  | `@cf/meta/llama-3.1-8b-instruct`    | Free quota in "neurons/day". 8B default is weak on SVG; use bigger model.       |
| `openrouter` | `OPENROUTER_API_KEY`                           | `meta-llama/llama-3.3-70b-instruct:free` | Wide `:free` catalog. Peak-time 429s common; queues under load.            |

Optional OpenRouter env: `OPENROUTER_REFERRER`, `OPENROUTER_TITLE` — sent as
`HTTP-Referer` / `X-Title` for the OpenRouter dashboard's app attribution.
Leave unset if you don't want the app identified there.

## Configuration examples

Local dev (no setup required):
```bash
npm run dev
```

Hosted server with Groq (recommended free production setup):
```bash
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
```

Hosted server with Gemini (most generous quota):
```bash
LLM_PROVIDER=gemini
GEMINI_API_KEY=AIza...
```

Cloudflare Workers AI:
```bash
LLM_PROVIDER=cloudflare
CLOUDFLARE_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
```

Per-call override (use a different backend for one specific call):
```js
import { callLLM } from './llm/index.js';
const text = await callLLM(prompt, {
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  timeoutMs: 30_000,
});
```

## Adding a new generator

Pick one of two shapes based on complexity.

### Shape A — single file (`generators/<name>.js`)

For prompt → text → parse generators that have no further structure. Owns:

- a `buildPrompt(input)` function
- an `extract...` function that pulls the structured output back out of the
  raw text response
- an `export async function generate(input, opts)` that returns the
  extracted value or `null`

Example skeleton for a hypothetical scene-description generator:

```js
// server/llm/generators/scene_description.js
import { callLLM } from '../index.js';

function buildPrompt({ roomId, mood }) { /* ... */ }
function extractText(text) { /* ... */ }

export async function generate({ roomId, mood }, opts = {}) {
  const raw = await callLLM(buildPrompt({ roomId, mood }), {
    timeoutMs: 30_000,
    ...opts,
  });
  return extractText(raw);
}
```

Callers `import { generate } from './llm/generators/scene_description.js'`.

### Shape B — directory (`generators/<name>/`)

For multi-stage generators (LLM classify → in-house compose, etc.) like
`character_sprite/`. The directory must export `generate` from
`<name>/index.js`; everything else is internal. Use this when:

- the prompt produces a *structured intermediate* you want to inspect / cache
  separately from the final artifact, **or**
- the post-processing has its own substantial logic (palettes, parts,
  composition rules) that would crowd a single file.

Layout convention — keep the same names as `character_sprite/` to make new
directory generators feel familiar:

```
generators/<name>/
├── index.js                # generate() facade
├── classify.js             # LLM call → structured card
├── compose.js              # card → final artifact
└── (parts.js / palettes.js / cache.js as needed)
```

The dispatcher and providers don't need any changes either way — they're
agnostic to what the prompt is for.

## Picking a provider

- **Sprite/SVG quality matters → `groq` (70B Llama).** Larger model, free,
  fast. Default model handles structured SVG output well.
- **Volume matters more than quality → `gemini`.** Free quota is the most
  generous of the four hosted options. The default `gemini-2.5-flash-lite`
  is fast (~5 s for an SVG character sprite) and works on free-tier keys
  out of the box. 2.0/1.5 variants are gated behind paid quota or retired.
- **Already on Cloudflare for hosting → `cloudflare`.** Co-located, but
  swap the default 8B model for something larger before relying on it for
  sprites.
- **Need a model not on the others → `openrouter`.** Catalog is the widest
  but expect intermittent throttling.
- **Local dev → `claude_cli`.** No setup, real Claude Haiku quality.

## Failure modes

Every provider returns `null` and logs a single `[llm/<name>]` warn line on
failure. The character-sprite path treats `null` as "no AI sprite available"
and the player gets the default sprite — registration still completes. So
running with no provider configured is a graceful degradation, not a crash.

If you want an explicit fallback chain (e.g. groq → gemini → default),
wrap it at the call site or extend `callLLM` in `server/llm/index.js`.
There's no implicit retry today.
