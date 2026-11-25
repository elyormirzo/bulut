-- MatnQil bot: foydalanuvchilar va so'rovlar (kunlik limit uchun).
-- Jadvallarga faqat edge funksiya (service_role) kiradi: RLS yoqilgan,
-- anon/authenticated uchun policy yo'q.

create table public.users (
  telegram_id   bigint primary key,
  username      text,
  first_name    text,
  last_name     text,
  language_code text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table public.requests (
  id            bigint generated always as identity primary key,
  update_id     bigint unique,
  telegram_id   bigint not null references public.users (telegram_id) on delete cascade,
  chat_id       bigint not null,
  message_id    bigint,
  media_type    text not null,
  mime_type     text,
  file_size     bigint,
  duration_sec  integer,
  status        text not null default 'processing'
                check (status in ('processing', 'done', 'no_speech', 'failed', 'quota')),
  error         text,
  text_length   integer,
  model         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index requests_user_created_idx on public.requests (telegram_id, created_at desc);

alter table public.users enable row level security;
alter table public.requests enable row level security;

revoke all on table public.users, public.requests from anon, authenticated;

-- Bugun (Toshkent vaqti bilan) hisobga olinadigan so'rovlar soni.
-- 'done' va yaqinda boshlangan 'processing' hisoblanadi; xato/limit tufayli
-- bajarilmaganlari foydalanuvchi limitidan yechilmaydi.
create function public.daily_usage(p_telegram_id bigint)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
  from public.requests r
  where r.telegram_id = p_telegram_id
    and r.created_at >= (date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent')
    and (r.status = 'done'
         or (r.status = 'processing' and r.created_at > now() - interval '15 minutes'));
$$;

-- Foydalanuvchini yangilaydi, limitni tekshiradi va so'rovni atomar yozadi.
create function public.start_request(
  p_update_id   bigint,
  p_user        jsonb,
  p_chat_id     bigint,
  p_message_id  bigint,
  p_media_type  text,
  p_mime_type   text,
  p_file_size   bigint,
  p_duration    integer,
  p_daily_limit integer
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_tid  bigint := (p_user ->> 'id')::bigint;
  v_used integer;
  v_id   bigint;
begin
  perform pg_advisory_xact_lock(v_tid);

  insert into public.users (telegram_id, username, first_name, last_name, language_code)
  values (v_tid, p_user ->> 'username', p_user ->> 'first_name', p_user ->> 'last_name', p_user ->> 'language_code')
  on conflict (telegram_id) do update
    set username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        language_code = excluded.language_code,
        last_seen_at = now();

  if exists (select 1 from public.requests where update_id = p_update_id) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;

  v_used := public.daily_usage(v_tid);
  if v_used >= p_daily_limit then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'used', v_used);
  end if;

  insert into public.requests (update_id, telegram_id, chat_id, message_id, media_type, mime_type, file_size, duration_sec)
  values (p_update_id, v_tid, p_chat_id, p_message_id, p_media_type, p_mime_type, p_file_size, p_duration)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'used', v_used + 1);
end;
$$;

revoke execute on function public.daily_usage(bigint) from public, anon, authenticated;
revoke execute on function public.start_request(bigint, jsonb, bigint, bigint, text, text, bigint, integer, integer) from public, anon, authenticated;
grant execute on function public.daily_usage(bigint) to service_role;
grant execute on function public.start_request(bigint, jsonb, bigint, bigint, text, text, bigint, integer, integer) to service_role;
