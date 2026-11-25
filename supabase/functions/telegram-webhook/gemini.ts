// Gemini orqali transkripsiya.
// Kichik fayllar so'rov ichida (inline) yuboriladi, kattalari Files API orqali.

import { encodeBase64 } from "jsr:@std/encoding@1.0.10/base64";

const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const BASE = "https://generativelanguage.googleapis.com";
const INLINE_MAX_BYTES = 7 * 1024 * 1024;
// 500/503 ("high demand") bo'lsa shu modelni qayta urinmaymiz — darhol keyingi modelga o'tamiz (tezroq).
const RETRY_DELAYS_MS: number[] = [];

// Birinchisi band bo'lsa yoki topilmasa, keyingisi sinab ko'riladi.
// (Bepul tarifda har bir modelning limiti alohida, shuning uchun 429 da ham keyingisiga o'tamiz.)
const MODELS = (Deno.env.get("GEMINI_MODELS") ?? "gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.8-flash,gemini-flash-latest")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Xulosa matndan yasaladi — yengil model yetarli va ancha tez.
const SUMMARY_MODELS = (Deno.env.get("GEMINI_SUMMARY_MODELS") ?? "gemini-3.5-flash-lite,gemini-3.5-flash")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Bitta modelni qancha kutamiz (keyin keyingisiga o'tamiz).
const TRANSCRIBE_CALL_MS = Number(Deno.env.get("GEMINI_TRANSCRIBE_CALL_MS") ?? 75_000);
const SUMMARY_CALL_MS = Number(Deno.env.get("GEMINI_SUMMARY_CALL_MS") ?? 20_000);

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

const SEGMENTS_PROMPT = `You are a professional subtitle editor. Transcribe ALL speech in this recording verbatim and split it into subtitle segments with accurate timestamps.

Rules:
- The speech is mostly Uzbek. Write Uzbek in the modern Latin alphabet with standard orthography: use oʻ, gʻ (with ʻ) and ’ for the tutuq belgisi.
- If the speaker switches to Russian, English or another language, write those parts in that language as spoken (Russian in Cyrillic). Do not translate.
- Each segment: one short sentence or phrase, at most 84 characters and at most 7 seconds long. Never merge long passages into one segment.
- "start" and "end" are the times in the recording when the segment is spoken, formatted MM:SS.mmm (for example 01:15.250). Segments must be in order and must not overlap.
- Add normal punctuation and capitalization. No speaker labels, notes or commentary.
- Do not invent words. Write an unclear fragment as (tushunarsiz). Ignore music and background noise.
- If there is no human speech at all, return an empty array.`;

const SEGMENTS_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      start: { type: "STRING" },
      end: { type: "STRING" },
      text: { type: "STRING" },
    },
    required: ["start", "end", "text"],
    propertyOrdering: ["start", "end", "text"],
  },
};

/**
 * Qisqa xulosa ko'rsatmasi. Birinchi gap: "Videomaterialda/Audiomaterialda [muallif tomonidan] [kim] faoliyati
 * tanqid qilingan." Urg'u — tanqid qilingan masalalar va takliflarda; ismlar faqat matnda aytilgani bo'yicha.
 */
function summaryPrompt(kind: "video" | "audio"): string {
  const label = kind === "video" ? "Videomaterialda" : "Audiomaterialda";
  return `Quyida ${kind === "video" ? "videomaterial" : "audiomaterial"}ning toʻliq matni berilgan. Uning annotatsiyasini (qisqa mazmunini) oʻzbek tilida (lotin yozuvida) yoz. "Asosiy fikr" kabi sarlavha qoʻyma.
Asosiy urgʻu — materialning salbiy (negativ) qismiga: kim tomonidan, kimning faoliyati va qaysi masalalar tanqid qilingani. Takliflar — ikkinchi darajali, qisqa.
Xulosa QISQA boʻlsin: jami 600 belgidan oshmasin.

Format (aynan shunday, Markdown belgilarisiz):
${label} <muallif: roli Ism Familiya> tomonidan <Ism Familiya (lavozimi)> faoliyati tanqid qilingan. <1 gap: asosiy tanqid nimada.>

Tanqid qilingan masalalar:
• <masala>
• <masala>

Takliflar:
• <taklif>

Birinchi gap qoidalari:
- Javobni albatta "${label}" soʻzi bilan boshla.
- Muallif — gapirayotgan shaxs. U oʻzini tanishtirsa yoki matnda nomi aniq aytilsa: "${label} <roli> <Ism Familiya> tomonidan …" deb yoz (masalan: "${label} bloger Eshmat Toshmatov tomonidan …"). Roli aytilmagan boʻlsa — faqat ism-familiya. Muallif nomaʼlum boʻlsa, "… tomonidan" qismini yozma.
- Faoliyati tanqid qilingan shaxslarni ism-familiyasi bilan yoz; lavozimi yoki tashkiloti aytilgan boʻlsa, qavs ichida qoʻsh. Bir necha kishi boʻlsa, vergul bilan sanab oʻt. Lavozim egasi nomsiz tanqid qilingan boʻlsa, lavozimni yoz (masalan: "Prezident", "tuman hokimi"). Tashkilot tanqid qilingan boʻlsa: "<tashkilot> faoliyati tanqid qilingan".
- Aniq shaxs yoki tashkilot tanqid qilinmagan, lekin muammolar tanqid qilingan boʻlsa: "${label} … tomonidan <masalalar> tanqid qilingan."
- Matnda umuman tanqid boʻlmasa: "${label} … haqida soʻz boradi." deb yoz va "Tanqid qilingan masalalar" oʻrniga "Muhim jihatlar" boʻlimini yoz.

Boshqa qoidalar:
- Ism-familiya, lavozim va tashkilot nomlarini oʻzingdan toʻqima va tuzatma: faqat matnda aniq aytilganini yoz.
- "Tanqid qilingan masalalar" — 2–5 band: kamchiliklar, qonunbuzarliklar, salbiy holatlar, eʼtirozlar. Eng jiddiylarini birinchi yoz.
- "Takliflar" — koʻpi bilan 2 band, faqat matnda aniq taklif yoki talab aytilgan boʻlsa; boʻlmasa bu boʻlimni umuman yozma.
- Har bir band — bitta qisqa gap (15 soʻzgacha). Umumiy, ijobiy yoki kirish gaplarni yozma.
- Faqat matnda bor narsani yoz, oʻzingdan qoʻshma. Matn rus yoki boshqa tilda boʻlsa ham xulosani oʻzbekcha yoz.

Matn:
`;
}

