// MatnQil — Bulut (@matnqil_bot) Telegram webhook.
//
//   POST /telegram-webhook            Telegram update (X-Telegram-Bot-Api-Secret-Token tekshiriladi)
//   GET  /telegram-webhook?setup=1    setWebhook + bot buyruqlarini o'rnatadi (idempotent)
//
// Telegram'ga darhol 200 qaytariladi, transkripsiya EdgeRuntime.waitUntil bilan fonda bajariladi.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isScript, T, TS } from "./texts.ts";
import {
  answerCallback,
  CLOUD_MAX_BYTES,
  downloadFile,
  editMessage,
  inlineKeyboard,
  MAX_DOWNLOAD_BYTES,
  MAX_MESSAGE,
  internalSecret,
  safeEqual,
  sendMessage,
  sendTextDocument,
  splitText,
  tg,
  webhookSecret,
} from "./telegram.ts";
import {
  BusyError,
  deleteGeminiFile,
  diagnose,
  diagnoseYoutube,
  diagnoseYoutubeClip,
  NO_SPEECH,
  type Script,
  summarize,
  TimeoutError,
  transcribe,
  uploadToGemini,
} from "./gemini.ts";
import { downloadAudio, prepareAudio } from "./worker.ts";
import { toCyrillic } from "./translit.ts";
import { parseSegments, type Segment, toPlainText, toSrt, toTimestampedText } from "./subtitles.ts";

const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? 20);
// Bo'laklab ishlash tufayli uzun yozuvlar ham qabul qilinadi (fayl baribir 20 MB gacha).
const MAX_DURATION_SEC = Number(Deno.env.get("MAX_DURATION_SEC") ?? 3 * 60 * 60);
// Shundan uzun yozuv (yoki davomiyligi noma'lum YouTube) bo'laklab ishlanadi.
const LONG_SEC = Number(Deno.env.get("LONG_SEC") ?? 9 * 60);
// Bitta qism uzunligi (soniya): bir chaqiruvda ~2,5 daqiqaga sig'ishi kerak.
const CHUNK_SEC = Number(Deno.env.get("CHUNK_SEC") ?? 8 * 60);
const MAX_INLINE_CHUNKS = 3; // bundan uzun matn .txt fayl bo'lib boradi
// Supabase bepul tarifida funksiya ~150 s ishlaydi; javobni yuborishga vaqt qoldiramiz.
const GEMINI_BUDGET_MS = Number(Deno.env.get("GEMINI_BUDGET_MS") ?? 115_000);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// deno-lint-ignore no-explicit-any
type Msg = any;

// Supabase Edge Runtime global (lokal type-check uchun ham).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

interface Media {
  kind: "voice" | "video_note" | "audio" | "video" | "document" | "youtube";
  fileId: string;
  url?: string; // YouTube havolasi (fayl o'rniga)
  fileSize?: number;
  duration?: number;
  mimeType: string;
  isVideo: boolean;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.has("setup")) {
    return json(await setup());
  }
  if (req.method === "GET" && url.searchParams.has("diag")) {
    // vaqtinchalik: qaysi Gemini modellari ishlashini va YouTube o'qilishini ko'rish uchun
    const yt = url.searchParams.get("yt");
    const from = url.searchParams.get("from");
    if (yt && from) return json(await diagnoseYoutubeClip(yt, Number(from), Number(url.searchParams.get("to"))));
    return json(yt ? await diagnoseYoutube(yt) : await diagnose(url.searchParams.get("m")?.split(",")));
  }
  if (req.method !== "POST") return new Response("MatnQil — Bulut", { status: 200 });

  // Uzun yozuvning navbatdagi qismi: funksiya o'zini-o'zi chaqiradi (har chaqiruvga yangi vaqt).
  if (url.searchParams.has("step")) {
    if (!safeEqual(req.headers.get("x-internal-secret") ?? "", await internalSecret())) {
      return new Response("forbidden", { status: 401 });
    }
    const id = Number(url.searchParams.get("step"));
    EdgeRuntime.waitUntil(runStep(id).catch((e) => console.error(`step ${id}`, e)));
    return new Response("ok");
  }

  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(got, await webhookSecret())) return new Response("forbidden", { status: 401 });

  const update = await req.json().catch(() => null);
  if (update?.message) {
    EdgeRuntime.waitUntil(
      handleMessage(update.update_id, update.message).catch((e) => console.error("handleMessage", e)),
    );
  } else if (update?.callback_query) {
    EdgeRuntime.waitUntil(handleCallback(update.callback_query).catch((e) => console.error("handleCallback", e)));
  }
  return new Response("ok");
});

