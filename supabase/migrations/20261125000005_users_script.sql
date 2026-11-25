-- Foydalanuvchi tanlagan yozuv: kirill (standart) yoki lotin. /yozuv buyrug'i bilan o'zgartiriladi.
alter table public.users
  add column script text not null default 'cyrl' check (script in ('cyrl', 'latn'));

-- start_request endi foydalanuvchi yozuvini ham qaytaradi (qo'shimcha so'rovsiz).
create or replace function public.start_request(
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
  v_tid    bigint := (p_user ->> 'id')::bigint;
  v_used   integer;
  v_id     bigint;
  v_script text;
begin
  perform pg_advisory_xact_lock(v_tid);

  insert into public.users (telegram_id, username, first_name, last_name, language_code)
  values (v_tid, p_user ->> 'username', p_user ->> 'first_name', p_user ->> 'last_name', p_user ->> 'language_code')
  on conflict (telegram_id) do update
    set username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        language_code = excluded.language_code,
        last_seen_at = now()
  returning script into v_script;

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

  return jsonb_build_object('ok', true, 'id', v_id, 'used', v_used + 1, 'script', v_script);
end;
$$;
