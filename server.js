const express = require("express");
const path = require("path");
const fs = require("fs");

// Read .env from the SAME folder as server.js (works from any terminal folder, no dotenv needed)
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath);
  // Notepad can save as UTF-16 ("Unicode"); decode that too
  let text = (raw[0] === 0xFF && raw[1] === 0xFE) ? raw.toString("utf16le") : raw.toString("utf8");
  text = text.replace(/^\uFEFF/, "");

  const names = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      names.push(m[1]);
    } else {
      console.log(`.env line ${i + 1} is not NAME=value (it must start with GEMINI_API_KEY=)`);
    }
  });
  console.log(".env variable names found:", names.length ? names.join(", ") : "none");
}
console.log(".env file found:", fs.existsSync(envPath), "| key loaded:", !!process.env.GEMINI_API_KEY);

const app = express();

app.use(express.json({ limit: "15mb" }));            // photos arrive as base64, so allow big bodies
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir)); // only the public folder is served, so .env and server.js stay private

// open the home page at http://localhost:3000/
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ======================================================================
//  SHARED GEMINI HELPERS (used by every route below)
// ======================================================================

// models to try in order (names change often: see the Models page in the Gemini docs)
const MODELS = [process.env.GEMINI_MODEL, "gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite"].filter(Boolean);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Tries each model. If one is busy (500/503) it waits and retries, then moves to the next model.
// Never throws: returns { ok:true, text } or { ok:false, status, error }
async function callGemini(body) {
  let lastStatus = 500, lastMessage = "", busy = false;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY
          },
          body: JSON.stringify(body)
        }
      );
      const d = await r.json();
      if (r.ok) {
        return { ok: true, text: d.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "" };
      }
      lastStatus = r.status;
      lastMessage = d.error?.message || "";
      console.log(`Gemini ${model} attempt ${attempt + 1}: ${r.status} ${lastMessage.slice(0, 80)}`);

      if ([500, 503, 429].includes(r.status)) busy = true;
      if (r.status === 503 || r.status === 500) {   // busy: wait a little, then retry the same model
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (r.status === 404 || r.status === 429) break;   // unknown model or its quota is used: next model
      return { ok: false, status: r.status, error: lastMessage || "Gemini request failed" };
    }
  }
  return {
    ok: false,
    status: busy ? 503 : lastStatus,
    error: busy
      ? "The AI is very busy right now. Please wait a minute and try again."
      : (lastMessage || "Gemini request failed")
  };
}

const parseJSON = (t) => JSON.parse((t || "").replace(/^```(?:json)?|```$/g, "").trim());

// returns true (and answers the request) when the key is missing
function missingKey(res) {
  if (process.env.GEMINI_API_KEY) return false;
  res.status(500).json({ error: "GEMINI_API_KEY is missing. Check your .env file." });
  return true;
}

// the page sends "data:image/jpeg;base64,XXXX"; Gemini wants the type and the data separately
function splitImage(dataUrl) {
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(dataUrl || "");
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

// ======================================================================
//  1. SCAN: identify plant + disease        (plantAi.html -> results.html)
// ======================================================================
const PROMPT = `You are a plant pathologist and a friendly gardening teacher. Look at this photo and reply with ONLY a JSON object (no other text) in exactly this shape:
{
  "is_plant": true,
  "plant": {
    "name": "common name",
    "scientific_name": "Genus species",
    "description": "2 sentences about this plant",
    "family": "plant family",
    "growth_type": "Annual, Perennial, Shrub, Tree...",
    "ideal_temperature": "e.g. 20-30°C"
  },
  "plain_english": {
    "plant_summary": "2-3 very simple sentences: what this plant is and why people grow it. No jargon.",
    "health_summary": "2-3 very simple sentences: is the plant OK or sick, and what is going on, like explaining to a friend who knows nothing about plants.",
    "do_this_today": ["2 to 4 super simple actions the person can do today"],
    "jargon_buster": [{"term": "a hard word you used or that is common for this plant", "meaning": "what it means in plain English"}]
  },
  "health": {
    "status": "healthy or diseased",
    "disease": "disease name, or null if healthy",
    "disease_scientific_name": "pathogen name, or null",
    "severity": "Low, Moderate or High, or null if healthy",
    "confidence": 85,
    "symptoms": ["3 to 5 short symptoms you can see or that match this disease"],
    "treatment": ["3 to 5 short, practical treatment steps (or care steps if healthy)"],
    "prevention": ["2 to 4 short prevention tips"],
    "when_to_call_expert": "one sentence: when the person should ask a local expert or agriculture office"
  },
  "care": {
    "water": "how much and how often",
    "sunlight": "sun needs",
    "soil": "best soil type and pH",
    "humidity": "humidity needs",
    "fertilizer": "what and when to feed",
    "best_time_to_plant": "season or months",
    "harvest_or_bloom": "when it flowers or can be harvested, or null"
  },
  "quick_facts": {
    "origin": "where it is originally from",
    "lifespan": "how long it lives",
    "height": "typical size when grown",
    "toxicity": "safe or harmful to pets and humans, in one short sentence",
    "edible": "yes / no / partly, with one short note"
  },
  "uses": ["3 to 5 short real-life uses or benefits (food, medicine, decoration, air, income...)"],
  "common_diseases": ["4 diseases this plant often gets"],
  "common_pests": ["3 to 4 pests that often attack this plant"],
  "fun_facts": ["3 surprising, true, short facts"]
}
"confidence" is a number from 0 to 100 for how sure you are. Use simple words everywhere. Never invent facts: if you do not know something, use null. If the photo is not a plant, reply {"is_plant": false}.`;

app.post("/api/identify", async (req, res) => {
  try {
    if (missingKey(res)) return;
    const img = splitImage(req.body.image);
    if (!img) return res.status(400).json({ error: "No valid image sent" });

    const out = await callGemini({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: img.mimeType, data: img.base64 } }] }],
      generationConfig: { responseMimeType: "application/json" } // forces JSON back
    });
    if (!out.ok) return res.status(out.status).json({ error: out.error });

    try {
      res.json({ result: parseJSON(out.text) });
    } catch {
      res.status(502).json({ error: "The AI answer could not be read. Please try again." });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ======================================================================
//  2. PLANT DOCTOR CHAT                                   (doctor.html)
// ======================================================================
const DOCTOR_PROMPT = `You are Plant Doctor, a friendly plant pathologist chatting with a home gardener or small farmer.
Use simple words and short paragraphs. Ask ONE short follow-up question when you need more detail (plant, symptoms, watering, sunlight, when it started).
When you have enough detail, give the most likely cause, then 2 to 4 clear steps to fix it. Never invent facts; say when you are unsure.
Only answer questions about plants, gardening, pests and growing. For anything else, politely steer back to plants.
For serious or spreading problems, suggest a local agriculture office. Keep replies under 150 words and do not use markdown symbols like ** or #.`;

app.post("/api/chat", async (req, res) => {
  try {
    if (missingKey(res)) return;
    const { messages = [], plant = "" } = req.body;
    const contents = messages.slice(-20).map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: String(m.text || "").slice(0, 2000) }]
    }));
    while (contents.length && contents[0].role === "model") contents.shift();   // Gemini wants the first turn from the user
    if (!contents.length || contents[contents.length - 1].role !== "user") {
      return res.status(400).json({ error: "No question sent" });
    }
    const system = DOCTOR_PROMPT + (plant ? ` The person is asking about this plant: ${String(plant).slice(0, 80)}.` : "");
    const out = await callGemini({ systemInstruction: { parts: [{ text: system }] }, contents });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ reply: out.text.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ======================================================================