async function setup() {
  const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram-webhook`;
  await tg("setWebhook", {
    url: webhookUrl,
    secret_token: await webhookSecret(),
    allowed_updates: ["message", "callback_query"],
    max_connections: 20,
  });
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Boshlash" },
      { command: "help", description: "Yordam va cheklovlar" },
      { command: "limit", description: "Bugungi limit" },
      { command: "yozuv", description: "Kirill yoki lotin yozuvi" },
    ],
  });
  await tg("setMyShortDescription", {
    short_description: "O'zbekcha ovozli xabar, audio va videoni matnga aylantiraman.",
  });
  await tg("setMyDescription", {
    description:
      "MatnQil — Bulut: ovozli xabar, video-doira, audio yoki video yuboring, men uni o'zbekcha matnga aylantirib beraman. bulut.uz",
  });
  const info = await tg("getWebhookInfo");
  return { ok: true, url: info.url, pending_update_count: info.pending_update_count, last_error_message: info.last_error_message ?? null };
}

async function handleMessage(updateId: number, msg: Msg) {
  // Hozircha faqat shaxsiy chat. Guruhlar — keyingi bosqich.
  if (msg.chat?.type !== "private" || !msg.from || msg.from.is_bot) return;
  const chatId: number = msg.chat.id;

  const command = typeof msg.text === "string" ? msg.text.trim().split(/[\s@]/)[0].toLowerCase() : "";
  if (command === "/start") {
    await upsertUser(msg.from);
    return void await sendMessage(chatId, T.start(msg.from.first_name ?? "do'stim", DAILY_LIMIT, maxMb()));
  }
  if (command === "/help") {
    return void await sendMessage(chatId, T.help(DAILY_LIMIT, Math.round(MAX_DURATION_SEC / 60), maxMb()));
  }
  if (command === "/limit") {
    const { data, error } = await db.rpc("daily_usage", { p_telegram_id: msg.from.id });
    if (error) throw error;
    return void await sendMessage(chatId, T.limit(data ?? 0, DAILY_LIMIT));
  }

  if (command === "/yozuv") {
    await upsertUser(msg.from);
    const cur = await userScript(msg.from.id);
    return void await tg("sendMessage", {
      chat_id: chatId,
      text: T.scriptAsk(cur),
      reply_markup: inlineKeyboard([
        { text: "Кирилл", callback_data: "script:cyrl" },
        { text: "Lotin", callback_data: "script:latn" },
      ]),
    });
  }

  const media = extractMedia(msg);
  if (!media) return void await sendMessage(chatId, T.unsupported);

  if (media.fileSize && media.fileSize > MAX_DOWNLOAD_BYTES) {
    return void await sendMessage(chatId, T.tooBig((media.fileSize / 1024 / 1024).toFixed(1), maxMb()), msg.message_id);
  }
  if (media.duration && media.duration > MAX_DURATION_SEC) {
    return void await sendMessage(chatId, T.tooLong(Math.round(MAX_DURATION_SEC / 60)), msg.message_id);
  }

  const { data: start, error } = await db.rpc("start_request", {
    p_update_id: updateId,
    p_user: msg.from,
    p_chat_id: chatId,
    p_message_id: msg.message_id,
    p_media_type: media.kind,
    p_mime_type: media.mimeType,
    p_file_size: media.fileSize ?? null,
    p_duration: media.duration ?? null,
    p_daily_limit: DAILY_LIMIT,
  });
  if (error) throw error;
  if (!start.ok) {
    if (start.reason === "limit") await sendMessage(chatId, T.limitReached(DAILY_LIMIT), msg.message_id);
    return; // duplicate — Telegram qayta yuborgan update
  }
  const requestId: number = start.id;
  const script: Script = isScript(start.script) ? start.script : "cyrl";

  const deadline = Date.now() + GEMINI_BUDGET_MS;
  const status = await sendMessage(chatId, media.url ? T.processingYt : T.processing, msg.message_id);
  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  // Uzun yozuv (yoki YouTube) — bo'laklab, navbat bilan.
  if (media.url || (media.duration ?? 0) > LONG_SEC || (media.fileSize ?? 0) > CLOUD_MAX_BYTES) {
    return await startLongJob(requestId, chatId, status.message_id, media, script);
  }

  try {
    const bytes = media.url ? { url: media.url } : await downloadFile(media.fileId);
    if (bytes instanceof Uint8Array && bytes.length > MAX_DOWNLOAD_BYTES) {
      await editMessage(chatId, status.message_id, T.tooBig((bytes.length / 1024 / 1024).toFixed(1), maxMb()));
      return await finish(requestId, "failed", { error: "too_big" });
    }
    // YouTube uchun Telegram file_id yo'q; havolani saqlaymiz.
    const source = media.url ? { file_id: null, source_url: media.url } : { file_id: media.fileId };

    // Asosiy yo'l: vaqt belgili bo'laklar (bitta so'rov) -> [00:15] matn; .srt keyin shu bo'laklardan.
    const first = await transcribe(bytes, media.mimeType, media.isVideo, deadline, "segments", script);
    const segs = fixSegs(parseSegments(first.text, media.duration), script);

    if (segs && segs.length === 0) {
      await editMessage(chatId, status.message_id, T.noSpeech);
      return await finish(requestId, "no_speech", { model: first.model });
    }

    if (segs) {
      const plain = toPlainText(segs);
      // Avval saqlaymiz, keyin yuboramiz: tugma bosilganda yozuv tayyor bo'lsin.
      await finish(requestId, "done", {
        model: first.model, text_length: plain.length, ...source, transcript: plain, segments: segs,
      });
      await deliver(chatId, status.message_id, msg.message_id, toTimestampedText(segs), resultKeyboard(requestId, true, script));
      return;
    }

    // Zaxira: JSON buzuq kelsa, oddiy matn rejimida qayta so'raymiz (vaqt belgilarisiz).
    console.warn(`request ${requestId}: segment JSON buzuq, oddiy matnga o'tildi`);
    const r2 = await transcribe(bytes, media.mimeType, media.isVideo, deadline, "text", script);
    const { model } = r2;
    const text = script === "cyrl" ? toCyrillic(r2.text, "mixed") : r2.text;
    if (text.includes(NO_SPEECH) && text.replace(NO_SPEECH, "").trim().length < 5) {
      await editMessage(chatId, status.message_id, T.noSpeech);
      return await finish(requestId, "no_speech", { model });
    }
    await finish(requestId, "done", { model, text_length: text.length, ...source, transcript: text });
    await deliver(chatId, status.message_id, msg.message_id, text, resultKeyboard(requestId, false, script));
  } catch (e) {
    console.error(`request ${requestId}`, e);
    const busy = e instanceof BusyError;
    const text = media.url
      ? (e instanceof TimeoutError ? T.ytTimeout : busy ? T.busy : T.ytFailed)
      : (busy ? T.busy : T.failed);
    await editMessage(chatId, status.message_id, text).catch(() => {});
    await finish(requestId, busy ? "quota" : "failed", { error: String(e).slice(0, 1000) });
  }
}

