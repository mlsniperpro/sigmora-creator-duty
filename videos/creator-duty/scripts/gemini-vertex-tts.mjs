#!/usr/bin/env node

// Competition narration generator for Creator Duty.
//
// This deliberately has one provider: Gemini 3.1 Flash TTS Preview through
// Vertex AI. A missing credential, quota error, safety response, or malformed
// audio response is a hard failure. The submission must never silently change
// voice providers.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(HERE, "..");
const DEFAULT_PROJECT = "sigmora-creator-duty-2026";
const DEFAULT_LOCATION = "us-central1";
const DEFAULT_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_VOICE = "Kore";
const DEFAULT_LANGUAGE = "en-US";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};

const project = arg("project", process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT);
const location = arg("location", process.env.GOOGLE_CLOUD_REGION || DEFAULT_LOCATION);
const model = arg("model", DEFAULT_MODEL);
const voice = arg("voice", DEFAULT_VOICE);
const language = arg("language", DEFAULT_LANGUAGE);
const scriptPath = resolve(arg("script", join(PROJECT_DIR, "SCRIPT.md")));
const storyboardPath = resolve(arg("storyboard", join(PROJECT_DIR, "STORYBOARD.md")));
const outPath = resolve(arg("out", join(PROJECT_DIR, "audio_meta.json")));

function die(message) {
  console.error(`✗ Gemini Vertex TTS: ${message}`);
  process.exit(1);
}

function parseScript(markdown) {
  const lines = [];
  let current = null;
  const flush = () => {
    if (current && current.text.trim()) lines.push(current);
    current = null;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{2,3}\s+.*?\(Frame\s+(\d+)\)/i);
    if (heading) {
      flush();
      current = { frame: Number(heading[1]), text: "" };
      continue;
    }
    if (!current || /^\s*\*\*/.test(line)) continue;
    const spoken = line.match(/^(?: {4,}|\t)(.+)$/);
    if (spoken) current.text += `${current.text ? " " : ""}${spoken[1].trim()}`;
  }
  flush();
  return lines;
}

function parseFrameDurations(markdown) {
  const durations = new Map();
  let frame = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{2,3}\s+(?:Frame|Beat|Scene)\s+(\d+)/i);
    if (heading) {
      frame = Number(heading[1]);
      continue;
    }
    const duration = frame != null && line.match(/^\s*[-*]\s+duration\s*:\s*([\d.]+)s/i);
    if (duration) durations.set(frame, Number(duration[1]));
  }
  return durations;
}

function accessToken() {
  try {
    return execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    die(`Google Application Default Credentials are unavailable. Run gcloud ADC setup; ${error.message}`);
  }
}

function wavFromPcm(pcm, sampleRate = 24_000, channels = 1, bits = 16) {
  const blockAlign = channels * (bits / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function addSilence(pcm, targetSeconds, sampleRate = 24_000, channels = 1, bits = 16) {
  const bytesPerSecond = sampleRate * channels * (bits / 8);
  const targetBytes = Math.round(targetSeconds * bytesPerSecond);
  if (pcm.length > targetBytes) return null;
  return pcm.length === targetBytes ? pcm : Buffer.concat([pcm, Buffer.alloc(targetBytes - pcm.length)]);
}

function wordTimings(text, durationSeconds) {
  const tokens = text.match(/\S+/g) || [];
  if (!tokens.length) return [];
  const weights = tokens.map((token) => {
    const punctuationPause = /[.!?]$/.test(token) ? 1.7 : /[,;:]$/.test(token) ? 1.25 : 1;
    return Math.max(1, token.replace(/[^\p{L}\p{N}]/gu, "").length) * punctuationPause;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return tokens.map((token, index) => {
    const start = (cursor / total) * durationSeconds;
    cursor += weights[index];
    const end = (cursor / total) * durationSeconds;
    return {
      id: `word-${index}`,
      text: token,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    };
  });
}

async function synthesize(text, token) {
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-goog-user-project": project,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: {
        role: "user",
        parts: {
          text: `Speak clearly and naturally for a technical product demonstration. Keep the wording exact: ${text}`,
        },
      },
      generation_config: {
        speech_config: {
          language_code: language,
          voice_config: {
            prebuilt_voice_config: { voice_name: voice },
          },
        },
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 1200)}`);
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`Vertex AI returned non-JSON output: ${body.slice(0, 500)}`);
  }
  const part = json.candidates?.[0]?.content?.parts?.find(
    (item) => item.inlineData?.data || item.inline_data?.data,
  );
  const encoded = part?.inlineData?.data || part?.inline_data?.data;
  if (!encoded) {
    throw new Error(`Vertex AI returned no audio data: ${JSON.stringify(json).slice(0, 1200)}`);
  }
  const pcm = Buffer.from(encoded, "base64");
  if (!pcm.length || pcm.length % 2 !== 0) throw new Error("Vertex AI returned invalid 16-bit PCM data");
  return pcm;
}

async function main() {
  const script = parseScript(readFileSync(scriptPath, "utf8"));
  const targetDurations = parseFrameDurations(readFileSync(storyboardPath, "utf8"));
  if (!script.length) die(`no spoken lines found in ${scriptPath}`);
  for (const line of script) {
    if (!targetDurations.has(line.frame)) die(`frame ${line.frame} has no positive storyboard duration`);
  }

  const token = accessToken();
  const voiceDir = join(PROJECT_DIR, "assets", "voice");
  mkdirSync(voiceDir, { recursive: true });
  const voices = [];
  console.error(`· provider: Vertex AI · model: ${model} · voice: ${voice} · ${script.length} line(s)`);

  for (const line of script) {
    const rawPcm = await synthesize(line.text, token);
    const rawDuration = rawPcm.length / (24_000 * 2);
    const targetDuration = targetDurations.get(line.frame);
    // The storyboard duration is a guide. Gemini's expressive delivery can
    // vary slightly between calls, so preserve the exact cloud audio when it
    // runs long and let the mechanical sync pass update the frame window.
    // This is a timing adjustment, never a provider fallback.
    const padded = addSilence(rawPcm, targetDuration) || rawPcm;
    const rel = `assets/voice/${String(line.frame).padStart(2, "0")}.wav`;
    writeFileSync(join(PROJECT_DIR, rel), wavFromPcm(padded));
    const duration = padded.length / (24_000 * 2);
    voices.push({
      frame: line.frame,
      path: rel,
      duration_s: Number(duration.toFixed(3)),
      words: wordTimings(line.text, duration),
    });
    console.error(
      `  frame ${line.frame}: ${rawDuration.toFixed(2)}s speech` +
        (duration > rawDuration ? ` + ${(duration - rawDuration).toFixed(2)}s hold` : " (window will expand)"),
    );
  }

  const total = voices.reduce((sum, item) => sum + item.duration_s, 0);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        tts_provider: "vertex_ai",
        tts_model: model,
        voice_id: voice,
        language_code: language,
        word_timing_source: "deterministic text-to-duration mapping for Gemini audio",
        bgm: null,
        bgm_pending: false,
        voices,
        sfx: [],
        total_duration_s: Number(total.toFixed(3)),
      },
      null,
      2,
    ),
  );
  console.log(`✓ Gemini Vertex TTS wrote ${voices.length} WAV files and ${outPath}`);
}

main().catch((error) => die(error.message));
