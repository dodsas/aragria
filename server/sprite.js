// Public sprite-generation facade. Thin wrapper over the per-situation
// generator in ./llm/generators/character_sprite.js so the rest of the
// codebase doesn't need to know about the LLM dispatcher's existence.
//
// Behavior contract preserved from before the LLM module split: returns the
// generated SVG string, or null on any failure (provider missing, network
// error, malformed output). Callers fall back to the default sprite on null.
//
// Provider/model selection happens through env vars in the LLM dispatcher.
// See server/llm/index.js for the priority order. To swap backends in
// production, set LLM_PROVIDER=groq (or gemini/cloudflare/openrouter) and
// the matching API-key env var on the host.

import { generate as generateCharacter } from './llm/generators/character_sprite.js';

export async function generateCharacterSprite(name, description) {
  return generateCharacter({ name, description });
}
