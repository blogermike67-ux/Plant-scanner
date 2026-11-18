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
      console.log(`.env line ${i + 1} is not NAME=value (it must start with OPENAI_API_KEY=)`);
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

// models to try in order (names change often: see the Models page in the Gemini docs)
const MODELS = [process.env.GEMINI_MODEL, "gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite"].filter(Boolean);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.post("/api/identify", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is missing. Check your .env file." });
    }

    // the page sends "data:image/jpeg;base64,XXXX"; Gemini wants the type and the data separately
    const match = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(req.body.image || "");
    if (!match) {
      return res.status(400).json({ error: "No valid image sent" });
    }
    const [, mimeType, base64] = match;

    let data, lastStatus = 500, lastMessage = "", sawBusy = false;

    // Try each model. If one is busy (503) wait and retry it, then move on to the next model.
    outer:
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
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: PROMPT },
                  { inline_data: { mime_type: mimeType, data: base64 } }
                ]
              }],
              generationConfig: { responseMimeType: "application/json" } // forces JSON back
            })
          }
        );
        data = await r.json();
        lastStatus = r.status;
        lastMessage = data.error?.message || "";

        if (r.ok) break outer;                       // success
        console.log(`Gemini ${model} attempt ${attempt + 1}: ${r.status} ${lastMessage.slice(0, 80)}`);

        if ([500, 503, 429].includes(r.status)) sawBusy = true;
        if (r.status === 503 || r.status === 500) {  // busy: wait a little, then retry the same model
          await sleep(1500 * (attempt + 1));
          continue;
        }
        if (r.status === 404 || r.status === 429) break;  // unknown model or its quota is used: next model
        return res.status(r.status).json({ error: lastMessage || "Gemini request failed" });
      }
    }

    if (!data || data.error) {
      const busy = sawBusy;
      return res.status(busy ? 503 : lastStatus).json({
        error: busy
          ? "The AI is very busy right now. Please wait a minute and try again."
          : (lastMessage || "Gemini request failed")
      });
    }

    // pull the text out of the response, then turn it into an object
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("");

    let result;
    try {
      result = JSON.parse((text || "").replace(/^```(?:json)?|```$/g, "").trim());
    } catch {
      return res.status(502).json({ error: "The AI answer could not be read. Please try again." });
    }

    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));