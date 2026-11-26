# 2 GB gacha fayllar uchun server (VPS)

Telegram oddiy botlarga faqat 20 MB gacha faylni beradi. O'z serverimizda
**Local Telegram Bot API** ishlatsak, bu chegara 2 GB ga ko'tariladi.
Server katta fayldan faqat ovozni ajratadi (1 soat ≈ 7 MB), qolganini bot
avvalgidek qismlarga bo'lib matnga aylantiradi.

```
Telegram ──> VPS (bot-api: faylni yuklab oladi, worker: ffmpeg bilan ovozni ajratadi, caddy: HTTPS)
                 │  webhook
                 ▼
         Supabase telegram-webhook ──> Gemini
```

## Sizdan kerak bo'ladigan narsalar

1. **VPS** — Ubuntu 24.04, kamida 2 GB RAM, 40 GB disk (Hetzner CX22, ~€4–5/oy, yoki boshqa).
2. **Domen yozuvi** — `tg.bulut.uz` uchun **A** yozuv → VPS IP manzili (domen panelida).
3. **api_id va api_hash** — https://my.telegram.org → "API development tools" → ilova yarating
   (nomi ixtiyoriy). Bu ikki qiymatni hech kimga (chatga ham) yubormang.
4. Bot tokeni (@BotFather'dagi). Uni ham faqat serverdagi skriptga kiritasiz.

## O'rnatish

VPS'ga kiring (`ssh root@IP`) va:

```bash
nano install.sh        # install.sh ichidagini to'liq joylab, Ctrl+O, Enter, Ctrl+X
sudo bash install.sh
```

Skript Docker'ni o'rnatadi, 4 ta savol beradi (domen, api_id, api_hash, token),
serverni ishga tushiradi, HTTPS'ni tekshiradi va botni bulutli serverdan
chiqaradi (`logOut`). Oxirida Claude'ga **"server tayyor, domen: …"** deb yozing —
Supabase sozlamalari (`TELEGRAM_API_BASE`, `WORKER_URL`) yangilanadi va webhook
yangi serverga o'tkaziladi.

## Foydali buyruqlar

```bash
cd /opt/matnqil
docker compose ps                 # holat
docker compose logs --tail=50     # loglar
docker compose up -d --build      # qayta ishga tushirish
```

Eski fayllar 12 soatdan keyin avtomatik o'chiriladi.

## Orqaga qaytish (bulutli Bot API'ga)

`https://tg.bulut.uz/bot<TOKEN>/logOut` ni oching, 10 daqiqa kuting, Supabase'dagi
`TELEGRAM_API_BASE` va `WORKER_URL` ni o'chiring va `?setup=1` ni chaqiring.
