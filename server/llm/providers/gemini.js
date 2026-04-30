// Google AI Studio (Gemini) free-tier provider.
//
// Endpoint: native Gemini REST (not OpenAI-compatible). The free tier has
// the most generous quota of the providers wired up here; 2.0 Flash is fast
// and the Lite variant is even faster but produces messier SVG. Safety
// settings default-strict; SVG outputs rarely trip them but if a description
// includes violent content the API may return empty candidates.
//
// Required env: GEMINI_API_KEY

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function call({ prompt, model = DEFAULT_MODEL, timeoutMs = 60_000 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn('[llm/gemini] GEMINI_API_KEY missing');
    return null;
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[llm/gemini]', res.status, body.slice(0, 200));
      return null;
    }
    const j = await res.json();
    const parts = j?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return null;
    return parts.map(p => p?.text || '').join('') || null;
  } catch (err) {
    console.warn('[llm/gemini] fetch failed:', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  } finally {
    clearTimeout(t);
  }
}
