// Foydalanuvchiga ko'rinadigan barcha matnlar (o'zbek, lotin).

export const T = {
  start: (name: string, limit: number) =>
    `Assalomu alaykum, ${name}! 👋\n\n` +
    `Men MatnQil — Bulut botiman. O'zbekcha nutqni matnga aylantiraman.\n\n` +
    `Menga yuboring:\n` +
    `🎤 ovozli xabar\n` +
    `⭕ video-doira\n` +
    `🎵 audio fayl (mp3, m4a, ogg, wav…)\n` +
    `🎬 video fayl\n\n` +
    `Men esa uni matn qilib qaytaraman.\n\n` +
    `Cheklovlar: fayl 20 MB gacha, kuniga ${limit} ta so'rov.\n` +
    `Yordam: /help`,

  help: (limit: number, maxMin: number) =>
    `ℹ️ Qanday ishlatiladi\n\n` +
    `1. Ovozli xabar, video-doira, audio yoki video yuboring (boshqa chatdan forward qilsangiz ham bo'ladi).\n` +
    `2. Bir necha soniya kuting.\n` +
    `3. Matn shu yerga keladi. Uzun matn .txt fayl bo'lib keladi.\n\n` +
    `Cheklovlar:\n` +
    `• Fayl hajmi 20 MB gacha (Telegram botlarga shundan katta faylni yuklab olishga ruxsat bermaydi)\n` +
    `• Davomiyligi ${maxMin} daqiqagacha\n` +
    `• Kuniga ${limit} ta so'rov\n\n` +
    `Fayl katta bo'lsa, siqib yoki bo'laklarga bo'lib yuboring.\n\n` +
    `Buyruqlar:\n/start — boshlash\n/help — yordam\n/limit — bugungi limit`,

  limit: (used: number, limit: number) =>
    `📊 Bugun ${used} / ${limit} ta so'rov ishlatildi.\n` +
    (used >= limit
      ? `Limit tugadi. Ertaga (Toshkent vaqti bilan 00:00 dan keyin) yana foydalanishingiz mumkin.`
      : `Yana ${limit - used} ta so'rov qoldi.`),

  processing: `⏳ Matnga aylantirilmoqda…`,

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
    `Men ovozli xabar, video-doira, audio va video fayllarni matnga aylantiraman. ` +
    `Shulardan birini yuboring. Yordam: /help`,

  longAsFile: `📄 Matn uzun bo'lgani uchun fayl qilib yubordim.`,

  fileCaption: `MatnQil — Bulut · @matnqil_bot`,
};
