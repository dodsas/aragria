// LLM dispatcher.
//
// Provides a single `callLLM(prompt, opts)` entrypoint that routes to the
// configured backend. Backends live in ./providers/*.js and each export a
// `call({ prompt, model, timeoutMs })` returning a string (model output) or
// null (any failure path: missing key, network error, non-2xx, parse miss).
// Providers must NEVER throw — callers rely on the null-on-failure contract
// to fall back gracefully without try/catch boilerplate.
//
// Selection priority (highest wins):
//   1. opts.provider passed at call site
//   2. LLM_PROVIDER env var
//   3. 'claude_cli' (local dev default; the only provider with no API key)
//
// Each provider auto-picks a small/fast default model unless opts.model
// overrides it. Per-provider env vars are read inside the provider so this
// dispatcher stays agnostic.

import { call as claudeCli } from './providers/claude_cli.js';
import { call as gemini } from './providers/gemini.js';
import { call as groq } from './providers/groq.js';
import { call as cloudflare } from './providers/cloudflare.js';
import { call as openrouter } from './providers/openrouter.js';

const PROVIDERS = {
  claude_cli: claudeCli,
  gemini,
  groq,
  cloudflare,
  openrouter,
};

export function listProviders() {
  return Object.keys(PROVIDERS);
}

export async function callLLM(prompt, opts = {}) {
  const name = opts.provider || process.env.LLM_PROVIDER || 'claude_cli';
  const fn = PROVIDERS[name];
  if (!fn) {
    console.warn(`[llm] unknown provider "${name}". known:`, Object.keys(PROVIDERS).join(', '));
    return null;
  }
  return fn({
    prompt,
    model: opts.model,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
}
