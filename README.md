# bulut

**bulut.uz** — o'zbekcha audio va videoni matnga aylantiruvchi xizmat.

- Telegram bot: [@matnqil_bot](https://t.me/matnqil_bot) (MatnQil — Bulut)
- Transkripsiya: Google Gemini (Flash)
- Server: Supabase (Edge Functions, Database)

## Qanday ishlaydi

```
Telegram ──webhook──▶ Edge Function `telegram-webhook`
                        │  1. secret_token tekshiriladi, darhol 200 qaytariladi
                        │  2. fonda (EdgeRuntime.waitUntil):
                        │     limit → getFile → yuklab olish → Gemini → matn
                        ▼
                     Telegram'ga javob (≤ 3 xabar, uzunroq bo'lsa .txt fayl)
```

Qabul qilinadi: ovozli xabar, video-doira, audio, video, audio/video hujjat.

Cheklovlar:
- **20 MB** — Telegram Bot API `getFile` bundan katta faylni bermaydi.
- **20 daqiqa** — Supabase bepul tarifida funksiya ~150 s ishlay oladi (`MAX_DURATION_SEC`).
- **Kuniga 20 so'rov** — har bir foydalanuvchiga, Toshkent vaqti bo'yicha (`DAILY_LIMIT`).
  Xato yoki Gemini limiti tufayli bajarilmagan so'rov hisoblanmaydi.

## Tuzilma

```
supabase/
  config.toml                         verify_jwt = false (Telegram JWT yubormaydi)
  migrations/…_bot_users_requests.sql users, requests, start_request(), daily_usage()
  functions/telegram-webhook/
    index.ts     webhook, buyruqlar, oqim
    telegram.ts  Bot API yordamchilari, secret_token
    gemini.ts    transkripsiya (inline ≤ 7 MB, kattasi Files API)
    texts.ts     foydalanuvchiga ko'rinadigan matnlar
```

## Sozlash

Edge Function secrets: `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`.
Ixtiyoriy: `DAILY_LIMIT`, `MAX_DURATION_SEC`, `GEMINI_BUDGET_MS`, `GEMINI_MODELS` (vergul bilan, tartib bo'yicha sinaladi;
standart: `gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.8-flash,gemini-flash-latest`).

Diagnostika (vaqtinchalik): `GET …/telegram-webhook?diag=1&m=model1,model2` — qaysi modellar ochiq va javob beryapti.

Webhook secret_token alohida saqlanmaydi — bot tokenidan HMAC bilan hosil qilinadi,
shuning uchun token almashtirilsa, webhook'ni qayta o'rnatish kifoya:

```sh
curl "https://mdkqeknigvfoeegpykxr.supabase.co/functions/v1/telegram-webhook?setup=1"
```

Bu `setWebhook`, buyruqlar ro'yxati va bot tavsifini o'rnatadi (qayta chaqirish xavfsiz).

## Reja

1. ✅ Telegram bot: nutq → matn
2. Vaqt belgilari, `.srt` subtitr
3. Kim gapirgani (spikerlar)
4. Xulosa
5. Guruhga qo'shilganda avtomatik matn
6. bulut.uz sayti (GitHub Pages)
7. Bayonnoma (.docx)
8. To'lov
