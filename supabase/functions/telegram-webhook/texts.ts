// Foydalanuvchiga ko'rinadigan barcha matnlar (o'zbek, lotin).
// Natija bilan bog'liq tugma va sarlavhalar foydalanuvchi tanlagan yozuvda: TS.cyrl / TS.latn.

import type { Script } from "./gemini.ts";

export const TS: Record<Script, { srtButton: string; sumButton: string; sumHeader: string; sumProcessing: string }> = {
  cyrl: {
    srtButton: `🎬 .srt субтитр`,
    sumButton: `📝 Аннотация`,
    sumHeader: `📝 Аннотация`,
    sumProcessing: `⏳ Аннотация тайёрланмоқда…`,
  },
  latn: {
    srtButton: `🎬 .srt subtitr`,
    sumButton: `📝 Annotatsiya`,
    sumHeader: `📝 Annotatsiya`,
    sumProcessing: `⏳ Annotatsiya tayyorlanmoqda…`,
  },
};

export function isScript(v: unknown): v is Script {
  return v === "cyrl" || v === "latn";
}

export const T = {
  start: (name: string, limit: number) =>
    `Assalomu alaykum, ${name}! 👋\n\n` +
    `Men MatnQil — Bulut botiman. O'zbekcha nutqni matnga aylantiraman.\n\n` +
    `Menga yuboring:\n` +
    `🎤 ovozli xabar\n` +
    `⭕ video-doira\n` +
    `🎵 audio fayl (mp3, m4a, ogg, wav…)\n` +
    `🎬 video fayl\n` +
    `🔗 YouTube havolasi\n\n` +
    `Men esa uni matn qilib qaytaraman.\n\n` +
    `Cheklovlar: fayl 20 MB gacha, kuniga ${limit} ta so'rov.\n` +
    `Yordam: /help`,

  help: (limit: number, maxMin: number) =>
    `ℹ️ Qanday ishlatiladi\n\n` +
    `1. Ovozli xabar, video-doira, audio yoki video yuboring (boshqa chatdan forward qilsangiz ham bo'ladi) ` +
    `yoki YouTube havolasini tashlang.\n` +
    `2. Bir necha soniya kuting.\n` +
    `3. Matn shu yerga keladi. Uzun matn .txt fayl bo'lib keladi.\n\n` +
    `Cheklovlar:\n` +
    `• Fayl hajmi 20 MB gacha (Telegram botlarga shundan katta faylni yuklab olishga ruxsat bermaydi)\n` +
    `• Uzun yozuvlar qismlarga bo'lib ishlanadi (${Math.round(maxMin / 60)} soatgacha)\n` +
    `• Kuniga ${limit} ta so'rov\n\n` +
    `Fayl katta bo'lsa, siqib yoki bo'laklarga bo'lib yuboring.\n\n` +
    `Buyruqlar:\n/start — boshlash\n/help — yordam\n/limit — bugungi limit\n/yozuv — kirill yoki lotin yozuvi`,

  limit: (used: number, limit: number) =>
    `📊 Bugun ${used} / ${limit} ta so'rov ishlatildi.\n` +
    (used >= limit
      ? `Limit tugadi. Ertaga (Toshkent vaqti bilan 00:00 dan keyin) yana foydalanishingiz mumkin.`
      : `Yana ${limit - used} ta so'rov qoldi.`),

  processing: `⏳ Matnga aylantirilmoqda…`,
  processingYt: `⏳ YouTube videosi matnga aylantirilmoqda…`,
  longStart: (parts: number | null) =>
    `⏳ Uzun yozuv — qismlarga bo'lib matnga aylantirilmoqda` + (parts ? ` (${parts} qism)` : ``) + `.\n` +
    `Har bir qism tayyor bo'lganda shu yerda ko'rsataman. Bir oz vaqt oladi.`,
  longProgress: (upTo: string, done: number, total: number | null) =>
    `⏳ Matnga aylantirilmoqda… ${upTo} gacha tayyor` + (total ? ` (${done}/${total} qism)` : ` (${done} qism)`) + `.`,
  longPartial: (upTo: string) =>
    `⚠️ Navbat ko'pligi sababli faqat ${upTo} gacha bo'lgan qism matnga aylantirildi.`,
  ytFailed:
    `😔 YouTube videosini o'qib bo'lmadi.\n` +
    `Video ochiq (public) ekanini tekshiring — yopiq, faqat havola orqali ko'rinadigan yoki yoshga cheklangan videolar ishlamaydi.\n` +
    `(Bu so'rov limitingizdan yechilmadi.)`,
  ytTimeout:
    `😔 Video juda uzun yoki hozir navbat ko'p — ajratilgan vaqtga sig'madi.\n` +
    `Hozircha 15–20 daqiqagacha bo'lgan videolar ishonchli ishlaydi. Birozdan keyin yana urinib ko'ring.\n` +
    `(Bu so'rov limitingizdan yechilmadi.)`,

  tooBig: (mb: string) =>
    `😔 Fayl juda katta (${mb} MB).\n\n` +
    `Telegram botlarga faqat 20 MB gacha bo'lgan faylni yuklab olishga ruxsat beradi. ` +
    `Faylni siqib yoki bo'laklarga bo'lib yuboring.`,

  tooLong: (maxMin: number) =>
    `😔 Yozuv juda uzun. Hozircha ${maxMin} daqiqagacha bo'lgan yozuvni qabul qilaman. ` +
    `Uni bo'laklarga bo'lib yuboring.`,

  limitReached: (limit: number) =>
    `⛔ Bugungi limit tugadi (${limit} ta so'rov).\n` +
    `Ertaga (Toshkent vaqti bilan 00:00 dan keyin) yana foydalanishingiz mumkin.`,

  busy:
    `🙏 Hozir navbat ko'p. Birozdan keyin qayta urinib ko'ring.\n` +
    `(Bu so'rov limitingizdan yechilmadi.)`,

  noSpeech: `🤔 Bu yozuvda nutq topilmadi. Boshqa fayl yuborib ko'ring.`,

  failed:
    `😔 Matnga aylantirib bo'lmadi. Birozdan keyin qayta urinib ko'ring.\n` +
    `(Bu so'rov limitingizdan yechilmadi.)`,

  unsupported:
    `Men ovozli xabar, video-doira, audio, video fayllarni va YouTube havolalarini matnga aylantiraman. ` +
    `Shulardan birini yuboring. Yordam: /help`,

  longAsFile: `📄 Matn uzun bo'lgani uchun fayl qilib yubordim.`,

  fileCaption: `MatnQil — Bulut · @matnqil_bot`,

  scriptAsk: (cur: Script) =>
    `✍️ Matn va annotatsiya qaysi yozuvda chiqsin?\n` +
    `Hozir: ${cur === "cyrl" ? "Кирилл" : "Lotin"}`,
  scriptSaved: (s: Script) =>
    s === "cyrl" ? `✅ Энди матн кирилл ёзувида чиқади.` : `✅ Endi matn lotin yozuvida chiqadi.`,

  tsButton: `⏱ Vaqt belgilari va .srt`,
  srtButton: `🎬 .srt subtitr`,
  sumButton: `📝 Annotatsiya`,
  sumProcessing: `⏳ Annotatsiya tayyorlanmoqda…`,
  sumHeader: `📝 Annotatsiya`,
  sumAlready: `Bu yozuvning annotatsiyasi allaqachon tayyorlangan yoki tayyorlanmoqda.`,
  sumFailed: `😔 Annotatsiyani tayyorlab bo'lmadi. Tugmani birozdan keyin qayta bosib ko'ring.`,
  tsProcessing: `⏳ Vaqt belgilari va subtitr tayyorlanmoqda…`,
  tsStarted: `Tayyorlanmoqda…`,
  tsAlready: `Bu yozuv uchun subtitr allaqachon tayyorlangan yoki tayyorlanmoqda.`,
  tsNotFound: `Bu yozuv topilmadi. Faylni qaytadan yuboring.`,
  tsHeader: `⏱ Vaqt belgilari bilan:`,
  srtCaption:
    `🎬 Subtitr fayli (.srt).\n` +
    `Videoga qo'shish: video muharririda (CapCut, Premiere, VLC…) "Subtitr qo'shish" orqali shu faylni tanlang.\n\n` +
    `MatnQil — Bulut · @matnqil_bot`,
  tsNoSpeech: `🤔 Vaqt belgilari uchun nutq topilmadi.`,
  tsFailed:
    `😔 Subtitrni tayyorlab bo'lmadi. Tugmani birozdan keyin qayta bosib ko'ring.`,
  tsBusy:
    `🙏 Hozir navbat ko'p. Tugmani birozdan keyin qayta bosib ko'ring.`,
};