/** Matn yoki izohdan YouTube havolasini topadi va standart ko'rinishga keltiradi. */
function youtubeUrl(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(
    /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
}

// ───────────────────────── Uzun yozuvlar: bo'laklab ishlash ─────────────────────────

interface Job {
  src: { uri: string; mimeType?: string; geminiName?: string }; // YouTube havolasi yoki Gemini Files API fayli
  isVideo: boolean;
  kind: "video" | "audio";
  script: Script;
  duration: number | null; // noma'lum bo'lsa (YouTube) — bo'sh qism kelguncha davom etamiz
  next: number; // navbatdagi qism boshlanishi (soniya)
  parts: number;
  attempts: number;
  statusId: number;
  // Katta fayl (20 MB dan ortiq): avval VPS ovozini ajratadi, keyin qismlarga bo'linadi.
  prepare?: { fileId: string; tries: number };
}

function maxMb() {
  return Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024);
}

const MAX_JOB_SEC = 3 * 60 * 60; // xavfsizlik chegarasi
const MAX_ATTEMPTS = 3;

async function startLongJob(requestId: number, chatId: number, statusId: number, media: Media, script: Script) {
  try {
    let src: Job["src"];
    let prepare: Job["prepare"];
    if (media.url) {
      src = { uri: media.url };
    } else if ((media.fileSize ?? 0) > CLOUD_MAX_BYTES) {
      src = { uri: "" }; // VPS ovozni ajratgandan keyin to'ldiriladi
      prepare = { fileId: media.fileId, tries: 0 };
    } else {
      // Faylni Gemini'ga bir marta yuklaymiz — keyingi qismlar shu nusxadan o'qiydi.
      const bytes = await downloadFile(media.fileId);
      const up = await uploadToGemini(bytes, media.mimeType);
      src = { uri: up.uri, mimeType: media.mimeType, geminiName: up.name };
    }
    const job: Job = {
      src, isVideo: media.isVideo, kind: media.isVideo ? "video" : "audio", script,
      duration: media.duration ?? null, next: 0, parts: 0, attempts: 0, statusId, ...(prepare ? { prepare } : {}),
    };
    await db.from("requests").update({
      job, segments: [], file_id: media.url ? null : media.fileId, source_url: media.url ?? null,
    }).eq("id", requestId);
    await editMessage(chatId, statusId, prepare
      ? T.bigPrepare((media.fileSize! / 1024 / 1024).toFixed(0))
      : T.longStart(media.duration ? Math.ceil(media.duration / CHUNK_SEC) : null));
    await triggerStep(requestId);
  } catch (e) {
    console.error(`long ${requestId}`, e);
    const busy = e instanceof BusyError;
    await editMessage(chatId, statusId, media.url ? (busy ? T.busy : T.ytFailed) : (busy ? T.busy : T.failed)).catch(() => {});
    await finish(requestId, busy ? "quota" : "failed", { error: String(e).slice(0, 1000) });
  }
}

