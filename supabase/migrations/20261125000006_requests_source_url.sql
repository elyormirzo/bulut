-- YouTube havolasi orqali kelgan so'rovlar uchun manba (Telegram file_id o'rniga).
alter table public.requests add column source_url text;
