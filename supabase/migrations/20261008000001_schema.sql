-- =============================================================================
-- Idea to Expo — core schema
--
-- Supabase is the source of truth. Every integrity-critical write (evaluation
-- submission, allocation, form ingestion) goes through a SECURITY DEFINER
-- function that runs in a single transaction and derives the acting user from
-- auth.uid() — never from client-supplied ids.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, carries the application role
-- ---------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        text not null check (role in ('ADMIN', 'EVALUATOR')),
  full_name   text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- app_settings: singleton row with event + allocation configuration
-- ---------------------------------------------------------------------------

create table public.app_settings (
  id                      boolean primary key default true check (id),
  event_status            text not null default 'NOT_STARTED'
                            check (event_status in ('NOT_STARTED', 'LIVE', 'PAUSED', 'CLOSED')),
  max_per_evaluator       integer not null default 50 check (max_per_evaluator between 1 and 1000),
  evaluators_per_student  integer not null default 1 check (evaluators_per_student between 1 and 5),
  -- When true, evaluators may re-submit (update) a completed evaluation while LIVE.
  allow_resubmission      boolean not null default false,
  -- Ordered tie-break rule ids, interpreted by lib/results/ranking.ts.
  tie_breakers            text[] not null default array['MIN_SCORE_DESC', 'EVALUATION_COUNT_DESC'],
  -- Google Form header -> portal field mapping, interpreted by lib/forms/mapping.ts.
  form_field_mapping      jsonb not null default '{}'::jsonb,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null
);

insert into public.app_settings (id) values (true);

create trigger app_settings_updated_at before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- students + ideas
-- ---------------------------------------------------------------------------

create table public.students (
  id                 uuid primary key default gen_random_uuid(),
  -- Normalised (trimmed, upper-case, no whitespace) unique student identifier.
  register_number    text not null unique
                       check (register_number <> '' and register_number = upper(regexp_replace(register_number, '\s', '', 'g'))),
  name               text not null,
  department         text,
  year               integer check (year between 1 and 6),
  section            text,
  email              text,
  phone              text,
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'WITHDRAWN', 'DISQUALIFIED')),
  source             text not null default 'FORM' check (source in ('FORM', 'IMPORT', 'MANUAL', 'SEED')),
  form_submitted_at  timestamptz,
  -- Optional admin-defined tie-break (lower wins), used by the ADMIN_PRIORITY_ASC rule.
  tie_break_priority integer,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index students_department_idx on public.students (department);
create index students_status_idx on public.students (status);
create index students_lower_name_idx on public.students (lower(name));

create trigger students_updated_at before update on public.students
  for each row execute function public.set_updated_at();

