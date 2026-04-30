// Character-sprite generator.
//
// One "use case" file. Owns its prompt template, reference exemplars, and
// extractor. Callers pass inputs; the generator builds the prompt, dispatches
// through the LLM router, and pulls the SVG out of the response. Adding a
// new use case (monster sprite, item view, scene description, ...) means
// adding a sibling file with the same shape — `generate(input, opts)` →
// string|null — not modifying this one.
//
// Provider/model selection: callers can pin a specific backend via
// opts.provider / opts.model; otherwise the dispatcher's defaults
// (LLM_PROVIDER env, then 'claude_cli') apply. The default timeout is 60s
// to accommodate slower free-tier endpoints; pass opts.timeoutMs to tune.

import { callLLM } from '../index.js';

const REFERENCE_GOBLIN = `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="50" cy="32" rx="16" ry="14" fill="#7ba84a" stroke="#2a1a10" stroke-width="0.8"/>
  <path d="M28,55 Q26,80 34,95 L66,95 Q74,80 72,55 Q60,52 50,52 Q40,52 28,55 Z" fill="#7ba84a" stroke="#2a1a10" stroke-width="0.8"/>
  <ellipse cx="44" cy="33" rx="2.6" ry="3" fill="#fff8e0"/>
  <ellipse cx="56" cy="33" rx="2.6" ry="3" fill="#fff8e0"/>
  <circle cx="44" cy="33.5" r="1.4" fill="#e84020"/>
  <circle cx="56" cy="33.5" r="1.4" fill="#e84020"/>
  <path d="M42,43 L58,43 L56,46 L52,48 L48,48 L44,46 Z" fill="#3a2410"/>
</svg>`;

const REFERENCE_SKELETON = `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="50" cy="30" rx="14" ry="16" fill="#f0eadc" stroke="#2a2520" stroke-width="0.8"/>
  <path d="M36,55 Q34,80 38,92 L62,92 Q66,80 64,55 Z" fill="#e5e0d0" stroke="#2a2520" stroke-width="0.7"/>
  <ellipse cx="44" cy="30" rx="3.2" ry="4" fill="#1a0a0a"/>
  <ellipse cx="56" cy="30" rx="3.2" ry="4" fill="#1a0a0a"/>
  <circle cx="44" cy="30" r="2" fill="#ff5020"/>
  <circle cx="56" cy="30" r="2" fill="#ff5020"/>
  <path d="M40,42 L60,42 L58,47 L42,47 Z" fill="#f0eadc" stroke="#2a2520" stroke-width="0.4"/>
</svg>`;

function buildPrompt({ name, description }) {
  return `당신은 한국어 텍스트 MUD 게임의 캐릭터 스프라이트 SVG 아티스트입니다.

플레이어 캐릭터의 SVG 스프라이트를 생성하세요. 응답은 <svg>...</svg> 마크업만 포함하고, 그 외 텍스트(설명, 코드 펜스, 마크다운, 안내문)는 절대 포함하지 마세요.

제약사항:
- viewBox="0 0 100 140"
- xmlns="http://www.w3.org/2000/svg" 포함
- 벡터 path/shape만 사용 (image, text, foreignObject 금지)
- 캐릭터는 정면을 향하고, 머리 위쪽이 y=10~20, 발 아래쪽이 y=130 근처에 위치
- 반드시 머리·몸통·두 팔·두 다리를 갖춘 인간형(humanoid) 실루엣으로 그릴 것 (몬스터/짐승/오브젝트 형태 금지)
- 카툰풍/판타지 일러스트 스타일, 또렷한 stroke 윤곽

판타지 RPG 스타일 가이드:
- 클래식 판타지 RPG의 모험가 스프라이트 분위기 (전사/마법사/도적/사제/궁수/음유시인/팔라딘/드루이드 등)
- 묘사에서 직업·장비·종족 단서가 있으면 시각적으로 반영할 것:
  · 무기 (검·도끼·창·단검·활·지팡이·홀·완드·메이스 등)는 손에 쥐거나 등/허리에 패용해 한 눈에 보이도록
  · 방어구 (판금·체인메일·가죽 갑옷·로브·천옷·후드·망토 등)와 부속품 (벨트·주머니·룬·메달·견갑·각반)을 추가
  · 머리장식/액세서리 (마법사 모자·왕관·뿔·복면·머리띠·이어링 등) 활용
- 묘사가 모호하면 표준 모험가 — 검과 작은 방패, 가죽 갑옷, 망토 — 으로 디폴트
- 컬러 팔레트는 판타지 톤 (가죽 갈색, 금속 은/회색, 천 청록·자주, 금속 액센트 골드·구리). 형광색·네온 금지
- 실루엣만 봐도 직업/역할이 추정될 수 있도록 무기·방어구를 또렷하게 배치할 것

참조 스프라이트 (스타일/스케일 기준만, 모양은 따라 그리지 말 것):
[고블린]
${REFERENCE_GOBLIN}

[해골 전사]
${REFERENCE_SKELETON}

이번에 그릴 캐릭터:
- 이름: ${name}
- 특징: ${description}

이 캐릭터의 SVG 스프라이트를 출력하세요.`;
}

function extractSvg(text) {
  if (!text) return null;
  // Non-greedy match handles models that wrap the SVG in code fences or
  // include extra commentary before/after the markup.
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  return m ? m[0] : null;
}

// Returns the generated SVG string, or null on any failure (LLM call failed,
// response had no <svg>, etc.). Callers MUST treat null as "use default".
export async function generate({ name, description }, opts = {}) {
  const raw = await callLLM(buildPrompt({ name, description }), {
    timeoutMs: 60_000,
    ...opts,
  });
  return extractSvg(raw);
}
