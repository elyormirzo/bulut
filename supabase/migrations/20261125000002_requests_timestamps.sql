-- "⏱ Vaqt belgilari va .srt" tugmasi uchun: faylni qayta olish va bir marta tayyorlash.
alter table public.requests
  add column file_id   text,
  add column ts_status text check (ts_status in ('processing', 'done', 'failed')),
  add column ts_at     timestamptz;
