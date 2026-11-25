// MatnQil — Bulut (@matnqil_bot) Telegram webhook.
//
//   POST /telegram-webhook            Telegram update (X-Telegram-Bot-Api-Secret-Token tekshiriladi)
//   GET  /telegram-webhook?setup=1    setWebhook + bot buyruqlarini o'rnatadi (idempotent)
//
// Telegram'ga darhol 200 qaytariladi, transkripsiya EdgeRuntime.waitUntil bilan fonda bajariladi.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { T } from "./texts.ts";
import {
  downloadFile,
  editMessage,
  MAX_DOWNLOAD_BYTES,
  MAX_MESSAGE,
  safeEqual,
  sendMessage,
  sendTextDocument,
  splitText,
  tg,
  webhookSecret,
} from "./telegram.ts";
import { BusyError, diagnose, NO_SPEECH, transcribe } from "./gemini.ts";

const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? 20);
const MAX_DURATION_SEC = Number(Deno.env.get("MAX_DURATION_SEC") ?? 20 * 60);
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
  kind: "voice" | "video_note" | "audio" | "video" | "document";
  fileId: string;
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
    return json(await diagnose(url.searchParams.get("m")?.split(","))); // vaqtinchalik: qaysi Gemini modellari ishlashini ko'rish uchun
  }
  if (req.method !== "POST") return new Response("MatnQil — Bulut", { status: 200 });

  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(got, await webhookSecret())) return new Response("forbidden", { status: 401 });

  const update = await req.json().catch(() => null);
  if (update?.message) {
    EdgeRuntime.waitUntil(
      handleMessage(update.update_id, update.message).catch((e) => console.error("handleMessage", e)),
    );
  }
  return new Response("ok");
});

async function setup() {
  const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram-webhook`;
  await tg("setWebhook", {
    url: webhookUrl,
    secret_token: await webhookSecret(),
    allowed_updates: ["message"],
    max_connections: 20,
  });
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Boshlash" },
      { command: "help", description: "Yordam va cheklovlar" },
      { command: "limit", description: "Bugungi limit" },
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
    return void await sendMessage(chatId, T.start(msg.from.first_name ?? "do'stim", DAILY_LIMIT));
  }
  if (command === "/help") {
    return void await sendMessage(chatId, T.help(DAILY_LIMIT, Math.round(MAX_DURATION_SEC / 60)));
  }
  if (command === "/limit") {
    const { data, error } = await db.rpc("daily_usage", { p_telegram_id: msg.from.id });
    if (error) throw error;
    return void await sendMessage(chatId, T.limit(data ?? 0, DAILY_LIMIT));
  }

  const media = extractMedia(msg);
  if (!media) return void await sendMessage(chatId, T.unsupported);

  if (media.fileSize && media.fileSize > MAX_DOWNLOAD_BYTES) {
    return void await sendMessage(chatId, T.tooBig((media.fileSize / 1024 / 1024).toFixed(1)), msg.message_id);
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

  const deadline = Date.now() + GEMINI_BUDGET_MS;
  const status = await sendMessage(chatId, T.processing, msg.message_id);
  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  try {
    const bytes = await downloadFile(media.fileId);
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      await editMessage(chatId, status.message_id, T.tooBig((bytes.length / 1024 / 1024).toFixed(1)));
      return await finish(requestId, "failed", { error: "too_big" });
    }

    const { text, model } = await transcribe(bytes, media.mimeType, media.isVideo, deadline);

    if (text.includes(NO_SPEECH) && text.replace(NO_SPEECH, "").trim().length < 5) {
      await editMessage(chatId, status.message_id, T.noSpeech);
      return await finish(requestId, "no_speech", { model });
    }

    await deliver(chatId, status.message_id, msg.message_id, text);
    await finish(requestId, "done", { model, text_length: text.length });
  } catch (e) {
    console.error(`request ${requestId}`, e);
    const busy = e instanceof BusyError;
    await editMessage(chatId, status.message_id, busy ? T.busy : T.failed).catch(() => {});
    await finish(requestId, busy ? "quota" : "failed", { error: String(e).slice(0, 1000) });
  }
}

async function deliver(chatId: number, statusId: number, replyTo: number, text: string) {
  const chunks = splitText(text);
  if (chunks.length <= MAX_INLINE_CHUNKS) {
    await editMessage(chatId, statusId, chunks[0]);
    for (const c of chunks.slice(1)) await sendMessage(chatId, c);
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  await sendTextDocument(chatId, `matn-${stamp}.txt`, text + "\n", T.fileCaption, replyTo);
  const preview = text.slice(0, MAX_MESSAGE - 200).replace(/\s+\S*$/, "");
  await editMessage(chatId, statusId, `${T.longAsFile}\n\n${preview}…`);
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