/** Gemini limiti yoki vaqtincha band — foydalanuvchiga "navbat ko'p" deyiladi. */
export class BusyError extends Error {}

/** Vaqt chegarasi tugadi (Supabase funksiyani o'chirib qo'yishidan oldin to'xtaymiz). */
export class TimeoutError extends BusyError {}

class ModelNotFound extends Error {}

export interface Transcript {
  text: string; // mode "text": tayyor matn; mode "segments": JSON massiv (string)
  model: string;
}

export type Mode = "text" | "segments";

export async function transcribe(
  bytes: Uint8Array,
  mimeType: string,
  isVideo: boolean,
  deadline: number, // Date.now() bo'yicha: shu vaqtgacha javob bo'lmasa, to'xtatamiz
  mode: Mode = "text",
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
    const parts = [media, { text: mode === "segments" ? SEGMENTS_PROMPT : PROMPT }];
    const extra: Record<string, unknown> = mode === "segments"
      ? { responseMimeType: "application/json", responseSchema: SEGMENTS_SCHEMA }
      : {};
    return await runModels(parts, isVideo, deadline, extra, MODELS, TRANSCRIBE_CALL_MS);
  } finally {
    if (uploaded) {
      fetch(`${BASE}/v1beta/${uploaded.name}`, { method: "DELETE", headers: { "x-goog-api-key": KEY } })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
  }
}

/** Tayyor matndan qisqa xulosa (audio qayta yuborilmaydi — tez va arzon). Yengil model birinchi. */
export function summarize(transcript: string, deadline: number, kind: "video" | "audio"): Promise<Transcript> {
  const models = [...SUMMARY_MODELS, ...MODELS.filter((m) => !SUMMARY_MODELS.includes(m))];
  return runModels([{ text: summaryPrompt(kind) + transcript }], false, deadline,
    { temperature: 0.2, maxOutputTokens: 2048 }, models, SUMMARY_CALL_MS);
}

/** Modellarni navbat bilan sinaydi: band (503/429) yoki topilmasa keyingisiga o'tadi. */
async function runModels(
  parts: unknown[],
  isVideo: boolean,
  deadline: number,
  extra: Record<string, unknown>,
  models: string[],
  callMs: number,
): Promise<Transcript> {
  let lastErr: unknown;
  let anyBusy = false;
  for (const model of models) {
    try {
      if (deadline - Date.now() < 10_000) break;
      return { text: await generate(model, parts, isVideo, Math.min(deadline, Date.now() + callMs), extra, deadline), model };
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
}

/**
 * callDeadline — shu modelga ajratilgan vaqt; tugasa BusyError (keyingi model sinaladi).
 * deadline — umumiy vaqt; tugasa TimeoutError (boshqa urinish yo'q).
 */
async function generate(
  model: string,
  parts: unknown[],
  isVideo: boolean,
  callDeadline: number,
  extra: Record<string, unknown> = {},
  deadline = callDeadline,
): Promise<string> {
  const generationConfig: Record<string, unknown> = { temperature: 0, maxOutputTokens: 32768, ...extra };
  if (isVideo) generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW";
  // "O'ylash"ni minimal qilamiz: transkripsiya uchun keraksiz va juda sekinlashtiradi.
  if (model.startsWith("gemini-2.5")) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else generationConfig.thinkingConfig = { thinkingLevel: "minimal" };

  for (let attempt = 0; ; attempt++) {
    if (deadline - Date.now() < 5_000) throw new TimeoutError(`${model}: vaqt tugadi`);
    const left = callDeadline - Date.now();
    if (left < 3_000) throw new BusyError(`${model}: ajratilgan vaqt tugadi`);
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
        const msg = `${model}: ${Math.round((Date.now() - t0) / 1000)} s da javob bermadi`;
        // Umumiy vaqt ham tugagan bo'lsa — to'xtaymiz; aks holda keyingi modelga o'tamiz.
        throw deadline - Date.now() < 10_000 ? new TimeoutError(msg) : new BusyError(msg);
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
