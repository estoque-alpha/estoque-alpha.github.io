-- =====================================================================
-- Alpha - Autoria e histórico de alterações
-- Rode este script UMA vez no SQL Editor do Supabase (pode rodar de
-- novo sem problema).
--
-- O que ele faz:
--   * Grava automaticamente QUEM cadastrou e QUEM alterou por último cada
--     matéria-prima, entrada e saída (o próprio banco preenche, não dá
--     para falsificar pelo site).
--   * Cria a tabela "historico", que registra toda inclusão, alteração e
--     exclusão, com o usuário e a data/hora. Ninguém consegue editar nem
--     apagar o histórico pelo site.
-- =====================================================================

-- Colunas de "alterado por" ------------------------------------------
alter table public.materias add column if not exists updated_by uuid;
alter table public.materias add column if not exists updated_at timestamptz;
alter table public.entradas add column if not exists updated_by uuid;
alter table public.entradas add column if not exists updated_at timestamptz;
alter table public.saidas   add column if not exists updated_by uuid;
alter table public.saidas   add column if not exists updated_at timestamptz;

-- Preenche autoria no próprio banco ----------------------------------
create or replace function public.tg_autoria()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    new.updated_by := null;
    new.updated_at := null;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- Histórico de alterações --------------------------------------------
create table if not exists public.historico (
  id          bigint generated always as identity primary key,
  quando      timestamptz not null default now(),
  usuario_id  uuid,
  usuario     text,
  tabela      text not null,
  acao        text not null,        -- insert | update | delete
  registro_id uuid,
  dados       jsonb,                -- registro novo (ou o excluído)
  anterior    jsonb                 -- registro antes da alteração
);
create index if not exists historico_quando_idx on public.historico (id desc);

alter table public.historico enable row level security;
drop policy if exists historico_select on public.historico;
create policy historico_select on public.historico
  for select to authenticated using (true);
revoke all on public.historico from anon;
grant select on public.historico to authenticated;

create or replace function public.tg_historico()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_old  jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_mp   public.materias%rowtype;
begin
  -- Guarda o nome da matéria-prima junto, para o histórico continuar legível
  -- mesmo se ela for excluída depois.
  if tg_table_name in ('entradas', 'saidas') then
    select * into v_mp from public.materias where id = (v_row->>'mp_id')::uuid;
    if found then
      v_row := v_row || jsonb_build_object('mp_nome', v_mp.nome, 'mp_unidade', v_mp.unidade);
    end if;
  end if;

  insert into public.historico (usuario_id, usuario, tabela, acao, registro_id, dados, anterior)
  values (
    auth.uid(),
    (select username from public.profiles where id = auth.uid()),
    tg_table_name,
    lower(tg_op),
    (v_row->>'id')::uuid,
    v_row,
    v_old
  );
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['materias','entradas','saidas'] loop
    execute format('drop trigger if exists autoria on public.%I', t);
    execute format('create trigger autoria before insert or update on public.%I
                    for each row execute function public.tg_autoria()', t);
    execute format('drop trigger if exists historico on public.%I', t);
    execute format('create trigger historico after insert or update or delete on public.%I
                    for each row execute function public.tg_historico()', t);
  end loop;
end $$;

-- Tempo real para o histórico ----------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'historico'
  ) then
    alter publication supabase_realtime add table public.historico;
  end if;
end $$;