async function triggerStep(id: number, delayMs = 0) {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const res = await fetch(`${SUPABASE_URL}/functions/v1/telegram-webhook?step=${id}`, {
    method: "POST",
    headers: { "x-internal-secret": await internalSecret() },
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`step trigger ${res.status}`);
}

async function runStep(id: number) {
  const { data: req, error } = await db.from("requests")
    .select("id, status, chat_id, message_id, job, segments").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!req || req.status !== "processing" || !req.job) return;
  const job = req.job as Job;
  if (job.prepare) return await prepareStep(req, job);
  const all: Segment[] = req.segments ?? [];
  const clip = { start: job.next, end: job.next + CHUNK_SEC };
  if (job.duration) clip.end = Math.min(clip.end, job.duration + 1);

  let segs: Segment[] | null = null;
  try {
    const r = await transcribe({ url: job.src.uri, mimeType: job.src.mimeType }, job.src.mimeType ?? "video/*",
      job.isVideo, Date.now() + GEMINI_BUDGET_MS, "segments", job.script, clip);
    segs = fixSegs(parseSegments(r.text), job.script);
    if (!segs) throw new Error(`Segment JSON buzuq: ${r.text.slice(0, 200)}`);
    // Model vaqtni qism boshidan sanagan bo'lsa (00:00 dan), umumiy vaqtga o'tkazamiz.
    if (clip.start > 0 && segs.length && segs[0].start < clip.start - 30) {
      segs = segs.map((x) => ({ ...x, start: x.start + clip.start, end: x.end + clip.start }));
    }
    // Faqat shu qismga tegishlilari (qo'shni qism bilan takrorlanmasin).
    segs = segs.filter((x) => x.start >= clip.start - 2 && x.start < clip.end + 2);
  } catch (e) {
    const known = (job.duration ?? 0) > 0;
    // Davomiyligi noma'lum va kamida bitta qism tayyor bo'lsa — oxiriga yetdik deb hisoblaymiz.
    if (!(e instanceof BusyError) && !known && job.parts > 0) {
      return await finishJob(req, job, all);
    }
    job.attempts++;
    console.warn(`step ${id}: qism ${clip.start}s xato (${job.attempts}/${MAX_ATTEMPTS}):`, String(e).slice(0, 200));
    if (job.attempts <= MAX_ATTEMPTS) {
      await db.from("requests").update({ job }).eq("id", id);
      return await triggerStep(id, 20_000);
    }
    if (all.length) return await finishJob(req, job, all, true);
    const busy = e instanceof BusyError;
    await editMessage(req.chat_id, job.statusId, job.src.geminiName ? (busy ? T.busy : T.failed) : (busy ? T.busy : T.ytFailed))
      .catch(() => {});
    await cleanupJob(job);
    return await finish(id, busy ? "quota" : "failed", { error: String(e).slice(0, 1000) });
  }

  all.push(...segs);
  job.parts++;
  job.attempts = 0;
  job.next = clip.end;
  const lastEnd = segs.length ? segs[segs.length - 1].end : 0;
  const done = job.duration
    ? job.next >= job.duration
    : segs.length === 0 || lastEnd < clip.end - 45 || job.next >= MAX_JOB_SEC;

  if (done || job.next >= MAX_JOB_SEC) return await finishJob(req, job, all);

  await db.from("requests").update({ job, segments: all }).eq("id", id);
  await editMessage(req.chat_id, job.statusId, T.longProgress(mmss(job.next), job.parts,
    job.duration ? Math.ceil(job.duration / CHUNK_SEC) : null));
  await triggerStep(id);
}

