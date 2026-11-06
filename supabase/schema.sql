-- PaperForge v2.0 / Supabase Postgres
-- Run this once in Supabase SQL Editor. Then sign in using the intended
-- Google account and run the bootstrap statement in README-v2.md.
-- Frontend keys can never grant admin privileges.

create extension if not exists pgcrypto;

create table if not exists public.pf_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'user' check (role in ('user','admin')),
  plan text not null default 'trial' check (plan in ('trial','premium','complimentary','suspended')),
  free_exports_used integer not null default 0 check (free_exports_used between 0 and 1),
  premium_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pf_payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.pf_profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  amount numeric(10,2) not null default 10 check (amount = 10),
  currency text not null default 'MYR' check (currency = 'MYR'),
  payment_reference text not null check (char_length(payment_reference) between 2 and 120),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.pf_profiles(id)
);

create unique index if not exists pf_one_pending_request
  on public.pf_payment_requests(user_id) where status = 'pending';

create table if not exists public.pf_export_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.pf_profiles(id) on delete cascade,
  export_kind text not null check (export_kind in ('pdf_edit','pdf_to_word','word_to_pdf')),
  entitlement text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.pf_admin_audit (
  id bigint generated always as identity primary key,
  admin_id uuid not null references public.pf_profiles(id),
  target_user_id uuid references public.pf_profiles(id),
  action text not null,
  created_at timestamptz not null default now()
);

