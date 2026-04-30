# LLM module

Per-situation prompt + interchangeable backend layer for everything in the
game that needs a generative model (character sprites today, monster
sprites / item views / scene descriptions in the future).

## Layout

```
server/llm/
├── index.js                         # callLLM(prompt, opts) dispatcher
├── providers/
│   ├── claude_cli.js                # local Claude Code CLI
│   ├── groq.js                      # Groq /chat/completions
│   ├── gemini.js                    # Google AI Studio
│   ├── cloudflare.js                # Workers AI
│   └── openrouter.js                # OpenRouter free models
└── generators/
    └── character_sprite.js          # one use case = one file
```

`server/sprite.js` is a thin facade so `game.js` keeps its existing
`import { generateCharacterSprite } from './sprite.js'`.

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

Each generator is one file under `server/llm/generators/` that owns:

- a `buildPrompt(input)` function
- an `extract...` function that pulls the structured output back out of the
  raw text response
- an `export async function generate(input, opts)` that returns the
  extracted value or `null`

Example skeleton for a monster-sprite generator:

```js
// server/llm/generators/monster_sprite.js
import { callLLM } from '../index.js';

function buildPrompt({ defId, lore }) { /* ... */ }
function extractSvg(text) { /* ... */ }

export async function generate({ defId, lore }, opts = {}) {
  const raw = await callLLM(buildPrompt({ defId, lore }), {
    timeoutMs: 60_000,
    ...opts,
  });
  return extractSvg(raw);
}
```

Callers `import { generate } from './llm/generators/monster_sprite.js'`.
The dispatcher and providers don't need any changes — they're agnostic to
what the prompt is for.

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
