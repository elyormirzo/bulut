-- "📝 Qisqa xulosa" tugmasi: xulosa tayyor matndan yasaladi, shuning uchun matn saqlanadi.
alter table public.requests
  add column transcript text,
  add column sum_status text check (sum_status in ('processing', 'done', 'failed')),
  add column sum_at     timestamptz;
