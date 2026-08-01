const AI_LATENCY_MS = Number(process.env.AI_LATENCY_MS || 2500);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockCall(payload, onProgress) {
  const prompt = payload.prompt || 'no prompt';
  const tokens = prompt.split(/\s+/).length;
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - started;
      onProgress(Math.min(90, Math.round((elapsed / AI_LATENCY_MS) * 90)));
    }, 250);
    setTimeout(() => {
      clearInterval(tick);
      onProgress(100);
      resolve({
        model: 'mock-llm-1 (offline, no OPENAI_API_KEY set)',
        summary: `Summary of "${prompt.slice(0, 60)}": ${tokens} tokens analyzed, key ideas ranked, tl;dr ready.`,
        usage: { input_tokens: tokens, output_tokens: Math.max(10, Math.round(tokens / 4)) },
      });
    }, AI_LATENCY_MS);
  });
}

async function realCall(payload, onProgress) {
  const body = {
    model: payload.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You write concise, useful summaries. Reply with JSON: {"summary": "..."}' },
      { role: 'user', content: `Summarize: ${payload.prompt}` },
    ],
    temperature: 0.3,
    stream: true,
  };
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`AI API error: HTTP ${response.status} ${await response.text()}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    text += decoder.decode(value, { stream: true });
    onProgress(Math.min(90, Math.round((received / 4000) * 90)));
  }
  onProgress(100);
  const delta = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
  if (!delta) throw new Error('AI API returned no content');
  return { model: body.model, summary: delta, usage: { streamed_bytes: received } };
}

async function callAi(payload, onProgress) {
  if (OPENAI_API_KEY) return realCall(payload, onProgress);
  return mockCall(payload, onProgress);
}

module.exports = { callAi, AI_LATENCY_MS };
