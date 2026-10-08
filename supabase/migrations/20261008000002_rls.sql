-- =============================================================================
-- Row Level Security + privileges
--
-- Model:
--   * anon: no table access at all.
--   * authenticated ADMIN: full read; writes are done server-side through
--     the service role or SECURITY DEFINER RPCs after an admin check.
--   * authenticated EVALUATOR: may read only rows linked to their own live
--     assignments, and only non-sensitive student columns. Evaluators can
--     never write evaluations directly — only via submit/save RPCs which
--     derive evaluator identity from auth.uid().
-- =============================================================================

alter table public.profiles               enable row level security;
alter table public.app_settings           enable row level security;
alter table public.students               enable row level security;
alter table public.ideas                  enable row level security;
alter table public.evaluators             enable row level security;
alter table public.allocation_batches     enable row level security;
alter table public.evaluation_assignments enable row level security;
alter table public.evaluations            enable row level security;
alter table public.audit_logs             enable row level security;
alter table public.sheet_sync_queue       enable row level security;
alter table public.sync_locks             enable row level security;
alter table public.form_sync_runs         enable row level security;

-- Start from zero for client roles; grant back explicitly.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Identity helpers are needed inside policies evaluated for authenticated users.
grant execute on function public.app_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.current_evaluator_id() to authenticated;
grant execute on function public.is_assigned_student(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
grant select on public.profiles to authenticated;

create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- app_settings: everyone signed in can read (event status banner)
-- ---------------------------------------------------------------------------
grant select on public.app_settings to authenticated;

create policy app_settings_select_all on public.app_settings
  for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- students: column-level grant hides email/phone from every client role.
-- Admin pages read contact details server-side with the service role.
-- ---------------------------------------------------------------------------
grant select (id, register_number, name, department, year, section, status, created_at, updated_at)
  on public.students to authenticated;

create policy students_select_admin on public.students
  for select to authenticated
  using (public.is_admin());

create policy students_select_assigned on public.students
  for select to authenticated
  using (public.is_assigned_student(id));

-- ---------------------------------------------------------------------------
-- ideas
-- ---------------------------------------------------------------------------
grant select on public.ideas to authenticated;

create policy ideas_select_admin on public.ideas
  for select to authenticated
  using (public.is_admin());

create policy ideas_select_assigned on public.ideas
  for select to authenticated
  using (public.is_assigned_student(student_id));

-- ---------------------------------------------------------------------------
-- evaluators: an evaluator sees only their own row
-- ---------------------------------------------------------------------------
grant select on public.evaluators to authenticated;

create policy evaluators_select_admin on public.evaluators
  for select to authenticated
  using (public.is_admin());

create policy evaluators_select_self on public.evaluators
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- evaluation_assignments
-- ---------------------------------------------------------------------------
grant select on public.evaluation_assignments to authenticated;

create policy assignments_select_admin on public.evaluation_assignments
  for select to authenticated
  using (public.is_admin());

create policy assignments_select_own on public.evaluation_assignments
  for select to authenticated
  using (evaluator_id = public.current_evaluator_id() and status <> 'REPLACED');

-- ---------------------------------------------------------------------------
-- evaluations: read-only for clients; writes only through RPCs
-- ---------------------------------------------------------------------------
grant select on public.evaluations to authenticated;

create policy evaluations_select_admin on public.evaluations
  for select to authenticated
  using (public.is_admin());

create policy evaluations_select_own on public.evaluations
  for select to authenticated
  using (evaluator_id = public.current_evaluator_id());

-- ---------------------------------------------------------------------------
-- Admin-only operational tables
-- ---------------------------------------------------------------------------
grant select on public.allocation_batches to authenticated;
create policy allocation_batches_select_admin on public.allocation_batches
  for select to authenticated using (public.is_admin());

grant select on public.audit_logs to authenticated;
create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated using (public.is_admin());

grant select on public.sheet_sync_queue to authenticated;
create policy sheet_sync_queue_select_admin on public.sheet_sync_queue
  for select to authenticated using (public.is_admin());

grant select on public.form_sync_runs to authenticated;
create policy form_sync_runs_select_admin on public.form_sync_runs
  for select to authenticated using (public.is_admin());

-- sync_locks: no client access (service role only).
