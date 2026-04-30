// Public sprite-generation facade. Thin wrapper over the per-situation
// generator in ./llm/generators/character_sprite/ so the rest of the
// codebase doesn't need to know about the classify-and-compose pipeline.
//
// Behavior contract: returns the generated SVG string. The new pipeline
// (LLM classifier → card → in-house composer) effectively never returns
// null — the keyword fallback inside classify.js always produces a card —
// but callers still treat null as "use default" for forward-compat.
//
// Provider/model selection happens through env vars in the LLM dispatcher.
// See server/llm/index.js for the priority order. To swap backends in
// production, set LLM_PROVIDER=groq (or gemini/cloudflare/openrouter) and
// the matching API-key env var on the host.

import { generate as generateCharacter } from './llm/generators/character_sprite/index.js';

export async function generateCharacterSprite(name, description) {
  return generateCharacter({ name, description });
}

// 등록 절차를 스킵하는 자동 등록 모드(REGISTRATION_ENABLED=false)에서 모든
// 신규 접속자가 공유하는 디폴트 스프라이트. cache.js는 (name|description)을
// 키로 쓰는데 자동 등록은 이름이 `방랑자-{id}`로 매번 달라져 캐시 미스가 나고,
// 결과적으로 접속자마다 분류기·합성이 새로 돈다. 이름을 비워 한 번만 만들고
// 모듈 레벨에 보관해 같은 SVG를 즉시 재사용한다. 첫 호출의 in-flight Promise를
// 그대로 캐싱하므로 동시 접속 N건에 대해서도 generate는 1회만 실행된다.
let defaultSpritePromise = null;
export function getDefaultCharacterSprite(description) {
  if (!defaultSpritePromise) {
    defaultSpritePromise = generateCharacter({ name: '', description })
      .catch((err) => { defaultSpritePromise = null; throw err; });
  }
  return defaultSpritePromise;
}