const MAX_PREPARE_TRIES = 45; // ~1 soat (har urinish ~60 s kutadi)

/** Katta fayl: VPS faylni Telegram'dan oladi va ovozini ajratadi; tayyor bo'lgach Gemini'ga yuklaymiz. */
// deno-lint-ignore no-explicit-any
async function prepareStep(req: any, job: Job) {
  const p = job.prepare!;
  let r;
  try {
    r = await prepareAudio(p.fileId);
  } catch (e) {
    console.warn(`prepare ${req.id}:`, String(e).slice(0, 200));
    r = { status: "pending" as const };
  }
  if (r.status === "pending") {
    p.tries++;
    if (p.tries > MAX_PREPARE_TRIES) r = { status: "error" as const, error: "vaqt tugadi" };
    else {
      await db.from("requests").update({ job }).eq("id", req.id);
      return await triggerStep(req.id, 3_000);
    }
  }
  if (r.status === "error") {
    console.error(`prepare ${req.id}: ${r.error}`);
    await editMessage(req.chat_id, job.statusId, T.failed).catch(() => {});
    return await finish(req.id, "failed", { error: `prepare: ${r.error}`.slice(0, 1000) });
  }
  try {
    const bytes = await downloadAudio(r.id);
    const up = await uploadToGemini(bytes, "audio/ogg");
    job.src = { uri: up.uri, mimeType: "audio/ogg", geminiName: up.name };
    job.isVideo = false; // endi faqat ovoz (annotatsiyada «Videomaterialda» so'zi saqlanadi)
    if (r.duration) job.duration = r.duration;
    delete job.prepare;
    await db.from("requests").update({ job }).eq("id", req.id);
    await editMessage(req.chat_id, job.statusId, T.longStart(job.duration ? Math.ceil(job.duration / CHUNK_SEC) : null));
    await triggerStep(req.id);
  } catch (e) {
    console.error(`prepare ${req.id} upload`, e);
    const busy = e instanceof BusyError;
    await editMessage(req.chat_id, job.statusId, busy ? T.busy : T.failed).catch(() => {});
    await finish(req.id, busy ? "quota" : "failed", { error: String(e).slice(0, 1000) });
  }
}

// deno-lint-ignore no-explicit-any
async function finishJob(req: any, job: Job, all: Segment[], partial = false) {
  await cleanupJob(job);
  if (!all.length) {
    await editMessage(req.chat_id, job.statusId, T.noSpeech);
    return await finish(req.id, "no_speech", { job });
  }
  all.sort((a, b) => a.start - b.start);
  const plain = toPlainText(all);
  await finish(req.id, "done", { job, segments: all, transcript: plain, text_length: plain.length });
  const body = toTimestampedText(all) + (partial ? `\n\n${T.longPartial(mmss(job.next))}` : "");
  await deliver(req.chat_id, job.statusId, req.message_id, body, resultKeyboard(req.id, true, job.script));
}

async function cleanupJob(job: Job) {
  if (job.src.geminiName) await deleteGeminiFile(job.src.geminiName);
}

