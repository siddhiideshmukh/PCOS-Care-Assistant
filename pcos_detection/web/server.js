const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const express = require("express");
const rag = require("./rag");
const llm = require("./llm");
const prompts = require("./prompts");

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

function parseJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

function describeProfile(p) {
  const yes = (v) => (v ? "Yes" : "No");
  return [
    `Age: ${p.age}`,
    `BMI: ${p.bmi}`,
    p.waist ? `Waist circumference: ${p.waist} cm` : null,
    `Cycle length: ${p.cycleLength} days (${p.cycleRegularity})`,
    p.cycleSummary ? `Period tracker data: ${p.cycleSummary}` : null,
    `Recent weight gain: ${yes(p.weightGain)}`,
    `Excess hair growth (hirsutism): ${yes(p.hirsutism)}`,
    `Acne/pimples: ${yes(p.acne)}`,
    `Hair loss/thinning: ${yes(p.hairLoss)}`,
    `Skin darkening: ${yes(p.skinDarkening)}`,
    `Frequent fast food: ${yes(p.fastFood)}`,
    `Regular exercise: ${yes(p.exercise)}`,
    p.sleepIssues !== undefined ? `Snoring or daytime sleepiness: ${yes(p.sleepIssues)}` : null,
    p.familyHistory !== undefined ? `Family history of PCOS or type 2 diabetes: ${yes(p.familyHistory)}` : null,
    p.lowMood !== undefined ? `Low mood or anxiety: ${yes(p.lowMood)}` : null,
    p.tryingToConceive !== undefined ? `Trying to conceive: ${yes(p.tryingToConceive)}` : null,
    p.notes ? `Additional notes: ${p.notes}` : null,
  ].filter(Boolean).join("\n");
}

function handle(fn) {
  return async (req, res) => {
    const started = Date.now();
    try {
      res.json({ ...(await fn(req.body)), latencyMs: Date.now() - started });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  };
}

app.get("/api/status", (req, res) => {
  res.json({ rag: rag.stats(), providers: llm.available(), models: llm.MODELS, visionModels: llm.VISION_MODELS });
});

app.post("/api/assess", handle(async ({ profile, provider }) => {
  const profileText = describeProfile(profile);
  const query = `PCOS diagnosis criteria and lifestyle management for: ${profileText.replace(/\n/g, "; ")}`;
  const sources = await rag.search(query, 6);
  const { text, ...meta } = await llm.complete({
    provider,
    json: true,
    system: prompts.ASSESS,
    messages: [{ role: "user", text: `PATIENT PROFILE:\n${profileText}\n\nGUIDELINE EXCERPTS:\n${rag.formatContext(sources)}` }],
  });
  return { result: parseJSON(text), sources, ...meta };
}));

const TIP_TOPICS = [
  "physical activity recommendations", "healthy eating patterns", "sleep and obstructive sleep apnea",
  "depression and anxiety screening", "body image and self-compassion", "weight stigma and healthy lifestyle",
  "type 2 diabetes risk and glucose testing", "cardiovascular risk", "irregular menstrual cycles",
  "hair growth and hirsutism management", "acne management", "behavioural strategies for lifestyle change",
];

app.post("/api/tip", handle(async ({ provider, seed = Date.now() }) => {
  const topic = TIP_TOPICS[Math.abs(Math.floor(seed)) % TIP_TOPICS.length];
  const sources = await rag.search(`PCOS ${topic}`, 3);
  const { text, ...meta } = await llm.complete({
    provider,
    json: true,
    system: prompts.TIP,
    messages: [{ role: "user", text: `TOPIC: ${topic}\n\nEXCERPTS:\n${rag.formatContext(sources)}` }],
  });
  const tip = parseJSON(text);
  const cited = sources[(parseInt(String(tip.source).replace(/\D/g, ""), 10) || 1) - 1] || sources[0];
  return { ...tip, topic, source: { doc: cited.doc, page: cited.page }, ...meta };
}));

app.post("/api/wellness", handle(async ({ provider, phase, cycleDay, symptoms = [], cycleSummary }) => {
  const sources = await rag.search(`PCOS physical activity exercise and diet recommendations ${symptoms.join(" ")}`, 5);
  const { text, ...meta } = await llm.complete({
    provider,
    json: true,
    system: prompts.WELLNESS,
    messages: [{
      role: "user",
      text: `CYCLE PHASE: ${phase || "unknown"}${cycleDay ? ` (day ${cycleDay})` : ""}\nSYMPTOMS TODAY: ${symptoms.join(", ") || "none logged"}\nCYCLE STATS: ${cycleSummary || "not enough data"}\n\nGUIDELINE EXCERPTS:\n${rag.formatContext(sources)}`,
    }],
  });
  return { result: parseJSON(text), sources, ...meta };
}));

// Retrieves guideline passages for the latest question and builds the grounded chat request.
async function prepareChat({ messages, provider, profile }) {
  const question = messages[messages.length - 1].text;
  const sources = await rag.search(question, 4);
  const history = messages.slice(-8, -1).map(({ role, text }) => ({ role, text }));
  const profileText = profile ? `PATIENT PROFILE:\n${describeProfile(profile)}\n\n` : "";
  const request = {
    provider,
    system: prompts.CHAT,
    messages: [
      ...history,
      { role: "user", text: `${profileText}GUIDELINE EXCERPTS:\n${rag.formatContext(sources)}\n\nQUESTION: ${question}` },
    ],
  };
  return { request, sources };
}

app.post("/api/chat", handle(async (body) => {
  const { request, sources } = await prepareChat(body);
  const { text, ...meta } = await llm.complete(request);
  return { answer: text, sources, ...meta };
}));

// Server-Sent Events: "sources" first, then "meta", "delta" tokens, and finally "done" (or "error").
function sseRoute(prepare) {
  return async (req, res) => {
    const started = Date.now();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const { request, sources } = await prepare(req.body);
      send("sources", sources);
      for await (const part of llm.stream(request)) {
        if (part.meta) send("meta", part.meta);
        else send("delta", part.delta);
      }
      send("done", { latencyMs: Date.now() - started });
    } catch (err) {
      console.error(err);
      send("error", { error: err.message });
    }
    res.end();
  };
}

