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

Qabul qilinadi: ovozli xabar, video-doira, audio, video, audio/video hujjat (forward ham) va
**YouTube havolasi** (Gemini videoni o'zi ochadi — yuklab olish shart emas; ochiq videolar, ~15–20 daqiqagacha).

Yozuv: standart **kirill**, `/yozuv` bilan lotinga o'tkaziladi (`users.script`).

Gemini oqim (SSE) rejimida chaqiriladi: model 30 s ichida javob boshlamasa (osilib qolgan), keyingi
modelga o'tiladi; 503/429 da ham darhol keyingisiga.

Natija darhol vaqt belgilari bilan keladi (`[00:15] …`, ~20 soniyalik xatboshilar). Gemini'dan bitta
so'rovda JSON bo'laklar olinadi va `requests.segments` ga saqlanadi; JSON buzuq kelsa — oddiy matn rejimiga o'tiladi.

Matn ostida ikki tugma (kunlik limitdan yechilmaydi):
- **🎬 .srt subtitr** — saqlangan bo'laklardan bir zumda (Gemini chaqirilmaydi).
- **📝 Qisqa xulosa** — saqlangan matndan (audio qayta yuborilmaydi), bir yozuvga bir marta.

Cheklovlar:
- **20 MB** — Telegram Bot API `getFile` bundan katta faylni bermaydi.
- **20 daqiqa** — Supabase bepul tarifida funksiya ~150 s ishlay oladi (`MAX_DURATION_SEC`).
- **Kuniga 20 so'rov** — har bir foydalanuvchiga, Toshkent vaqti bo'yicha (`DAILY_LIMIT`).
  Xato yoki Gemini limiti tufayli bajarilmagan so'rov hisoblanmaydi.

## Tuzilma

```
supabase/
  config.toml                         verify_jwt = false (Telegram JWT yubormaydi)
  migrations/                         users, requests, start_request(), daily_usage(), ts/sum ustunlari
  functions/telegram-webhook/
    index.ts     webhook, buyruqlar, oqim
    telegram.ts  Bot API yordamchilari, secret_token
    subtitles.ts .srt va vaqt belgili matn yasash
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
2. ✅ Vaqt belgilari, `.srt` subtitr
3. Kim gapirgani (spikerlar)
4. ✅ Qisqa xulosa
5. Guruhga qo'shilganda avtomatik matn
6. bulut.uz sayti (GitHub Pages)
7. Bayonnoma (.docx)
8. To'lov