function mmss(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/** Matnni yuboradi: kichik bo'lsa xabar(lar), katta bo'lsa .txt fayl. Tugma birinchi xabarga qo'yiladi. */
async function deliver(chatId: number, statusId: number, replyTo: number, text: string, keyboard?: unknown, name = "matn") {
  const chunks = splitText(text);
  if (chunks.length <= MAX_INLINE_CHUNKS) {
    await editMessage(chatId, statusId, chunks[0], keyboard);
    for (const c of chunks.slice(1)) await sendMessage(chatId, c);
    return;
  }
  await sendTextDocument(chatId, `${name}-${stamp()}.txt`, text + "\n", T.fileCaption, replyTo);
  const preview = text.slice(0, MAX_MESSAGE - 200).replace(/\s+\S*$/, "");
  await editMessage(chatId, statusId, `${T.longAsFile}\n\n${preview}…`, keyboard);
}

/** Natija ostidagi tugmalar: .srt (bo'laklar bo'lsa) va qisqa xulosa. */
function resultKeyboard(requestId: number, hasSegments: boolean, script: Script) {
  const row = [];
  if (hasSegments) row.push({ text: TS[script].srtButton, callback_data: `srt:${requestId}` });
  row.push({ text: TS[script].sumButton, callback_data: `sum:${requestId}` });
  return inlineKeyboard(row);
}

/** Bosilgan tugmani olib tashlaydi, qolganini qoldiradi. */
function keepOtherButton(chatId: number, cb: { message?: { message_id: number; reply_markup?: { inline_keyboard?: { callback_data?: string }[][] } } }, pressed: string) {
  const rows = cb.message?.reply_markup?.inline_keyboard ?? [];
  const left = rows.map((r) => r.filter((b) => b.callback_data !== pressed)).filter((r) => r.length);
  return tg("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: cb.message!.message_id,
    reply_markup: { inline_keyboard: left },
  }).catch(() => {});
}

/** "processing" holatida qotib qolgan (server uzib qo'ygan) tugmani 3 daqiqadan keyin qayta bosish mumkin. */
function staleIso() {
  return new Date(Date.now() - 3 * 60_000).toISOString();
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
}

