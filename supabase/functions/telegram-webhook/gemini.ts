// Gemini orqali transkripsiya.
// Kichik fayllar so'rov ichida (inline) yuboriladi, kattalari Files API orqali.

import { encodeBase64 } from "jsr:@std/encoding@1.0.10/base64";

const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const BASE = "https://generativelanguage.googleapis.com";
const INLINE_MAX_BYTES = 7 * 1024 * 1024;
// 500/503 ("high demand") bo'lsa shu modelni qayta urinish oralig'i.
const RETRY_DELAYS_MS = [2000]; // keyin boshqa modelga o'tamiz

// Birinchisi band bo'lsa yoki topilmasa, keyingisi sinab ko'riladi.
// (Bepul tarifda har bir modelning limiti alohida, shuning uchun 429 da ham keyingisiga o'tamiz.)
const MODELS = (Deno.env.get("GEMINI_MODELS") ?? "gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.8-flash,gemini-flash-latest")
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

/** Vaqt chegarasi tugadi (Supabase funksiyani o'chirib qo'yishidan oldin to'xtaymiz). */
export class TimeoutError extends BusyError {}

class ModelNotFound extends Error {}

export interface Transcript {
  text: string;
  model: string;
}

export async function transcribe(
  bytes: Uint8Array,
  mimeType: string,
  isVideo: boolean,
  deadline: number, // Date.now() bo'yicha: shu vaqtgacha javob bo'lmasa, to'xtatamiz
): Promise<Transcript> {
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
        if (deadline - Date.now() < 10_000) break;
        return { text: await generate(model, parts, isVideo, deadline), model };
      } catch (e) {
        if (e instanceof TimeoutError) throw e;
        if (e instanceof BusyError) { anyBusy = true; lastErr = e; console.warn(`${model} band:`, String(e).slice(0, 200)); continue; }
        if (e instanceof ModelNotFound) { lastErr = e; console.warn(`${model} topilmadi:`, e.message); continue; }
        throw e;
      }
    }
    if (anyBusy || deadline - Date.now() < 10_000) {
      throw lastErr instanceof BusyError ? lastErr : new BusyError(String(lastErr ?? "vaqt tugadi"));
    }
    throw lastErr ?? new Error("Gemini modeli topilmadi");
  } finally {
    if (uploaded) {
      fetch(`${BASE}/v1beta/${uploaded.name}`, { method: "DELETE", headers: { "x-goog-api-key": KEY } })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
  }
}

async function generate(model: string, parts: unknown[], isVideo: boolean, deadline: number): Promise<string> {
  const generationConfig: Record<string, unknown> = { temperature: 0, maxOutputTokens: 32768 };
  if (isVideo) generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW";
  // "O'ylash"ni minimal qilamiz: transkripsiya uchun keraksiz va juda sekinlashtiradi.
  if (model.startsWith("gemini-2.5")) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else generationConfig.thinkingConfig = { thinkingLevel: "minimal" };

  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    if (left < 5_000) throw new TimeoutError(`${model}: vaqt tugadi`);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${BASE}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
        signal: AbortSignal.timeout(left),
      });
    } catch (e) {
      if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new TimeoutError(`${model}: ${Math.round((Date.now() - t0) / 1000)} s da javob bermadi`);
      }
      throw e;
    }
    console.log(`${model} -> ${res.status} (${Date.now() - t0} ms)`);

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
    if (res.status === 400 && generationConfig.thinkingConfig && /thinking/i.test(errText)) {
      delete generationConfig.thinkingConfig; // bu model bunday sozlamani qo'llamaydi
      continue;
    }
    if (res.status === 404) throw new ModelNotFound(`${model}: ${errText.slice(0, 300)}`);
    if (res.status === 429) throw new BusyError(`Gemini 429: ${errText.slice(0, 300)}`);
    if ((res.status === 500 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    if (res.status === 500 || res.status === 503) throw new BusyError(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`);
  }
}

/** Diagnostika: bu kalit bilan ochiq "flash" modellari va har biriga qisqa sinov so'rovi. */
export async function diagnose(only?: string[]) {
  const r = await fetch(`${BASE}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": KEY } });
  const list = r.ok ? await r.json() : { error: r.status };
  const flash = (list.models ?? [])
    .filter((m: { name: string; supportedGenerationMethods?: string[] }) =>
      /flash/.test(m.name) && m.supportedGenerationMethods?.includes("generateContent"))
    .map((m: { name: string }) => m.name.replace("models/", ""));
  const probes: Record<string, string> = {};
  const toProbe = (only?.length ? only : MODELS).filter((m) => /^gemini-[\w.-]+$/.test(m)).slice(0, 8);
  for (const model of toProbe) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Say OK" }] }] }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      probes[model] = `${res.status} ${Date.now() - t0}ms ${res.ok ? "" : body.slice(0, 160)}`;
    } catch (e) {
      probes[model] = `xato ${Date.now() - t0}ms ${String(e).slice(0, 100)}`;
    }
  }
  return { models_list_status: r.status, flash, probes };
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
  for (let i = 0; file.state === "PROCESSING" && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(`${BASE}/v1beta/${file.name}`, { headers: { "x-goog-api-key": KEY } });
    if (!r.ok) throw new Error(`Gemini file status ${r.status}`);
    file = await r.json();
  }
  if (file.state && file.state !== "ACTIVE") throw new Error(`Gemini file state: ${file.state}`);
  return { name: file.name, uri: file.uri };
}