-- One submission per student today. The FK lives on ideas (not students), so
-- moving to team/multi-project submissions later only means dropping the
-- unique constraint and adding a team table — no change to students.
create table public.ideas (
  id                 uuid primary key default gen_random_uuid(),
  student_id         uuid not null unique references public.students (id) on delete cascade,
  title              text,
  problem_statement  text,
  idea_description   text,
  team_details       text,
  ppt_url            text,
  other_details      jsonb not null default '{}'::jsonb,
  submission_status  text not null default 'SUBMITTED' check (submission_status in ('SUBMITTED', 'INCOMPLETE')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger ideas_updated_at before update on public.ideas
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- evaluators
-- ---------------------------------------------------------------------------

create table public.evaluators (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid unique references auth.users (id) on delete set null,
  name             text not null,
  email            text not null unique check (email = lower(email)),
  employee_id      text unique,
  department       text,
  status           text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  -- Individual cap; effective cap = least(max_assignments, app_settings.max_per_evaluator).
  max_assignments  integer not null default 50 check (max_assignments between 1 and 1000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index evaluators_status_idx on public.evaluators (status);

create trigger evaluators_updated_at before update on public.evaluators
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- allocation history + assignments
-- ---------------------------------------------------------------------------

create table public.allocation_batches (
  id                      uuid primary key default gen_random_uuid(),
  created_by              uuid references auth.users (id) on delete set null,
  allocation_type         text not null check (allocation_type in ('INITIAL', 'INCREMENTAL', 'FULL_REALLOCATION')),
  student_count           integer not null,
  evaluator_count         integer not null,
  assignment_count        integer not null,
  replaced_count          integer not null default 0,
  max_per_evaluator       integer not null,
  evaluators_per_student  integer not null,
  seed                    text,
  status                  text not null default 'CONFIRMED' check (status in ('DRAFT', 'CONFIRMED', 'REPLACED', 'CANCELLED')),
  created_at              timestamptz not null default now(),
  replaced_at             timestamptz
);

create table public.evaluation_assignments (
  id                   uuid primary key default gen_random_uuid(),
  student_id           uuid not null references public.students (id) on delete cascade,
  evaluator_id         uuid not null references public.evaluators (id) on delete restrict,
  allocation_batch_id  uuid references public.allocation_batches (id) on delete set null,
  status               text not null default 'PENDING'
                         check (status in ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REPLACED')),
  assigned_at          timestamptz not null default now(),
  completed_at         timestamptz,
  replaced_at          timestamptz,
  updated_at           timestamptz not null default now()
);

-- A student can be assigned to a given evaluator at most once among live
-- assignments. Replaced rows are kept for history, hence the partial index.
create unique index evaluation_assignments_active_pair_uidx
  on public.evaluation_assignments (student_id, evaluator_id)
  where status <> 'REPLACED';
create index evaluation_assignments_student_idx on public.evaluation_assignments (student_id);
create index evaluation_assignments_evaluator_idx on public.evaluation_assignments (evaluator_id, status);
create index evaluation_assignments_status_idx on public.evaluation_assignments (status);
create index evaluation_assignments_batch_idx on public.evaluation_assignments (allocation_batch_id);

create trigger evaluation_assignments_updated_at before update on public.evaluation_assignments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- evaluations
-- ---------------------------------------------------------------------------

create table public.evaluations (
  id             uuid primary key default gen_random_uuid(),
  assignment_id  uuid not null unique references public.evaluation_assignments (id) on delete cascade,
  student_id     uuid not null references public.students (id) on delete cascade,
  evaluator_id   uuid not null references public.evaluators (id) on delete restrict,
  score          integer check (score between 1 and 10),
  remarks        text check (char_length(remarks) <= 5000),
  status         text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS', 'COMPLETED')),
  version        integer not null default 1,
  started_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint evaluations_completed_requires_score
    check (status <> 'COMPLETED' or (score is not null and submitted_at is not null))
);

create index evaluations_student_idx on public.evaluations (student_id);
create index evaluations_evaluator_idx on public.evaluations (evaluator_id);
create index evaluations_status_idx on public.evaluations (status);

create trigger evaluations_updated_at before update on public.evaluations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- audit log, sync queue, locks, form sync runs
-- ---------------------------------------------------------------------------

create table public.audit_logs (
  id           bigint generated always as identity primary key,
  user_id      uuid references auth.users (id) on delete set null,
  action       text not null,
  entity_type  text,
  entity_id    text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);

create table public.sheet_sync_queue (
  id             uuid primary key default gen_random_uuid(),
  entity_type    text not null check (entity_type in ('STUDENT', 'EVALUATOR', 'ASSIGNMENT', 'EVALUATION', 'RESULTS')),
  entity_id      uuid not null,
  operation      text not null default 'UPSERT' check (operation in ('UPSERT')),
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'PENDING'
                   check (status in ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'SUPERSEDED')),
  attempts       integer not null default 0,
  last_error     text,
  next_retry_at  timestamptz not null default now(),
  locked_at      timestamptz,
  created_at     timestamptz not null default now(),
  processed_at   timestamptz
);

-- Coalescing: at most one PENDING job per entity. A job that is already
-- PROCESSING does not block a new PENDING one, so a change made while the
-- worker is mid-flight is never lost.
create unique index sheet_sync_queue_pending_uidx
  on public.sheet_sync_queue (entity_type, entity_id)
  where status = 'PENDING';
create index sheet_sync_queue_claim_idx on public.sheet_sync_queue (status, next_retry_at);
create index sheet_sync_queue_created_idx on public.sheet_sync_queue (created_at desc);

create table public.sync_locks (
  name         text primary key,
  holder       text,
  lease_until  timestamptz not null default '-infinity'
);

create table public.form_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('APPS_SCRIPT', 'SHEETS_PULL', 'CSV_IMPORT')),
  status        text not null check (status in ('SUCCESS', 'PARTIAL', 'FAILED')),
  received      integer not null default 0,
  inserted      integer not null default 0,
  updated       integer not null default 0,
  unchanged     integer not null default 0,
  skipped       integer not null default 0,
  errors        jsonb not null default '[]'::jsonb,
  triggered_by  uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index form_sync_runs_created_idx on public.form_sync_runs (created_at desc);

-- ---------------------------------------------------------------------------
-- Identity helpers used by RLS and RPCs
-- ---------------------------------------------------------------------------

create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.role = 'ADMIN' from public.profiles p where p.id = auth.uid()), false);
$$;

-- Only ACTIVE evaluators resolve; disabling an evaluator immediately cuts off
-- all of their data access through RLS.
create or replace function public.current_evaluator_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.evaluators e
  join public.profiles p on p.id = e.user_id and p.role = 'EVALUATOR'
  where e.user_id = auth.uid() and e.status = 'ACTIVE';
$$;

create or replace function public.is_assigned_student(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.evaluation_assignments a
    where a.student_id = p_student_id
      and a.evaluator_id = public.current_evaluator_id()
      and a.status <> 'REPLACED'
  );
$$;