// deno-lint-ignore no-explicit-any
async function handleCallback(cb: any) {
  const data: string = cb.data ?? "";
  const chatId: number | undefined = cb.message?.chat?.id;
  if (!chatId || cb.message?.chat?.type !== "private") return void await answerCallback(cb.id);
  if (data.startsWith("script:")) return await handleScript(cb, chatId, data.slice(7));
  if (data.startsWith("sum:")) return await handleSummary(cb, chatId, Number(data.slice(4)));
  if (data.startsWith("srt:")) return await handleSrt(cb, chatId, Number(data.slice(4)));
  if (!data.startsWith("ts:")) return void await answerCallback(cb.id);
  const requestId = Number(data.slice(3));

  // Atomar "band qilish": faqat o'z yozuvi, va faqat hali tayyorlanmagan (yoki xato bo'lgan) bo'lsa.
  const { data: req, error } = await db.from("requests")
    .update({ ts_status: "processing", ts_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("telegram_id", cb.from.id)
    .eq("status", "done")
    .not("file_id", "is", null)
    .or(`ts_status.is.null,ts_status.eq.failed,and(ts_status.eq.processing,ts_at.lt.${staleIso()})`)
    .select("id, file_id, mime_type, media_type, duration_sec, message_id")
    .maybeSingle();
  if (error) throw error;
  if (!req) {
    const { data: exists } = await db.from("requests").select("id").eq("id", requestId).eq("telegram_id", cb.from.id)
      .maybeSingle();
    return void await answerCallback(cb.id, exists ? T.tsAlready : T.tsNotFound);
  }

  await answerCallback(cb.id, T.tsStarted);
  await keepOtherButton(chatId, cb, data);
  const deadline = Date.now() + GEMINI_BUDGET_MS;
  const status = await sendMessage(chatId, T.tsProcessing, req.message_id ?? undefined);

  try {
    const bytes = await downloadFile(req.file_id);
    const isVideo = req.media_type === "video" || req.media_type === "video_note" ||
      (req.mime_type ?? "").startsWith("video/");
    const { text: raw, model } = await transcribe(bytes, req.mime_type ?? "audio/ogg", isVideo, deadline, "segments",
      await userScript(cb.from.id));

    const segs = parseSegments(raw, req.duration_sec ?? undefined);
    if (!segs) throw new Error(`Segment JSON buzuq: ${raw.slice(0, 200)}`);
    if (!segs.length) {
      await editMessage(chatId, status.message_id, T.tsNoSpeech);
      return await setTs(requestId, "done");
    }

    await deliver(chatId, status.message_id, req.message_id, `${T.tsHeader}\n\n${toTimestampedText(segs)}`, undefined, "vaqt");
    await sendTextDocument(chatId, `subtitr-${stamp()}.srt`, toSrt(segs), T.srtCaption, req.message_id ?? undefined,
      "application/x-subrip");
    await setTs(requestId, "done");
    console.log(`ts ${requestId}: ${segs.length} segment, ${model}`);
  } catch (e) {
    console.error(`ts ${requestId}`, e);
    const busy = e instanceof BusyError;
    await editMessage(chatId, status.message_id, busy ? T.tsBusy : T.tsFailed,
      inlineKeyboard([{ text: T.tsButton, callback_data: `ts:${requestId}` }])).catch(() => {});
    await setTs(requestId, "failed");
  }
}

/** .srt: saqlangan bo'laklardan yasaladi — Gemini chaqirilmaydi, bir zumda. */
// deno-lint-ignore no-explicit-any
async function handleSrt(cb: any, chatId: number, requestId: number) {
  const { data: req, error } = await db.from("requests")
    .select("id, segments, message_id")
    .eq("id", requestId)
    .eq("telegram_id", cb.from.id)
    .maybeSingle();
  if (error) throw error;
  if (!req?.segments?.length) return void await answerCallback(cb.id, T.tsNotFound);

  await answerCallback(cb.id);
  await keepOtherButton(chatId, cb, cb.data);
  await sendTextDocument(chatId, `subtitr-${stamp()}.srt`, toSrt(req.segments), T.srtCaption,
    req.message_id ?? undefined, "application/x-subrip");
}

// deno-lint-ignore no-explicit-any
async function handleSummary(cb: any, chatId: number, requestId: number) {
  const { data: req, error } = await db.from("requests")
    .update({ sum_status: "processing", sum_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("telegram_id", cb.from.id)
    .eq("status", "done")
    .not("transcript", "is", null)
    .or(`sum_status.is.null,sum_status.eq.failed,and(sum_status.eq.processing,sum_at.lt.${staleIso()})`)
    .select("id, transcript, message_id, media_type, mime_type")
    .maybeSingle();
  if (error) throw error;
  if (!req) {
    const { data: exists } = await db.from("requests").select("id").eq("id", requestId).eq("telegram_id", cb.from.id)
      .maybeSingle();
    return void await answerCallback(cb.id, exists ? T.sumAlready : T.tsNotFound);
  }

  await answerCallback(cb.id, T.tsStarted);
  await keepOtherButton(chatId, cb, cb.data);
  const script = await userScript(cb.from.id);
  const status = await sendMessage(chatId, TS[script].sumProcessing, req.message_id ?? undefined);
  try {
    const isVideo = req.media_type === "video" || req.media_type === "video_note" ||
      (req.mime_type ?? "").startsWith("video/");
    const sum = await summarize(req.transcript, Date.now() + GEMINI_BUDGET_MS, isVideo ? "video" : "audio", script);
    const { model } = sum;
    // Annotatsiya doim o'zbekcha: kirill tanlangan bo'lsa, qochib ketgan lotin so'zlarni o'giramiz.
    const text = script === "cyrl" ? toCyrillic(sum.text, "all") : sum.text;
    await deliver(chatId, status.message_id, req.message_id, `${TS[script].sumHeader}\n\n${text}`, undefined, "annotatsiya");
    await setSum(requestId, "done");
    console.log(`sum ${requestId}: ${text.length} belgi, ${model}`);
  } catch (e) {
    console.error(`sum ${requestId}`, e);
    const busy = e instanceof BusyError;
    await editMessage(chatId, status.message_id, busy ? T.tsBusy : T.sumFailed,
      inlineKeyboard([{ text: TS[script].sumButton, callback_data: `sum:${requestId}` }])).catch(() => {});
    await setSum(requestId, "failed");
  }
}

/** Kirill rejimida so'z ichiga aralashib qolgan lotin harflarini tuzatadi. */
function fixSegs(segs: Segment[] | null, script: Script): Segment[] | null {
  if (!segs || script !== "cyrl") return segs;
  return segs.map((x) => ({ ...x, text: toCyrillic(x.text, "mixed") }));
}

/** Foydalanuvchi tanlagan yozuv (standart: kirill). */
async function userScript(telegramId: number): Promise<Script> {
  const { data } = await db.from("users").select("script").eq("telegram_id", telegramId).maybeSingle();
  return isScript(data?.script) ? data.script : "cyrl";
}

// deno-lint-ignore no-explicit-any
async function handleScript(cb: any, chatId: number, value: string) {
  if (!isScript(value)) return void await answerCallback(cb.id);
  await upsertUser(cb.from);
  const { error } = await db.from("users").update({ script: value }).eq("telegram_id", cb.from.id);
  if (error) throw error;
  await answerCallback(cb.id, T.scriptSaved(value));
  await editMessage(chatId, cb.message.message_id, T.scriptSaved(value));
}

async function setSum(id: number, sum_status: string) {
  const { error } = await db.from("requests").update({ sum_status, sum_at: new Date().toISOString() }).eq("id", id);
  if (error) console.error("setSum", error);
}

async function setTs(id: number, ts_status: string) {
  const { error } = await db.from("requests").update({ ts_status, ts_at: new Date().toISOString() }).eq("id", id);
  if (error) console.error("setTs", error);
}

function extractMedia(msg: Msg): Media | null {
  if (msg.voice) {
    return { kind: "voice", fileId: msg.voice.file_id, fileSize: msg.voice.file_size, duration: msg.voice.duration,
      mimeType: normalizeMime(msg.voice.mime_type ?? "audio/ogg"), isVideo: false };
  }
  if (msg.video_note) {
    return { kind: "video_note", fileId: msg.video_note.file_id, fileSize: msg.video_note.file_size,
      duration: msg.video_note.duration, mimeType: "video/mp4", isVideo: true };
  }
  if (msg.audio) {
    return { kind: "audio", fileId: msg.audio.file_id, fileSize: msg.audio.file_size, duration: msg.audio.duration,
      mimeType: normalizeMime(msg.audio.mime_type ?? "audio/mpeg"), isVideo: false };
  }
  if (msg.video) {
    return { kind: "video", fileId: msg.video.file_id, fileSize: msg.video.file_size, duration: msg.video.duration,
      mimeType: normalizeMime(msg.video.mime_type ?? "video/mp4"), isVideo: true };
  }
  const yt = youtubeUrl(msg.text ?? msg.caption);
  if (yt) return { kind: "youtube", fileId: "", url: yt, mimeType: "video/*", isVideo: true };
  const doc = msg.document;
  if (doc) {
    const mime = normalizeMime(doc.mime_type ?? mimeFromName(doc.file_name ?? ""));
    if (mime.startsWith("audio/") || mime.startsWith("video/")) {
      return { kind: "document", fileId: doc.file_id, fileSize: doc.file_size, mimeType: mime,
        isVideo: mime.startsWith("video/") };
    }
  }
  return null;
}

function normalizeMime(mime: string): string {
  const m = mime.toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "audio/x-m4a": "audio/mp4",
    "audio/m4a": "audio/mp4",
    "audio/mp3": "audio/mpeg",
    "audio/x-wav": "audio/wav",
    "audio/vnd.wave": "audio/wav",
    "audio/opus": "audio/ogg",
    "audio/x-flac": "audio/flac",
    "video/quicktime": "video/mov",
  };
  return map[m] ?? m;
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
    wav: "audio/wav", flac: "audio/flac", aac: "audio/aac", amr: "audio/amr",
    mp4: "video/mp4", mov: "video/mov", webm: "video/webm", mkv: "video/x-matroska", avi: "video/avi", "3gp": "video/3gpp",
  };
  return map[ext] ?? "application/octet-stream";
}

async function upsertUser(from: Msg) {
  const { error } = await db.from("users").upsert({
    telegram_id: from.id,
    username: from.username ?? null,
    first_name: from.first_name ?? null,
    last_name: from.last_name ?? null,
    language_code: from.language_code ?? null,
    last_seen_at: new Date().toISOString(),
  });
  if (error) console.error("upsertUser", error);
}

async function finish(id: number, status: string, extra: Record<string, unknown> = {}) {
  const { error } = await db.from("requests")
    .update({ status, finished_at: new Date().toISOString(), ...extra })
    .eq("id", id);
  if (error) console.error("finish", error);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
