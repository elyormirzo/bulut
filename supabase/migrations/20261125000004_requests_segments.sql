-- Vaqt belgili bo'laklar: asosiy matn [00:15] ko'rinishida chiqadi, .srt shulardan bir zumda yasaladi.
alter table public.requests add column segments jsonb;
