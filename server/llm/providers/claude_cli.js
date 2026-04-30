// Local Claude Code CLI provider.
//
// Shells out to the user-installed `claude` binary in print mode. Useful for
// local dev (no API key required — leverages the dev's existing Claude Code
// auth) but unusable in hosted environments where the CLI binary doesn't
// exist. For deployment, swap to one of the HTTP providers via LLM_PROVIDER.

import { spawn } from 'node:child_process';

const DEFAULT_MODEL = 'claude-haiku-4-5';

export async function call({ prompt, model = DEFAULT_MODEL, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('claude', ['-p', '--model', model], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.warn('[llm/claude_cli] spawn failed:', err?.message || err);
      resolve(null);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };

    proc.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    proc.on('error', (err) => {
      console.warn('[llm/claude_cli] error:', err?.message || err);
      settle(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn('[llm/claude_cli] exit', code, stderr.slice(0, 300));
        settle(null);
      } else {
        settle(stdout);
      }
    });

    const killer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      console.warn('[llm/claude_cli] timeout');
      settle(null);
    }, timeoutMs);
    proc.on('close', () => clearTimeout(killer));

    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch (err) {
      console.warn('[llm/claude_cli] stdin write failed:', err?.message || err);
      settle(null);
    }
  });
}
