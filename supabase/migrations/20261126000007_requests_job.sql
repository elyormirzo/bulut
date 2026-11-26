-- Uzun yozuvlarni qismlarga bo'lib ishlash holati (manba, navbatdagi qism, urinishlar va h.k.).
alter table public.requests add column job jsonb;
