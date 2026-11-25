// Gemini orqali transkripsiya.
// Kichik fayllar so'rov ichida (inline) yuboriladi, kattalari Files API orqali.

import { encodeBase64 } from "jsr:@std/encoding@1.0.10/base64";

const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const BASE = "https://generativelanguage.googleapis.com";
const INLINE_MAX_BYTES = 7 * 1024 * 1024;
// 500/503 ("high demand") bo'lsa shu modelni qayta urinish oralig'i.
const RETRY_DELAYS_MS = [2000, 5000];

// Birinchisi band bo'lsa yoki topilmasa, keyingisi sinab ko'riladi.
// (Bepul tarifda har bir modelning limiti alohida, shuning uchun 429 da ham keyingisiga o'tamiz.)
const MODELS = (Deno.env.get("GEMINI_MODELS") ?? "gemini-2.5-flash,gemini-flash-latest,gemini-2.5-flash-lite")
  .split(",").map((s) => s.trim()).filter(Boolean);

export const NO_SPEECH = "[[NO_SPEECH]]";

const PROMPT = `You are a professional transcriber. Transcribe ALL speech in this recording verbatim.

Rules:
- The speech is mostly Uzbek. Write Uzbek in the modern Latin alphabet with standard orthography: use oʻ, gʻ (with ʻ) and ’ for the tutuq belgisi; sh, ch, ng as usual.
- If the speaker switches to Russian, English or another language, write those parts in that language as spoken (Russian in Cyrillic). Do not translate.
- Add normal punctuation and capitalization. Start a new paragraph when the topic or the speaker changes.
- Do not add timestamps, speaker labels, titles, notes, summaries or any commentary. Do not wrap the output in quotes or code blocks.
- Do not invent words. Write an unclear fragment as (tushunarsiz).
- Ignore music and background noise.
- If there is no human speech at all, output exactly: ${NO_SPEECH}`;

/** Gemini limiti yoki vaqtincha band — foydalanuvchiga "navbat ko'p" deyiladi. */
export class BusyError extends Error {}

class ModelNotFound extends Error {}

export interface Transcript {
  text: string;
  model: string;
}

export async function transcribe(bytes: Uint8Array, mimeType: string, isVideo: boolean): Promise<Transcript> {
  let uploaded: { name: string; uri: string } | null = null;
  try {
    let media: Record<string, unknown>;
    if (bytes.length <= INLINE_MAX_BYTES) {
      media = { inlineData: { mimeType, data: encodeBase64(bytes) } };
    } else {
      uploaded = await uploadFile(bytes, mimeType);
      media = { fileData: { mimeType, fileUri: uploaded.uri } };
    }
    const parts = [media, { text: PROMPT }];

    let lastErr: unknown;
    let anyBusy = false;
    for (const model of MODELS) {
      try {
        return { text: await generate(model, parts, isVideo), model };
      } catch (e) {
        if (e instanceof BusyError) { anyBusy = true; lastErr = e; console.warn(`${model} band:`, String(e).slice(0, 200)); continue; }
        if (e instanceof ModelNotFound) { lastErr = e; console.warn(`${model} topilmadi`); continue; }
        throw e;
      }
    }
    if (anyBusy) throw lastErr instanceof BusyError ? lastErr : new BusyError(String(lastErr));
    throw lastErr ?? new Error("Gemini modeli topilmadi");
  } finally {
    if (uploaded) {
      fetch(`${BASE}/v1beta/${uploaded.name}`, { method: "DELETE", headers: { "x-goog-api-key": KEY } })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
  }
}

async function generate(model: string, parts: unknown[], isVideo: boolean): Promise<string> {
  const generationConfig: Record<string, unknown> = { temperature: 0, maxOutputTokens: 32768 };
  if (isVideo) generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW";
  // 2.5 Flash'da "o'ylash"ni o'chiramiz: transkripsiya uchun keraksiz va sekinlashtiradi.
  if (model.startsWith("gemini-2.5-flash")) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig });

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": KEY },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? [])
        .filter((p: { thought?: boolean }) => !p.thought)
        .map((p: { text?: string }) => p.text ?? "")
        .join("")
        .trim();
      if (!text) {
        const reason = data.promptFeedback?.blockReason ?? cand?.finishReason ?? "empty";
        throw new Error(`Gemini bo'sh javob qaytardi: ${reason}`);
      }
      return text;
    }

    const errText = await res.text();
    if (res.status === 404) throw new ModelNotFound(`${model}: ${errText.slice(0, 200)}`);
    if (res.status === 429) throw new BusyError(`Gemini 429: ${errText.slice(0, 300)}`);
    if ((res.status === 500 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    if (res.status === 500 || res.status === 503) throw new BusyError(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`);
  }
}

async function uploadFile(bytes: Uint8Array, mimeType: string): Promise<{ name: string; uri: string }> {
  const start = await fetch(`${BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: `matnqil-${Date.now()}` } }),
  });
  if (start.status === 429) throw new BusyError("Gemini upload 429");
  const uploadUrl = start.headers.get("x-goog-upload-url");
  await start.body?.cancel();
  if (!start.ok || !uploadUrl) throw new Error(`Gemini upload start ${start.status}`);

  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: new Blob([bytes as BlobPart]),
  });
  if (!up.ok) throw new Error(`Gemini upload ${up.status}: ${(await up.text()).slice(0, 300)}`);
  let file = (await up.json()).file as { name: string; uri: string; state?: string };

  // Video fayllar avval qayta ishlanadi (PROCESSING → ACTIVE).
  for (let i = 0; file.state === "PROCESSING" && i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(`${BASE}/v1beta/${file.name}`, { headers: { "x-goog-api-key": KEY } });
    if (!r.ok) throw new Error(`Gemini file status ${r.status}`);
    file = await r.json();
  }
  if (file.state && file.state !== "ACTIVE") throw new Error(`Gemini file state: ${file.state}`);
  return { name: file.name, uri: file.uri };
}
