-- =====================================================================
-- Controle de Estoque de Matéria-Prima — configuração do Supabase
--
-- O que este script faz (rode UMA vez no SQL Editor do Supabase; pode ser
-- rodado de novo sem erro):
--   * cria as tabelas profiles, materias, entradas e saidas;
--   * ativa RLS (somente usuários logados leem/gravam);
--   * cria as funções de administração de usuários (login por
--     usuário + senha; o e-mail interno é <usuario>@estoque.app e nunca
--     aparece para os usuários);
--   * cria o usuário inicial  admin / admin  (administrador);
--   * liga o Realtime nas tabelas.
--
-- IMPORTANTE: troque a senha do usuário "admin" logo após o primeiro login
-- (botão "Alterar senha" no topo do sistema).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null,
  is_admin   boolean not null default false,
  created_at timestamptz default now()
);

create table if not exists public.materias (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  created_by uuid default auth.uid(),
  codigo     text,
  nome       text not null,
  unidade    text not null,
  minimo     numeric not null default 0
);

create table if not exists public.entradas (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  created_by uuid default auth.uid(),
  mp_id      uuid not null references public.materias(id) on delete cascade,
  data       date not null,
  qtd        numeric not null check (qtd > 0),
  fornecedor text,
  doc        text,
  obs        text
);

create table if not exists public.saidas (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  created_by uuid default auth.uid(),
  mp_id      uuid not null references public.materias(id) on delete cascade,
  data       date not null,
  qtd        numeric not null check (qtd > 0),
  destino    text,
  resp       text,
  obs        text
);

create index if not exists entradas_mp_id_idx on public.entradas(mp_id);
create index if not exists saidas_mp_id_idx   on public.saidas(mp_id);

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.materias enable row level security;
alter table public.entradas enable row level security;
alter table public.saidas   enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

do $$
declare t text;
begin
  foreach t in array array['materias','entradas','saidas'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (true)', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (true) with check (true)', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (true)', t || '_delete', t);
  end loop;
end $$;

-- Permissões de tabela (RLS faz o resto). profiles: somente leitura.
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.materias, public.entradas, public.saidas to authenticated;

-- ---------------------------------------------------------------------
-- Funções
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth, extensions
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.admin_create_user(
  p_username text,
  p_password text,
  p_is_admin boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_user  text := lower(btrim(coalesce(p_username, '')));
  v_email text;
  v_id    uuid := gen_random_uuid();
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem criar usuários.';
  end if;
  if v_user !~ '^[a-z0-9._-]{3,30}$' then
    raise exception 'Usuário inválido: use 3 a 30 caracteres (letras, números, ponto, hífen ou sublinhado).';
  end if;
  if p_password is null or length(p_password) < 4 then
    raise exception 'A senha deve ter pelo menos 4 caracteres.';
  end if;
  v_email := v_user || '@estoque.app';
  if exists (select 1 from public.profiles where username = v_user)
     or exists (select 1 from auth.users where email = v_email) then
    raise exception 'Já existe um usuário com esse nome.';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('username', v_user),
    now(), now(), '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_id, v_id::text,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  insert into public.profiles (id, username, is_admin)
  values (v_id, v_user, coalesce(p_is_admin, false));

  return v_id;
end;
$$;

create or replace function public.admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare v_target public.profiles;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem excluir usuários.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'Você não pode excluir o seu próprio usuário.';
  end if;
  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'Usuário não encontrado.';
  end if;
  if v_target.is_admin and (select count(*) from public.profiles where is_admin) <= 1 then
    raise exception 'Não é possível excluir o último administrador.';
  end if;
  delete from auth.users where id = p_user_id;  -- profiles cai em cascata
end;
$$;

create or replace function public.admin_set_password(p_user_id uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem redefinir senhas.';
  end if;
  if p_password is null or length(p_password) < 4 then
    raise exception 'A senha deve ter pelo menos 4 caracteres.';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = p_user_id;
  if not found then
    raise exception 'Usuário não encontrado.';
  end if;
end;
$$;

create or replace function public.admin_set_admin(p_user_id uuid, p_is_admin boolean)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare v_target public.profiles;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem alterar permissões.';
  end if;
  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'Usuário não encontrado.';
  end if;
  if v_target.is_admin and not coalesce(p_is_admin, false)
     and (select count(*) from public.profiles where is_admin) <= 1 then
    raise exception 'Não é possível remover o último administrador.';
  end if;
  update public.profiles set is_admin = coalesce(p_is_admin, false) where id = p_user_id;
end;
$$;

create or replace function public.change_my_password(p_old text, p_new text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare v_hash text;
begin
  if auth.uid() is null then
    raise exception 'Faça login novamente.';
  end if;
  if p_new is null or length(p_new) < 4 then
    raise exception 'A nova senha deve ter pelo menos 4 caracteres.';
  end if;
  select encrypted_password into v_hash from auth.users where id = auth.uid();
  if v_hash is null or v_hash <> extensions.crypt(coalesce(p_old, ''), v_hash) then
    raise exception 'Senha atual incorreta.';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf')),
         updated_at = now()
   where id = auth.uid();
end;
$$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.admin_create_user(text, text, boolean) from public, anon;
revoke all on function public.admin_delete_user(uuid) from public, anon;
revoke all on function public.admin_set_password(uuid, text) from public, anon;
revoke all on function public.admin_set_admin(uuid, boolean) from public, anon;
revoke all on function public.change_my_password(text, text) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_create_user(text, text, boolean) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
grant execute on function public.admin_set_password(uuid, text) to authenticated;
grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;
grant execute on function public.change_my_password(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Usuário inicial: admin / admin (TROQUE A SENHA após o primeiro login)
-- ---------------------------------------------------------------------
do $$
declare v_id uuid := gen_random_uuid();
begin
  if not exists (select 1 from auth.users where email = 'admin@estoque.app') then
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      'admin@estoque.app', extensions.crypt('admin', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('username', 'admin'),
      now(), now(), '', '', '', ''
    );
    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_id, v_id::text,
      jsonb_build_object('sub', v_id::text, 'email', 'admin@estoque.app', 'email_verified', true),
      'email', now(), now(), now()
    );
    insert into public.profiles (id, username, is_admin) values (v_id, 'admin', true);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['materias','entradas','saidas','profiles'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
