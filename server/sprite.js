// Character sprite generation. Mirrors the monster-sprite rule (each entity
// has its own SVG, viewBox 0 0 100 140, vector paths only) but produced at
// runtime from the player's free-form description.
//
// Backend: shells out to the local `claude` CLI in print mode. This avoids
// requiring a separate ANTHROPIC_API_KEY for the server — the user's existing
// CLI authentication does the work. Each call spawns a short-lived subprocess
// and feeds the prompt via stdin.
//
// Graceful degradation: if `claude` is missing, errors out, or the response
// has no <svg>, this returns null and callers fall back to the default
// player sprite shipped in the client.

import { spawn } from 'node:child_process';

const CLI_TIMEOUT_MS = 60_000;
// Cheaper/faster model is plenty for ~30-50 path SVGs and keeps the CLI call
// from monopolizing the user's session quota.
const MODEL = 'claude-haiku-4-5';

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

function buildPrompt(name, description) {
  return `당신은 한국어 텍스트 MUD 게임의 캐릭터 스프라이트 SVG 아티스트입니다.

플레이어 캐릭터의 SVG 스프라이트를 생성하세요. 응답은 <svg>...</svg> 마크업만 포함하고, 그 외 텍스트(설명, 코드 펜스, 마크다운, 안내문)는 절대 포함하지 마세요.

제약사항:
- viewBox="0 0 100 140"
- xmlns="http://www.w3.org/2000/svg" 포함
- 벡터 path/shape만 사용 (image, text, foreignObject 금지)
- 캐릭터는 정면을 향하고, 머리 위쪽이 y=10~20, 발 아래쪽이 y=130 근처에 위치
- 카툰풍/판타지 일러스트 스타일, 또렷한 stroke 윤곽

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
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  return m ? m[0] : null;
}

// Run `claude -p --model <m>` with the prompt on stdin. Resolves with the
// captured stdout (possibly containing the SVG markup) or null on failure.
// Never throws.
function callClaudeCli(prompt) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('claude', ['-p', '--model', MODEL], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.warn('[sprite] claude CLI spawn failed:', err?.message || err);
      resolve(null);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (err) => {
      console.warn('[sprite] claude CLI error:', err?.message || err);
      settle(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn('[sprite] claude CLI exited', code, stderr.slice(0, 300));
        settle(null);
      } else {
        settle(stdout);
      }
    });

    const killer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      console.warn('[sprite] claude CLI timed out');
      settle(null);
    }, CLI_TIMEOUT_MS);
    proc.on('close', () => clearTimeout(killer));

    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch (err) {
      console.warn('[sprite] claude CLI stdin write failed:', err?.message || err);
      settle(null);
    }
  });
}

// Returns the generated SVG string, or null on any failure (CLI missing,
// non-zero exit, malformed response). Callers MUST handle null by using a
// default sprite.
export async function generateCharacterSprite(name, description) {
  const raw = await callClaudeCli(buildPrompt(name, description));
  return extractSvg(raw);
}