app.post("/api/chat/stream", sseRoute(prepareChat));

function parseDataUrl(image) {
  const [, mimeType, base64] = String(image).match(/^data:(.+?);base64,(.+)$/) || [];
  if (!base64) throw new Error("Invalid image upload");
  return { mimeType, base64 };
}

// Follow-up questions about an analysed scan: the image + earlier analysis + retrieved passages go to the vision model.
app.post("/api/image/chat/stream", sseRoute(async ({ image, analysis, messages, provider }) => {
  const question = messages[messages.length - 1].text;
  const sources = await rag.search(`pelvic ultrasound polycystic ovarian morphology: ${question}`, 4);
  const history = messages.slice(-6, -1).map(({ role, text }) => ({ role, text }));
  return {
    sources,
    request: {
      provider,
      system: prompts.IMAGE_CHAT,
      messages: [
        { role: "user", text: `This is the uploaded image. Your earlier analysis:\n${JSON.stringify(analysis)}`, image: parseDataUrl(image) },
        { role: "assistant", text: "Understood. I will answer questions about this image." },
        ...history,
        { role: "user", text: `KNOWLEDGE-BASE EXCERPTS:\n${rag.formatContext(sources)}\n\nQUESTION: ${question}` },
      ],
    },
  };
}));

// Ultrasound scans are grayscale; the browser measures colour saturation (0-1) before upload.
const MAX_ULTRASOUND_SATURATION = 0.15;

app.post("/api/image", handle(async ({ image, provider, saturation }) => {
  const { mimeType, base64 } = parseDataUrl(image);
  if (saturation > MAX_ULTRASOUND_SATURATION) {
    return {
      result: {
        is_ultrasound: false,
        image_description: `Rejected by pre-check: the image is too colourful (saturation ${saturation.toFixed(2)}) to be a medical ultrasound, which is grayscale.`,
        pcom_features: [],
        assessment: "Please upload a grayscale pelvic ultrasound image.",
        limitations: "Rule-based pre-check; the AI model was not called.",
      },
      provider: "pre-check",
      model: "rule-based",
    };
  }
  const { text, ...meta } = await llm.complete({
    provider,
    json: true,
    temperature: 0,
    system: prompts.IMAGE,
    messages: [{ role: "user", text: "Analyse this image. First decide honestly whether it is a medical ultrasound at all.", image: { mimeType, base64 } }],
  });
  const result = parseJSON(text);
  if (!result.is_ultrasound) result.pcom_features = [];
  return { result, ...meta };
}));

