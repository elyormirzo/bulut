// Telegram Bot API uchun yupqa yordamchi funksiyalar.

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;

export const MAX_MESSAGE = 4096;
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // Bot API getFile cheklovi

export class TelegramError extends Error {
  constructor(public method: string, public code: number, description: string) {
    super(`Telegram ${method} ${code}: ${description}`);
  }
}

// deno-lint-ignore no-explicit-any
export async function tg<R = any>(method: string, payload: Record<string, unknown> = {}): Promise<R> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new TelegramError(method, data.error_code ?? res.status, data.description ?? "unknown");
  return data.result as R;
}

export function sendMessage(chatId: number, text: string, replyTo?: number) {
  return tg<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export function inlineKeyboard(...rows: InlineButton[][]) {
  return { inline_keyboard: rows };
}

export async function editMessage(chatId: number, messageId: number, text: string, replyMarkup?: unknown) {
  try {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (e) {
    // Xabarni tahrirlab bo'lmasa (o'chirilgan va h.k.), yangisini yuboramiz.
    if (e instanceof TelegramError && /not modified/.test(e.message)) return;
    await tg("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

/** Tugmalarni olib tashlaydi (matnga tegmaydi). */
export function removeKeyboard(chatId: number, messageId: number) {
  return tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId }).catch(() => {});
}

export function answerCallback(id: string, text?: string) {
  return tg("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => {});
}

export async function sendTextDocument(
  chatId: number,
  filename: string,
  content: string,
  caption: string,
  replyTo?: number,
  mime = "text/plain;charset=utf-8",
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  if (replyTo) {
    form.append("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
  }
  form.append("document", new Blob([content], { type: mime }), filename);
  const res = await fetch(`${API}/sendDocument`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new TelegramError("sendDocument", data.error_code ?? res.status, data.description ?? "unknown");
}

export async function downloadFile(fileId: string): Promise<Uint8Array> {
  const file = await tg<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("getFile: file_path yo'q");
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Faylni yuklab bo'lmadi: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Matnni Telegram cheklovi bo'yicha bo'laklarga bo'ladi (iloji boricha qator/so'z chegarasida). */
export function splitText(text: string, size = MAX_MESSAGE - 96): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function hmacHex(label: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Webhook secret_token: bot tokenidan HMAC orqali hosil qilinadi, alohida secret kerak emas. */
export function webhookSecret(): Promise<string> {
  return hmacHex("bulut-telegram-webhook-v1");
}

/** Funksiya o'zini-o'zi chaqirishi (uzun yozuv qismlari) uchun ichki kalit. */
export function internalSecret(): Promise<string> {
  return hmacHex("bulut-internal-step-v1");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