-- Use trusted auth.users identity, not an email supplied by the browser.
create or replace function public.pf_create_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pf_profiles(id,email,full_name)
  values(new.id, coalesce(new.email,''), new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists pf_new_user on auth.users;
create trigger pf_new_user after insert on auth.users
for each row execute procedure public.pf_create_profile();

-- Backfill accounts that existed before this feature was installed.
insert into public.pf_profiles(id,email,full_name)
select id, coalesce(email,''), raw_user_meta_data ->> 'full_name'
from auth.users on conflict (id) do nothing;

create or replace function public.pf_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.pf_profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$$;

alter table public.pf_profiles enable row level security;
alter table public.pf_payment_requests enable row level security;
alter table public.pf_export_events enable row level security;
alter table public.pf_admin_audit enable row level security;

-- Only read operations and payment-request creation are allowed to browser roles.
-- SECURITY DEFINER functions handle quota consumption and admin-only changes.
revoke all on public.pf_profiles, public.pf_payment_requests,
  public.pf_export_events, public.pf_admin_audit from anon, authenticated;
grant select on public.pf_profiles, public.pf_payment_requests,
  public.pf_export_events, public.pf_admin_audit to authenticated;
grant insert on public.pf_payment_requests to authenticated;

drop policy if exists pf_profiles_read on public.pf_profiles;
create policy pf_profiles_read on public.pf_profiles
for select to authenticated
using (id = (select auth.uid()) or (select public.pf_is_admin()));

drop policy if exists pf_payments_read on public.pf_payment_requests;
create policy pf_payments_read on public.pf_payment_requests
for select to authenticated
using (user_id = (select auth.uid()) or (select public.pf_is_admin()));

drop policy if exists pf_payments_create on public.pf_payment_requests;
create policy pf_payments_create on public.pf_payment_requests
for insert to authenticated
with check (
  user_id = (select auth.uid()) and status = 'pending'
  and amount = 10 and currency = 'MYR'
  and decided_at is null and decided_by is null
);

drop policy if exists pf_events_read on public.pf_export_events;
create policy pf_events_read on public.pf_export_events
for select to authenticated
using (user_id = (select auth.uid()) or (select public.pf_is_admin()));

drop policy if exists pf_audit_admin_read on public.pf_admin_audit;
create policy pf_audit_admin_read on public.pf_admin_audit
for select to authenticated using ((select public.pf_is_admin()));

-- No client policy permits direct profile updates, free quota resets,
-- premium grants, or event insertion. These operations require RPC below.

create or replace function public.pf_consume_export(p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_profile public.pf_profiles%rowtype;
  v_entitlement text;
begin
  if v_uid is null then return jsonb_build_object('allowed',false,'reason','login_required'); end if;
  if p_kind not in ('pdf_edit','pdf_to_word','word_to_pdf') then
    raise exception 'Invalid export kind';
  end if;
  select * into v_profile from public.pf_profiles where id = v_uid for update;
  if not found then return jsonb_build_object('allowed',false,'reason','profile_missing'); end if;
  if v_profile.plan = 'suspended' then
    return jsonb_build_object('allowed',false,'reason','suspended');
  end if;
  if v_profile.role = 'admin' then
    v_entitlement := 'admin';
  elsif v_profile.plan = 'complimentary'
    and (v_profile.premium_expires_at is null or v_profile.premium_expires_at > now()) then
    v_entitlement := 'complimentary';
  elsif v_profile.plan = 'premium' and v_profile.premium_expires_at > now() then
    v_entitlement := 'premium';
  elsif v_profile.free_exports_used = 0 then
    update public.pf_profiles set free_exports_used = 1, updated_at = now() where id = v_uid;
    v_entitlement := 'trial';
  else
    return jsonb_build_object('allowed',false,'reason','trial_exhausted');
  end if;
  insert into public.pf_export_events(user_id, export_kind, entitlement)
  values(v_uid,p_kind,v_entitlement);
  return jsonb_build_object('allowed',true,'reason',v_entitlement);
end;
$$;

create or replace function public.pf_admin_decide_payment(p_request_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_request public.pf_payment_requests%rowtype;
begin
  if not public.pf_is_admin() then raise exception 'Admin only'; end if;
  select * into v_request from public.pf_payment_requests
    where id = p_request_id for update;
  if not found or v_request.status <> 'pending' then raise exception 'Request is no longer pending'; end if;
  update public.pf_payment_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      decided_at = now(), decided_by = (select auth.uid())
  where id = p_request_id;
  if p_approve then
    update public.pf_profiles set plan = 'premium',
      premium_expires_at = greatest(coalesce(premium_expires_at, now()), now()) + interval '30 days',
      updated_at = now() where id = v_request.user_id;
  end if;
  insert into public.pf_admin_audit(admin_id,target_user_id,action)
  values ((select auth.uid()),v_request.user_id,
    case when p_approve then 'approve_payment' else 'reject_payment' end);
end;
$$;

create or replace function public.pf_admin_set_access(p_user_id uuid, p_action text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.pf_is_admin() then raise exception 'Admin only'; end if;
  if p_action not in ('complimentary','revoke','suspend') then raise exception 'Invalid action'; end if;
  if p_user_id = (select auth.uid()) then raise exception 'Cannot change own admin access'; end if;
  if not exists (select 1 from public.pf_profiles where id=p_user_id and role='user') then
    raise exception 'Target user not found';
  end if;
  update public.pf_profiles
    set plan = case when p_action='revoke' then 'trial'
                    when p_action='suspend' then 'suspended'
                    else p_action end,
        premium_expires_at = null,
        updated_at = now()
    where id = p_user_id;
  insert into public.pf_admin_audit(admin_id,target_user_id,action)
  values ((select auth.uid()),p_user_id,p_action);
end;
$$;

-- Least-privilege function execution. Database owner runs the bootstrapping SQL.
revoke all on function public.pf_create_profile() from public, anon, authenticated;
revoke all on function public.pf_is_admin() from public, anon;
revoke all on function public.pf_consume_export(text) from public, anon;
revoke all on function public.pf_admin_decide_payment(uuid,boolean) from public, anon;
revoke all on function public.pf_admin_set_access(uuid,text) from public, anon;
grant execute on function public.pf_is_admin() to authenticated;
grant execute on function public.pf_consume_export(text) to authenticated;
grant execute on function public.pf_admin_decide_payment(uuid,boolean) to authenticated;
grant execute on function public.pf_admin_set_access(uuid,text) to authenticated;

-- IMPORTANT: after junhaochong5@gmail.com signs in with Google ONCE,
-- run the following manually in Supabase SQL Editor to establish admin:
-- update public.pf_profiles set role='admin', plan='complimentary'
-- where lower(email) = 'junhaochong5@gmail.com';