// ---------- WhatsApp bot (Twilio sandbox webhook) ----------
const WHATSAPP_TIMEOUT_MS = 12000; // Twilio gives up after 15 s
const WHATSAPP_HELP = [
  "*PCOS Care Assistant* 🩺",
  "Ask me anything about PCOS, e.g. _What diet is best for PCOS?_",
  "Answers come from the International PCOS Guideline, WHO and FDA documents.",
  "",
  "Commands: *reset* — start a new conversation · *help* — show this message",
  "_Educational use only, not medical advice._",
].join("\n");
const whatsappSessions = new Map(); // phone number -> recent messages

const xmlEscape = (s) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

async function whatsappAnswer(from, text) {
  const command = text.trim().toLowerCase();
  if (["help", "hi", "hello", "start"].includes(command)) return WHATSAPP_HELP;
  if (command === "reset") {
    whatsappSessions.delete(from);
    return "🔄 Conversation reset. Ask me a new question!";
  }
  const history = whatsappSessions.get(from) || [];
  const messages = [...history, { role: "user", text }];
  const { request, sources } = await prepareChat({ messages, provider: "openai" });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), WHATSAPP_TIMEOUT_MS));
  const { text: answer } = await Promise.race([llm.complete({ ...request, system: prompts.WHATSAPP, maxTokens: 350 }), timeout]);
  whatsappSessions.set(from, [...messages, { role: "assistant", text: answer }].slice(-8));
  return `${answer.trim()}\n\n📖 _Sources: ${shortSources(sources)}_`.slice(0, 1550);
}

// "International PMOS (formerly PCOS) Guideline, full, updated 2026" p.134 + p.46 -> "PMOS Guideline 2026 p.134, 46"
function shortSources(sources) {
  const short = (doc) => doc
    .replace("International PMOS (formerly PCOS) Guideline, full, updated 2026", "PMOS Guideline 2026")
    .replace("International PCOS Guideline 2023 (Summary)", "PCOS Guideline 2023")
    .replace(/^(WHO|FDA) Fact Sheet.*$/, "$1 fact sheet");
  const byDoc = new Map();
  for (const s of sources) byDoc.set(short(s.doc), [...new Set([...(byDoc.get(short(s.doc)) || []), s.page])]);
  return [...byDoc].map(([doc, pages]) => `${doc} p.${pages.join(", ")}`).join("; ");
}

app.post("/whatsapp", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From || "unknown";
  const text = (req.body.Body || "").trim();
  console.log(`[whatsapp] ${from}: ${text.slice(0, 80)}${+req.body.NumMedia ? " [media]" : ""}`);
  let reply;
  try {
    if (+req.body.NumMedia && !text) reply = "📷 Image analysis is available in the web app's Ultrasound tab. Here, please send your question as text.";
    else reply = await whatsappAnswer(from, text || "help");
  } catch (err) {
    console.error("[whatsapp]", err.message);
    reply = "⚠️ Sorry, that took too long or failed. Please try asking again in a moment.";
  }
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(reply)}</Message></Response>`);
});

let publicUrl = null;
app.get("/api/public-url", (req, res) => res.json({ publicUrl }));

rag.buildIndex().then(() => {
  app.listen(PORT, async () => {
    console.log(`PCOS Care Assistant running at http://localhost:${PORT}`);
    if (!process.env.NGROK_AUTHTOKEN) return console.log("[ngrok] NGROK_AUTHTOKEN not set; skipping public tunnel");
    try {
      const ngrok = require("@ngrok/ngrok");
      const listener = await ngrok.forward({ addr: PORT, authtoken_from_env: true });
      publicUrl = listener.url();
      console.log(`[ngrok] Public URL:       ${publicUrl}`);
      console.log(`[ngrok] Twilio webhook:   ${publicUrl}/whatsapp   (paste into "When a message comes in", method POST)`);
    } catch (err) {
      console.error("[ngrok] Failed to start tunnel:", err.message);
    }
  });
});
