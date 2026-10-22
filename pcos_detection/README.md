# Cycle Care

An educational PCOS (polycystic ovary syndrome, now also called PMOS) companion built on **retrieval-augmented generation (RAG)**. It answers questions, screens symptoms, tracks periods and explains ultrasound images using only passages retrieved from medical guidelines, and it shows the sources behind every answer.

> **Disclaimer:** educational project only. Not a medical device and not a diagnosis. Always consult a qualified clinician.

---

## Contents

1. [Features](#features)
2. [How it works](#how-it-works)
3. [Getting started](#getting-started)
4. [Using the app](#using-the-app)
5. [WhatsApp bot setup](#whatsapp-bot-setup)
6. [Adding documents to the knowledge base](#adding-documents-to-the-knowledge-base)
7. [Configuration](#configuration)
8. [Project structure](#project-structure)
9. [API reference](#api-reference)
10. [Troubleshooting](#troubleshooting)
11. [Limitations](#limitations)
12. [Knowledge sources](#knowledge-sources)

---

## Features

| Feature | What it does |
|---|---|
| **Home dashboard** | Cycle ring with today's cycle day and phase, next-period and fertile-window estimates, a daily tip generated from the guideline, and a logging streak. |
| **Period tracker** | Calendar logging (period, flow, symptoms, mood, notes), one-tap "period started today", past periods by date range, predictions, an irregular-cycle alert, a cycle-length chart and CSV export. |
| **Movement for today** | Exercise ideas for your cycle phase and logged symptoms, plus an AI plan grounded in the guideline. |
| **PCOS screening** | A structured report against the Rotterdam criteria: key factors, metabolic health, emotional wellbeing, recommendations, a next-steps timeline and tests to discuss. Can be filled from tracker data and saved as PDF. |
| **Ask the guidelines** | Streaming chat with clickable citations [S1], saved conversations, optional personalisation and Markdown export. |
| **Ultrasound (experimental)** | A vision model describes an uploaded image after a rule-based colour pre-check. Analyses are saved with a follow-up chat for each scan. |
| **WhatsApp bot** | The same cited chat over Twilio's WhatsApp sandbox. |
| **Two LLM providers** | OpenAI and Google Gemini, with automatic retry and fallback. |
| **Dark and light themes** | Dark by default, styled with [ChaiUI](https://ui.chaicode.com) design tokens. |

---

## How it works

```
                 ┌──────────── indexing (on startup) ────────────┐
data/*.pdf ──► text per page ──► overlapping chunks ──► OpenAI embeddings ──► vector index (cached JSON)
                                                                                        │
user question / profile ──► embed ──► cosine similarity, top-k passages ◄───────────────┘
                                              │
                                              ▼
                     system prompt + passages labelled [S1]..[Sn] ──► OpenAI or Gemini ──► cited answer
```

1. **Indexing:** every PDF in `data/` is split into pages and then into about 900-character overlapping chunks. Each chunk is embedded with `text-embedding-3-small`, and the index is cached to `web/data/vector_index.json`.
2. **Retrieval:** each request is embedded and compared with every chunk by cosine similarity. The top 3 to 6 passages are selected.
3. **Grounded generation:** only those passages are sent to the LLM, with a system prompt that encodes the Rotterdam criteria, safety rules (never diagnose) and, where needed, a strict JSON output schema. The model must cite passages as [S1], [S2] and so on.
4. **Transparency:** the retrieved passages, page numbers and similarity scores are shown under every answer.

**Stack:** Node.js, Express, the OpenAI and Google GenAI SDKs, and plain HTML, CSS and JavaScript (no build step). Personal data (tracker, chats, scans) is stored in the browser's localStorage.

---

## Getting started

### Prerequisites

- **Node.js 18 or later** (check with `node -v`)
- An **OpenAI API key** (required, used for embeddings and chat)
- A **Google Gemini API key** (optional, a second provider)

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd pcos_detection
```

### 2. Add your API keys

```bash
cp .env.example .env
```

Open `.env` and fill in:

```
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...        # optional
```

`.env` is git-ignored, so your keys are never committed.

### 3. Install dependencies

```bash
cd web
npm install
```

### 4. Start the server

```bash
npm start
```

Open **http://localhost:3000**.

**On the first start**, the server reads and embeds the PDFs in `data/`. This takes about a minute and costs roughly $0.01 in OpenAI usage. You will see:

```
[rag] Embedding Evidence-Based-Guidelines-2023.pdf...
[rag] Index ready: 1218 chunks from 4 document(s)
PCOS Care Assistant running at http://localhost:3000
```

Later starts load the cached index in a second or two.

### 5. Stop the server

Press `Ctrl + C` in the terminal.

---

## Using the app

A suggested first walkthrough:

1. **Home:** click **Try sample data** to load six months of irregular cycles, so every feature has data to show.
2. **Tracker:**
   - Click a day to log symptoms, mood or notes, then **Save day**.
   - Use **Period started today** when your period begins, or **Add a past period** to enter earlier periods by start and end date.
   - After 3 periods, the insights panel shows averages. If cycles fall outside 21 to 35 days, it raises an irregular-cycle alert with **Run screening with my cycle data**.
   - Under **Movement for today**, click **Personalise with AI** for a cited plan.
3. **Screening:** fill in the form (or click **Use my tracker data**) and click **Analyse my answers**. Click any [S1] chip to see the passage behind a claim. Use **Save as PDF** to export the report.
4. **Ask:** ask questions or pick a suggestion. Turn on **Personalise** to include your profile and cycle data. Chats are saved in the sidebar.
5. **Ultrasound:** upload a test image from `data/scans/`, click **Analyse image**, then ask follow-up questions. Try a normal colour photo too: the pre-check rejects it.
6. **How it works:** a live view of the RAG pipeline and the indexed documents.

Use the selector in the top bar to switch between **OpenAI** and **Gemini**. If the chosen provider fails, the app switches to the other one automatically and says so under the answer.

---

## WhatsApp bot setup

The bot answers PCOS questions on WhatsApp with the same RAG pipeline. It supports text only.

1. **Get an ngrok token.** Sign up at [ngrok](https://dashboard.ngrok.com/get-started/your-authtoken) and add it to `.env`:
   ```
   NGROK_AUTHTOKEN=...
   ```
2. **Restart the server** (`npm start`). It prints:
   ```
   [ngrok] Public URL:       https://xxxx.ngrok-free.app
   [ngrok] Twilio webhook:   https://xxxx.ngrok-free.app/whatsapp
   ```
3. **Configure Twilio.** In the [Twilio console](https://console.twilio.com), open **Messaging → Try it out → Send a WhatsApp message → Sandbox settings**. Paste the webhook URL into **When a message comes in**, set the method to **POST**, and save.
4. **Join the sandbox.** From your phone, send `join <your-code>` to the sandbox number shown in Twilio (+1 415 523 8886).
5. **Chat.** Send `hi`. Commands: `help` shows instructions, `reset` starts a new conversation.

The free ngrok URL changes each time the server restarts, so paste the new webhook URL into Twilio after every restart.

---

## Adding documents to the knowledge base

1. Put any PDF into `data/`.
2. Restart the server. Only the new file is embedded, and identical files are skipped automatically.
3. Optional: give it a readable title by adding the filename to `KNOWN_TITLES` in `web/rag.js`. Otherwise the title is generated from the filename.

The documents in use are listed in the **How it works** tab.

---

## Configuration

All settings go in `.env` in the project root.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | | Embeddings, chat and vision |
| `GEMINI_API_KEY` | No | | Second LLM provider and fallback |
| `NGROK_AUTHTOKEN` | No | | Public tunnel for the WhatsApp webhook |
| `PORT` | No | `3000` | Server port |
| `OPENAI_MODEL` | No | `gpt-4.1-mini` | Chat and screening model |
| `OPENAI_VISION_MODEL` | No | `gpt-4.1` | Ultrasound image model |
| `GEMINI_MODEL` | No | `gemini-3.8-flash` | Gemini chat model |
| `EMBED_MODEL` | No | `text-embedding-3-small` | Embedding model. Changing it rebuilds the index. |

---

## Project structure

```
pcos_detection/
├── .env.example            # template for API keys and settings
├── data/
│   ├── *.pdf               # knowledge base, indexed automatically
│   └── scans/              # sample ultrasound images for testing
└── web/
    ├── server.js           # Express app: routes, SSE streaming, WhatsApp webhook, ngrok
    ├── rag.js              # PDF parsing, chunking, embeddings, vector search
    ├── llm.js              # OpenAI and Gemini provider layer with retry and fallback
    ├── prompts.js          # system prompts and JSON output schemas
    ├── data/
    │   └── vector_index.json   # generated cache (git-ignored)
    └── public/
        ├── index.html      # single-page UI
        ├── styles.css      # ChaiUI-based theme (dark and light)
        └── app.js          # routing, tracker, screening, chat, ultrasound
```

---

## API reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/status` | Index statistics, available providers and models |
| POST | `/api/assess` | Screening report (JSON) for a profile |
| POST | `/api/chat` | Cited answer (JSON) |
| POST | `/api/chat/stream` | Cited answer streamed as Server-Sent Events (`sources`, `meta`, `delta`, `done`) |
| POST | `/api/image` | Ultrasound image analysis (JSON) |
| POST | `/api/image/chat/stream` | Follow-up questions about an analysed image (SSE) |
| POST | `/api/tip` | Tip of the day from the guideline |
| POST | `/api/wellness` | Movement and nutrition plan for the cycle phase |
| POST | `/whatsapp` | Twilio WhatsApp webhook (TwiML reply) |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `OPENAI_API_KEY is not set` or 401 errors | Check `.env` is in the project root (not in `web/`) and the key is valid. |
| `EADDRINUSE: address already in use :::3000` | Another server is running. Stop it, or set `PORT=3001` in `.env`. |
| Gemini answers say they switched provider | Gemini is overloaded (503) or unavailable. The app fell back to OpenAI automatically. |
| A new PDF is not used | Restart the server and check the `[rag]` lines in the terminal. |
| WhatsApp messages get no reply | Check the server is running, the ngrok URL in Twilio is current, it ends in `/whatsapp`, and the method is POST. |
| Page looks unstyled or old | Hard-refresh the browser (`Cmd + Shift + R` or `Ctrl + Shift + R`). |
| Reset all personal data | Tracker: **Clear all**. Chats and scans: delete them in their sidebars, or clear the site data in your browser. |

---

## Limitations

- Screening levels come from an LLM following guideline rules. They are not calibrated probabilities.
- Cycle and fertile-window predictions are calendar estimates and are unreliable with irregular cycles. Never use them for contraception.
- The ultrasound feature is not a validated diagnostic model.
- There are no user accounts yet: personal data lives in the browser, and WhatsApp conversation memory resets when the server restarts.
- The WhatsApp webhook does not yet verify Twilio request signatures. Add this before any production use.

---

## Knowledge sources

| Document | Source |
|---|---|
| International PMOS (formerly PCOS) Guideline, full, updated 2026 | [Monash University](https://www.monash.edu/medicine/mchri/pcos/guideline) |
| International PCOS Guideline 2023 (Summary) | [Monash University](https://www.monash.edu/medicine/mchri/pcos/guideline) |
| WHO Fact Sheet: PCOS (Jan 2026) | [World Health Organization](https://www.who.int/news-room/fact-sheets/detail/polycystic-ovary-syndrome) |
| FDA Fact Sheet: PCOS | [U.S. Food and Drug Administration](https://www.fda.gov/consumers/womens-health-topics/polycystic-ovary-syndrome-pcos) |

Sample images in `data/scans/` come from [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:Ultrasound_images_of_polycystic_ovaries) and are used under their Creative Commons licences. See each file's Commons page for its author and licence.
