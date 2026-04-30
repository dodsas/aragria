// Groq free-tier provider.
//
// Endpoint: OpenAI-compatible /chat/completions. Free tier carries strict
// rate limits per model (RPM + TPM) but no per-call cost. The 70B model
// produces SVG much more reliably than the 8B; pick larger when prompt
// quality matters, smaller (`llama-3.1-8b-instant`) when latency matters.
//
// Required env: GROQ_API_KEY

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export async function call({ prompt, model = DEFAULT_MODEL, timeoutMs = 60_000 }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.warn('[llm/groq] GROQ_API_KEY missing');
    return null;
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[llm/groq]', res.status, body.slice(0, 200));
      return null;
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.warn('[llm/groq] fetch failed:', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  } finally {
    clearTimeout(t);
  }
}
