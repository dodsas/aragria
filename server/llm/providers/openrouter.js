// OpenRouter free-tier provider.
//
// Endpoint: OpenAI-compatible /chat/completions. Many models offered at $0
// with a `:free` suffix (subject to availability and per-model daily caps).
// Larger models queue under load; expect intermittent 429s during peak.
// Optional headers (HTTP-Referer / X-Title) are sent for OpenRouter's
// dashboard attribution — leave them blank if you don't want the app
// identified there.
//
// Required env: OPENROUTER_API_KEY
// Optional env: OPENROUTER_REFERRER, OPENROUTER_TITLE

const DEFAULT_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export async function call({ prompt, model = DEFAULT_MODEL, timeoutMs = 60_000 }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.warn('[llm/openrouter] OPENROUTER_API_KEY missing');
    return null;
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    };
    if (process.env.OPENROUTER_REFERRER) headers['HTTP-Referer'] = process.env.OPENROUTER_REFERRER;
    if (process.env.OPENROUTER_TITLE) headers['X-Title'] = process.env.OPENROUTER_TITLE;
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[llm/openrouter]', res.status, body.slice(0, 200));
      return null;
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.warn('[llm/openrouter] fetch failed:', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  } finally {
    clearTimeout(t);
  }
}