//  3. PEST IDENTIFICATION                                  (pests.html)
// ======================================================================
const PEST_PROMPT = `You are an entomologist who helps gardeners. Look at this photo and reply with ONLY a JSON object in exactly this shape:
{
  "is_insect": true,
  "name": "common name",
  "scientific_name": "Genus species or null",
  "verdict": "Harmful, Beneficial or Neutral",
  "confidence": 85,
  "summary": "2 simple sentences: what it is and whether the gardener should worry",
  "what_it_does": ["2 to 3 short points on what it does to plants or to other insects"],
  "signs": ["2 to 4 signs of its presence on a plant (or what it looks like if it is beneficial)"],
  "do_this": ["2 to 4 simple actions to take today"],
  "natural_control": ["2 to 3 safe, natural ways to control it (for a beneficial insect, how to attract and keep it)"],
  "protect_note": "one sentence, e.g. which beneficial insects to avoid harming, or null"
}
"confidence" is 0 to 100. Use simple words. Never invent facts. If you cannot tell the species, give the closest group and lower the confidence.
If the photo has no insect or similar creature (spider, beetle, caterpillar, snail all count), reply {"is_insect": false}.`;

app.post("/api/pest", async (req, res) => {
  try {
    if (missingKey(res)) return;
    const img = splitImage(req.body.image);
    if (!img) return res.status(400).json({ error: "No valid image sent" });

    const out = await callGemini({
      contents: [{ parts: [{ text: PEST_PROMPT }, { inline_data: { mime_type: img.mimeType, data: img.base64 } }] }],
      generationConfig: { responseMimeType: "application/json" }
    });
    if (!out.ok) return res.status(out.status).json({ error: out.error });

    try {
      res.json({ result: parseJSON(out.text) });
    } catch {
      res.status(502).json({ error: "The AI answer could not be read. Please try again." });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ======================================================================
//  4. PLANT COMPATIBILITY                                   (compat.html)
// ======================================================================
const COMPAT_PROMPT = (a, b) => `You are a companion-planting expert. Decide whether these two plants grow well together in the same garden bed or pot:
Plant 1: ${a}
Plant 2: ${b}
Reply with ONLY a JSON object in exactly this shape:
{
  "is_valid": true,
  "score": 80,
  "verdict": "Great match, Good match, Risky or Bad match",
  "summary": "2 to 3 simple sentences explaining the verdict",
  "benefits": ["2 to 4 short ways they help each other (pests, shade, nutrients, pollination, space)"],
  "risks": ["2 to 4 short problems (competition, shared diseases, allelopathy, different water needs), or an empty list if none"],
  "tips": {
    "spacing": "short advice",
    "sunlight": "short advice",
    "water": "short advice",
    "soil": "short advice"
  },
  "alternatives": ["2 to 4 plants that grow better next to Plant 1 when the score is below 70, or an empty list"]
}
"score" is 0 to 100 (70+ good, 40-69 risky, below 40 bad). Use simple words. Never invent facts.
If either name is not a real plant, reply {"is_valid": false}.`;

app.post("/api/compat", async (req, res) => {
  try {
    if (missingKey(res)) return;
    const a = String(req.body.plant1 || "").trim().slice(0, 60);
    const b = String(req.body.plant2 || "").trim().slice(0, 60);
    if (!a || !b) return res.status(400).json({ error: "Send two plant names" });

    const out = await callGemini({
      contents: [{ parts: [{ text: COMPAT_PROMPT(a, b) }] }],
      generationConfig: { responseMimeType: "application/json" }
    });
    if (!out.ok) return res.status(out.status).json({ error: out.error });

    try {
      res.json({ result: parseJSON(out.text) });
    } catch {
      res.status(502).json({ error: "The AI answer could not be read. Please try again." });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));