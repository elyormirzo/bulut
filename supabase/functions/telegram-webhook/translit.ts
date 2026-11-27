// Kirill rejimida modeldan qochib ketgan lotin harflarini kirillga o'giradi (o'zbek imlosi bo'yicha).

const APOS = "'ʻʼ’‘`";
const LETTER = new RegExp(`[\\p{L}${APOS}]+`, "gu");
const LATIN = /[A-Za-z]/;
const CYR = /[Ѐ-ӿ]/;
const VOWELS = "aeiouAEIOUаеиоуэюяёўАЕИОУЭЮЯЁЎ";

const PAIRS: Record<string, string> = { sh: "ш", ch: "ч", yo: "ё", yu: "ю", ya: "я", ye: "е" };
const SINGLE: Record<string, string> = {
  a: "а", b: "б", c: "ц", d: "д", e: "е", f: "ф", g: "г", h: "ҳ", i: "и", j: "ж", k: "к", l: "л", m: "м",
  n: "н", o: "о", p: "п", q: "қ", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "х", y: "й", z: "з",
};

function up(s: string, upper: boolean) {
  return upper ? s.toUpperCase() : s;
}

/** Bitta so'zdagi lotin harflarini kirillga o'giradi (kirill harflari o'z joyida qoladi). */
export function latinToCyrillic(word: string): string {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    const lo = ch.toLowerCase();
    const next = word[i + 1] ?? "";
    const isUp = ch !== lo;
    if (!LATIN.test(ch)) {
      // tutuq belgisi: so'z ichida bo'lsa ъ, chetida (qo'shtirnoq) — o'zgarmaydi
      if (APOS.includes(ch) && i > 0 && i < word.length - 1) out += "ъ";
      else out += ch;
      continue;
    }
    if (lo === "y" && next.toLowerCase() === "o" && APOS.includes(word[i + 2] || "x")) {
      out += up("й", isUp); // yo'l -> йўл (yo emas, y + o')
      continue;
    }
    if ((lo === "o" || lo === "g") && next && APOS.includes(next)) {
      out += up(lo === "o" ? "ў" : "ғ", isUp);
      i++;
      continue;
    }
    const pair = lo + next.toLowerCase();
    if (PAIRS[pair]) {
      // "SH" (hammasi katta) -> "Ш"; "Sh" -> "Ш"
      out += up(PAIRS[pair], isUp);
      i++;
      continue;
    }
    if (lo === "e" && (i === 0 || VOWELS.includes(word[i - 1]))) {
      out += up("э", isUp);
      continue;
    }
    out += up(SINGLE[lo] ?? ch, isUp);
  }
  return out;
}

/**
 * Kirill matnini tozalaydi.
 *  "mixed" — faqat ichida ham kirill, ham lotin harfi bor so'zlar (transkripsiya: inglizcha so'zlar qoladi);
 *  "all"   — barcha lotin so'zlar (annotatsiya doim o'zbekcha). YouTube, iPhone kabi nomlar qoladi.
 */
export function toCyrillic(text: string, mode: "mixed" | "all"): string {
  // Havola, e-pochta va domenlarga tegmaymiz.
  return text.split(URL).map((part, i) => i % 2 ? part : part.replace(LETTER, (w) => {
    if (!LATIN.test(w)) return w;
    if (!CYR.test(w)) {
      if (mode === "mixed") return w;
      if (/[a-z][A-Z]/.test(w)) return w; // YouTube, iPhone
    }
    return latinToCyrillic(w);
  })).join("");
}

const URL = /((?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.]+|@\w+|\b[\w-]+\.(?:uz|com|ru|org|net|io|me)\b\S*)/i;
