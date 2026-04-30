// Public entry for the character-sprite generator.
//
// Pipeline (see character_sprite/README architecture comment in classify.js
// and compose.js for details):
//   1. Cache lookup by (name|description) hash — instant hit on repeats.
//   2. Classify free-form description → CharacterCard (LLM, with regex
//      keyword fallback; never returns null).
//   3. Compose card → SVG from the in-house parts library (deterministic,
//      < 5 ms, style-coherent).
//   4. Cache the result and return it.
//
// Contract is the same as the old prompt-based generator: returns an SVG
// string on success. Never returns null in the new pipeline — the keyword
// fallback always produces a card — but the type stays `string | null` for
// backward compat with callers that still treat null as "use default".

import { classify } from './classify.js';
import { compose } from './compose.js';
import * as cache from './cache.js';

export async function generate({ name, description }, opts = {}) {
  const k = cache.key(name, description);
  const hit = cache.get(k);
  if (hit) return hit;

  const card = await classify({ name, description }, opts);
  if (!card) return null; // shouldn't happen — keyword fallback always returns one
  const svg = compose(card);
  cache.set(k, svg);
  return svg;
}
