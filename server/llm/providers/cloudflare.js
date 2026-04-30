// Cloudflare Workers AI free-tier provider.
//
// Endpoint: per-model REST under the account. Free quota is metered as
// "neurons/day" — runs out fast on bigger models. The 8B Llama default is
// cheap on neurons but produces noticeably worse SVG; for serious sprite
// generation prefer Groq/Gemini and reserve Cloudflare for low-stakes uses.
//
// Required env: CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export async function call({ prompt, model = DEFAULT_MODEL, timeoutMs = 60_000 }) {
  const key = process.env.CLOUDFLARE_API_KEY;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!key || !account) {
    console.warn('[llm/cloudflare] CLOUDFLARE_API_KEY or CLOUDFLARE_ACCOUNT_ID missing');
    return null;
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ prompt }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[llm/cloudflare]', res.status, body.slice(0, 200));
      return null;
    }
    const j = await res.json();
    // Workers AI shapes responses as { result: { response: "..." } } for
    // text-generation models. Some image/embedding models differ — only
    // text providers go through this dispatcher.
    return j?.result?.response || null;
  } catch (err) {
    console.warn('[llm/cloudflare] fetch failed:', err?.name === 'AbortError' ? 'timeout' : (err?.message || err));
    return null;
  } finally {
    clearTimeout(t);
  }
}
