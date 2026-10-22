// Thin provider abstraction so the same prompts run on OpenAI or Google Gemini.
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");

const MODELS = {
  openai: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  gemini: process.env.GEMINI_MODEL || "gemini-3.8-flash",
};
// Image understanding needs a stronger model; the mini model hallucinated findings on non-ultrasound images.
const VISION_MODELS = {
  openai: process.env.OPENAI_VISION_MODEL || "gpt-4.1",
  gemini: process.env.GEMINI_VISION_MODEL || MODELS.gemini,
};

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const gemini = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

function available() {
  return { openai: !!openai, gemini: !!gemini };
}

function providerOrder(preferred) {
  return (preferred === "gemini" ? ["gemini", "openai"] : ["openai", "gemini"]).filter((p) => available()[p]);
}

function modelFor(provider, messages) {
  return (messages.some((m) => m.image) ? VISION_MODELS : MODELS)[provider];
}

// messages: [{ role: "user" | "assistant", text, image?: { mimeType, base64 } }]
function toGemini(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.text }, ...(m.image ? [{ inlineData: { mimeType: m.image.mimeType, data: m.image.base64 } }] : [])],
  }));
}

function toOpenAI(system, messages) {
  return [
    { role: "system", content: system },
    ...messages.map((m) => ({
      role: m.role,
      content: m.image
        ? [
            { type: "text", text: m.text },
            { type: "image_url", image_url: { url: `data:${m.image.mimeType};base64,${m.image.base64}` } },
          ]
        : m.text,
    })),
  ];
}

// Retries transient errors, then falls back to the other provider so a live demo never dead-ends.
async function complete(opts) {
  let lastErr;
  for (const provider of providerOrder(opts.provider)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const model = modelFor(provider, opts.messages);
        const text = await callProvider({ ...opts, provider, model });
        return { text, provider, model, fallback: provider !== opts.provider };
      } catch (err) {
        lastErr = err;
        console.warn(`[llm] ${provider} attempt ${attempt + 1} failed: ${err.message.slice(0, 120)}`);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  throw lastErr;
}

// Streams text deltas. Falls back to the other provider only if nothing has been emitted yet.
async function* stream(opts) {
  let lastErr;
  for (const provider of providerOrder(opts.provider)) {
    let emitted = false;
    try {
      const model = modelFor(provider, opts.messages);
      yield { meta: { provider, model, fallback: provider !== opts.provider } };
      for await (const delta of streamProvider({ ...opts, provider, model })) {
        emitted = true;
        yield { delta };
      }
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[llm] ${provider} stream failed: ${err.message.slice(0, 120)}`);
      if (emitted) throw err;
    }
  }
  throw lastErr;
}

async function* streamProvider({ provider, model, system, messages, temperature = 0.3 }) {
  if (provider === "gemini") {
    const res = await gemini.models.generateContentStream({
      model,
      contents: toGemini(messages),
      config: { systemInstruction: system, temperature },
    });
    for await (const chunk of res) if (chunk.text) yield chunk.text;
    return;
  }
  const res = await openai.chat.completions.create({ model, temperature, stream: true, messages: toOpenAI(system, messages) });
  for await (const chunk of res) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

async function callProvider({ provider, model, system, messages, json = false, temperature = 0.3, maxTokens }) {
  if (provider === "gemini") {
    const res = await gemini.models.generateContent({
      model,
      contents: toGemini(messages),
      config: {
        systemInstruction: system,
        temperature,
        ...(maxTokens && { maxOutputTokens: maxTokens }),
        ...(json && { responseMimeType: "application/json" }),
      },
    });
    return res.text;
  }
  const res = await openai.chat.completions.create({
    model,
    temperature,
    ...(maxTokens && { max_tokens: maxTokens }),
    ...(json && { response_format: { type: "json_object" } }),
    messages: toOpenAI(system, messages),
  });
  return res.choices[0].message.content;
}

module.exports = { complete, stream, available, MODELS, VISION_MODELS };
