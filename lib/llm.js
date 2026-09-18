// lib/llm.js
// Multi-provider LLM call with automatic fallback: Groq -> OpenRouter -> Gemini.
// Every agent (root cause, priority, remediation) goes through this single
// function so the fallback chain and JSON-parsing behavior stay consistent,
// and so the demo's "kill the Groq key live" moment only needs to work here.

const PROVIDERS = [
  { name: "groq", envKey: "GROQ_API_KEY", call: callGroq },
  { name: "openrouter", envKey: "OPENROUTER_API_KEY", call: callOpenRouter },
  { name: "gemini", envKey: "GEMINI_API_KEY", call: callGemini },
];

async function callGroq(systemPrompt, userPrompt) {
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { text: data.choices[0].message.content, model };
}

async function callOpenRouter(systemPrompt, userPrompt) {
  const model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { text: data.choices[0].message.content, model };
}

async function callGemini(systemPrompt, userPrompt) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { text: data.candidates[0].content.parts[0].text, model };
}

function stripFences(text) {
  return text.replace(/```json|```/g, "").trim();
}

/**
 * Calls the LLM with automatic provider fallback (Groq -> OpenRouter -> Gemini).
 * Skips providers with no API key set, so a partially-configured .env still works.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {boolean} parseJson - if true, parses and returns response as JSON
 * @returns {{ data: object|string, provider: string, model: string }}
 */
async function callLLM(systemPrompt, userPrompt, parseJson = true) {
  let lastError;

  for (const provider of PROVIDERS) {
    if (!process.env[provider.envKey]) continue;

    try {
      const { text, model } = await provider.call(systemPrompt, userPrompt);

      if (!parseJson) {
        return { data: text, provider: provider.name, model };
      }

      try {
        const data = JSON.parse(stripFences(text));
        return { data, provider: provider.name, model };
      } catch (parseErr) {
        console.warn(`[llm] ${provider.name} returned invalid JSON, trying next provider`);
        lastError = parseErr;
        continue;
      }
    } catch (err) {
      console.warn(`[llm] ${provider.name} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(
    `All LLM providers failed or are unconfigured. Last error: ${lastError?.message || "no API keys set in .env"}`
  );
}

module.exports = { callLLM };
