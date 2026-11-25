// Vaqt belgili bo'laklardan (segment) .srt subtitr va "[00:15] matn" ko'rinishidagi matn yasash.

export interface Segment {
  start: number; // soniya
  end: number; // soniya
  text: string;
}

export interface RawSegment {
  start?: string | number;
  end?: string | number;
  text?: string;
}

/** "75", "1:15", "01:15.5", "0:01:15,500" → soniya. Tushunarsiz bo'lsa NaN. */
export function parseTime(v: string | number | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const s = v.trim().replace(",", ".");
  if (!/^\d+(:\d+){0,2}(\.\d+)?$/.test(s)) return NaN;
  return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** Model qaytargan bo'laklarni tozalaydi: tartiblaydi, ustma-ust tushishni va bo'sh joylarni to'g'rilaydi. */
export function normalizeSegments(raw: RawSegment[], durationSec?: number): Segment[] {
  const segs = raw
    .map((r) => ({ start: parseTime(r.start), end: parseTime(r.end), text: (r.text ?? "").replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text && Number.isFinite(s.start) && s.start >= 0)
    .sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const next = segs[i + 1];
    let end = Number.isFinite(s.end) && s.end > s.start ? s.end : s.start + Math.min(7, Math.max(1.5, s.text.length / 15));
    if (next && end > next.start) end = Math.max(next.start, s.start + 0.5);
    if (durationSec && end > durationSec) end = Math.max(durationSec, s.start + 0.5);
    out.push({ start: s.start, end, text: s.text });
  }
  return out;
}

function pad(n: number, w = 2) {
  return String(Math.floor(n)).padStart(w, "0");
}

/** 75.5 → "00:01:15,500" (SRT formati) */
export function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** 75.5 → "01:15", 3725 → "1:02:05" */
export function shortTime(sec: number): string {
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** SRT ichida bir qator ~42 belgidan oshmasligi uchun matnni 2 qatorga bo'ladi. */
function wrap(text: string, max = 42): string {
  if (text.length <= max) return text;
  const mid = Math.floor(text.length / 2);
  let cut = text.lastIndexOf(" ", mid);
  const after = text.indexOf(" ", mid);
  if (cut < 0 || (after >= 0 && after - mid < mid - cut)) cut = after;
  if (cut <= 0) return text;
  return `${text.slice(0, cut)}\n${text.slice(cut + 1)}`;
}

export function toSrt(segs: Segment[]): string {
  return segs
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${wrap(s.text)}\n`)
    .join("\n");
}

/** "[00:15] matn" qatorlari. Yaqin bo'laklar bitta qatorga birlashtiriladi (o'qishga qulay). */
export function toTimestampedText(segs: Segment[], groupSec = 20): string {
  const lines: string[] = [];
  let cur: { start: number; parts: string[] } | null = null;
  for (const s of segs) {
    if (!cur || s.start - cur.start >= groupSec || /[.!?…]$/.test(cur.parts.at(-1) ?? "") && s.start - cur.start >= groupSec / 2) {
      if (cur) lines.push(`[${shortTime(cur.start)}] ${cur.parts.join(" ")}`);
      cur = { start: s.start, parts: [] };
    }
    cur.parts.push(s.text);
  }
  if (cur) lines.push(`[${shortTime(cur.start)}] ${cur.parts.join(" ")}`);
  return lines.join("\n\n");
}
