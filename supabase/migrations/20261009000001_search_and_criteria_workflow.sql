-- =============================================================================
-- Workflow v2: search-and-claim evaluation with admin-defined criteria.
--
--   * Allocation is removed. Evaluators search any student and claim them on
--     their first save. One evaluator per student (unique + row lock); each
--     evaluator may hold at most N evaluations (default 50).
--   * Scores are per admin-defined criterion (max marks + input style);
--     total = sum. Evaluators tag one or more admin-defined domains.
--   * Students are imported from CSV (master data, incl. gender). Problem
--     statement form responses are matched by register number, then email.
--   * Scores are written back into the problem statement response sheet.
--
-- Any rows from the v1 allocation workflow are archived to legacy_* tables
-- before the old structures are dropped.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Archive v1 data (only if present)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.evaluations) then
    create table public.legacy_v1_evaluations as select * from public.evaluations;
  end if;
  if exists (select 1 from public.evaluation_assignments) then
    create table public.legacy_v1_assignments as select * from public.evaluation_assignments;
  end if;
  if exists (select 1 from public.allocation_batches) then
    create table public.legacy_v1_allocation_batches as select * from public.allocation_batches;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Drop v1 objects that depend on allocation
-- ---------------------------------------------------------------------------
drop view if exists public.my_assignments;
drop view if exists public.evaluator_progress;
drop view if exists public.student_results;
drop view if exists public.student_overview;
drop view if exists public.evaluation_overview;

drop policy if exists students_select_assigned on public.students;
drop policy if exists ideas_select_assigned on public.ideas;

drop function if exists public.confirm_allocation(text, text, integer, integer, jsonb);
drop function if exists public.save_evaluation_draft(uuid, integer, text);
drop function if exists public.submit_evaluation(uuid, integer, text);
drop function if exists public.admin_reopen_evaluation(uuid, text);
drop function if exists public.upsert_form_submissions(jsonb, text, uuid);
drop function if exists public.dashboard_stats();
drop function if exists public.enqueue_full_resync();
drop function if exists public.is_assigned_student(uuid);

drop trigger if exists evaluation_assignments_sheet_sync on public.evaluation_assignments;
drop function if exists public.trg_sync_assignment();

delete from public.evaluations;
alter table public.evaluations drop constraint if exists evaluations_completed_requires_score;
alter table public.evaluations drop column assignment_id cascade;
alter table public.evaluations drop column score;

drop table public.evaluation_assignments cascade;
drop table public.allocation_batches cascade;

-- ---------------------------------------------------------------------------
-- 2. Students / ideas / evaluators / settings
-- ---------------------------------------------------------------------------
alter table public.students add column gender text check (char_length(gender) <= 30);
create unique index students_email_uidx on public.students (lower(email)) where email is not null;
create index students_register_prefix_idx on public.students (register_number text_pattern_ops);

alter table public.ideas rename column idea_description to abstract;
alter table public.ideas drop column title;
alter table public.ideas drop column problem_statement;
alter table public.ideas drop column team_details;
alter table public.ideas add column submitted_at timestamptz;
alter table public.ideas add column response_row integer;
-- How the form response was linked to the student record.
alter table public.ideas add column matched_by text not null default 'REGISTER_NUMBER'
  check (matched_by in ('REGISTER_NUMBER', 'EMAIL', 'CREATED'));

alter table public.evaluators rename column max_assignments to max_evaluations;

alter table public.app_settings drop column max_per_evaluator;
alter table public.app_settings drop column evaluators_per_student;
alter table public.app_settings add column max_evaluations_per_evaluator integer not null default 50
  check (max_evaluations_per_evaluator between 1 and 1000);
-- {"total_header": "...", "evaluator_header": "...", "domains_header": "..."}
alter table public.app_settings add column sheet_writeback jsonb not null default '{}'::jsonb;
alter table public.app_settings alter column tie_breakers set default '{}';
update public.app_settings set tie_breakers = '{}', form_field_mapping = '{}'::jsonb where id;

-- ---------------------------------------------------------------------------
-- 3. Criteria, domains, scores
-- ---------------------------------------------------------------------------
create table public.evaluation_criteria (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(btrim(name)) between 1 and 120),
  description  text check (char_length(description) <= 1000),
  max_marks    integer not null check (max_marks between 1 and 100),
  input_style  text not null default 'SLIDER' check (input_style in ('STARS', 'SLIDER', 'NUMBER')),
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  -- Header of the score column in the problem statement sheet (defaults to name).
  sheet_column text check (char_length(sheet_column) <= 200),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint evaluation_criteria_stars_max check (input_style <> 'STARS' or max_marks <= 10)
);
create unique index evaluation_criteria_name_uidx on public.evaluation_criteria (lower(btrim(name)));
create trigger evaluation_criteria_updated_at before update on public.evaluation_criteria
  for each row execute function public.set_updated_at();

create table public.domains (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index domains_name_uidx on public.domains (lower(btrim(name)));
create trigger domains_updated_at before update on public.domains
  for each row execute function public.set_updated_at();

alter table public.evaluations add column total_score integer;
alter table public.evaluations add column max_total integer;
alter table public.evaluations add constraint evaluations_completed_requires_total
  check (status <> 'COMPLETED' or (total_score is not null and max_total is not null and submitted_at is not null));
-- One evaluator per student.
alter table public.evaluations add constraint evaluations_student_unique unique (student_id);

create table public.evaluation_scores (
  evaluation_id  uuid not null references public.evaluations (id) on delete cascade,
  criterion_id   uuid not null references public.evaluation_criteria (id) on delete restrict,
  score          integer not null check (score >= 0),
  primary key (evaluation_id, criterion_id)
);
create index evaluation_scores_criterion_idx on public.evaluation_scores (criterion_id);

create table public.evaluation_domains (
  evaluation_id  uuid not null references public.evaluations (id) on delete cascade,
  domain_id      uuid not null references public.domains (id) on delete restrict,
  primary key (evaluation_id, domain_id)
);
create index evaluation_domains_domain_idx on public.evaluation_domains (domain_id);

-- ---------------------------------------------------------------------------
-- 4. Sync queue entity types
-- ---------------------------------------------------------------------------
delete from public.sheet_sync_queue where entity_type = 'ASSIGNMENT';
alter table public.sheet_sync_queue drop constraint sheet_sync_queue_entity_type_check;
alter table public.sheet_sync_queue add constraint sheet_sync_queue_entity_type_check
  check (entity_type in ('STUDENT', 'EVALUATOR', 'EVALUATION', 'RESULTS', 'RESPONSE_ROW'));

-- ---------------------------------------------------------------------------
-- 5. Identity helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_my_student(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.evaluations e
    where e.student_id = p_student_id and e.evaluator_id = public.current_evaluator_id()
  );
$$;

create or replace function public.evaluation_cap(p_evaluator_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select least(e.max_evaluations, s.max_evaluations_per_evaluator)
  from public.evaluators e cross join public.app_settings s
  where e.id = p_evaluator_id and s.id;
$$;

-- ---------------------------------------------------------------------------
-- 6. RLS for new / changed tables
-- ---------------------------------------------------------------------------
alter table public.evaluation_criteria enable row level security;
alter table public.domains enable row level security;
alter table public.evaluation_scores enable row level security;
alter table public.evaluation_domains enable row level security;

grant select on public.evaluation_criteria, public.domains, public.evaluation_scores, public.evaluation_domains
  to authenticated;
grant all on public.evaluation_criteria, public.domains, public.evaluation_scores, public.evaluation_domains
  to service_role;

create policy criteria_select on public.evaluation_criteria for select to authenticated
  using (is_active or public.is_admin());
create policy domains_select on public.domains for select to authenticated
  using (is_active or public.is_admin());

create policy evaluation_scores_select on public.evaluation_scores for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.evaluations e
    where e.id = evaluation_id and e.evaluator_id = public.current_evaluator_id()));
create policy evaluation_domains_select on public.evaluation_domains for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.evaluations e
    where e.id = evaluation_id and e.evaluator_id = public.current_evaluator_id()));

-- Evaluators read full rows only for students they have claimed. Finding
-- other students goes through search_students / get_student_for_evaluation.
create policy students_select_mine on public.students for select to authenticated
  using (public.is_my_student(id));
create policy ideas_select_mine on public.ideas for select to authenticated
  using (public.is_my_student(student_id));

-- ---------------------------------------------------------------------------
-- 7. Sync triggers (replace v1 versions)
-- ---------------------------------------------------------------------------
create or replace function public.trg_sync_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_sheet_sync('STUDENT', new.id);
  if tg_op = 'UPDATE' and (old.name, old.register_number, old.department, old.email)
       is distinct from (new.name, new.register_number, new.department, new.email) then
    perform public.enqueue_sheet_sync('EVALUATION', e.id)
      from public.evaluations e where e.student_id = new.id;
    if exists (select 1 from public.evaluations e where e.student_id = new.id and e.status = 'COMPLETED') then
      perform public.enqueue_sheet_sync('RESPONSE_ROW', new.id);
    end if;
  end if;
  perform public.enqueue_sheet_sync('RESULTS', public.results_sync_key());
  return null;
end;
$$;

create or replace function public.trg_sync_idea()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_sheet_sync('STUDENT', new.student_id);
  -- A newer response row may have appeared: re-write scores onto it.
  if exists (select 1 from public.evaluations e where e.student_id = new.student_id and e.status = 'COMPLETED') then
    perform public.enqueue_sheet_sync('RESPONSE_ROW', new.student_id);
  end if;
  return null;
end;
$$;

create or replace function public.trg_sync_evaluator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_sheet_sync('EVALUATOR', new.id);
  if tg_op = 'UPDATE' and (old.name, old.employee_id) is distinct from (new.name, new.employee_id) then
    perform public.enqueue_sheet_sync('EVALUATION', e.id)
      from public.evaluations e where e.evaluator_id = new.id and e.status = 'COMPLETED';
    perform public.enqueue_sheet_sync('RESPONSE_ROW', e.student_id)
      from public.evaluations e where e.evaluator_id = new.id and e.status = 'COMPLETED';
  end if;
  return null;
end;
$$;

create or replace function public.trg_sync_evaluation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.enqueue_sheet_sync('EVALUATOR', old.evaluator_id);
    if old.status = 'COMPLETED' then
      perform public.enqueue_sheet_sync('EVALUATION', old.id);
      perform public.enqueue_sheet_sync('RESPONSE_ROW', old.student_id);
      perform public.enqueue_sheet_sync('RESULTS', public.results_sync_key());
    end if;
    perform public.enqueue_sheet_sync('STUDENT', old.student_id);
    return null;
  end if;

  perform public.enqueue_sheet_sync('EVALUATOR', new.evaluator_id);
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    perform public.enqueue_sheet_sync('STUDENT', new.student_id);
  end if;
  -- Drafts stay private; only completed (or reopened) evaluations are reported.
  if new.status = 'COMPLETED' or (tg_op = 'UPDATE' and old.status = 'COMPLETED') then
    perform public.enqueue_sheet_sync('EVALUATION', new.id);
    perform public.enqueue_sheet_sync('RESPONSE_ROW', new.student_id);
    perform public.enqueue_sheet_sync('RESULTS', public.results_sync_key());
  end if;
  return null;
end;
$$;

drop trigger if exists evaluations_sheet_sync on public.evaluations;
create trigger evaluations_sheet_sync after insert or update or delete on public.evaluations
  for each row execute function public.trg_sync_evaluation();

-- ---------------------------------------------------------------------------
-- 8. Evaluation input validation + claiming (internal)
-- ---------------------------------------------------------------------------

-- Validates {"<criterion uuid>": <integer>} against active criteria.
create or replace function public.validated_scores(p_scores jsonb, p_require_all boolean)
returns table (criterion_id uuid, score integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  k text;
  v jsonb;
  c public.evaluation_criteria;
  n numeric;
begin
  p_scores := coalesce(p_scores, '{}'::jsonb);
  if jsonb_typeof(p_scores) <> 'object' then
    raise exception 'INVALID_SCORE' using errcode = '22023';
  end if;

  for k, v in select key, value from jsonb_each(p_scores) loop
    if v = 'null'::jsonb then continue; end if;
    if k !~ '^[0-9a-fA-F-]{36}$' then
      raise exception 'UNKNOWN_CRITERION' using errcode = '22023';
    end if;
    select * into c from public.evaluation_criteria ec where ec.id = k::uuid and ec.is_active;
    if not found then
      raise exception 'UNKNOWN_CRITERION' using errcode = '22023';
    end if;
    if jsonb_typeof(v) <> 'number' then
      raise exception 'INVALID_SCORE' using errcode = '22023';
    end if;
    n := (v #>> '{}')::numeric;
    if n <> trunc(n) then
      raise exception 'INVALID_SCORE' using errcode = '22023';
    end if;
    if n < 0 or n > c.max_marks then
      raise exception 'SCORE_OUT_OF_RANGE' using errcode = '22023', detail = c.name;
    end if;
    criterion_id := c.id;
    score := n::integer;
    return next;
  end loop;

  if p_require_all then
    if not exists (select 1 from public.evaluation_criteria ec where ec.is_active) then
      raise exception 'NO_CRITERIA' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.evaluation_criteria ec
      where ec.is_active
        and (not (p_scores ? ec.id::text) or p_scores -> ec.id::text = 'null'::jsonb)
    ) then
      raise exception 'INCOMPLETE_SCORES' using errcode = '22023';
    end if;
  end if;
end;
$$;

create or replace function public.validated_domains(p_domain_ids uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := coalesce((select array_agg(distinct d) from unnest(coalesce(p_domain_ids, '{}')) d), '{}');
begin
  if exists (
    select 1 from unnest(v_ids) d
    where not exists (select 1 from public.domains x where x.id = d and x.is_active)
  ) then
    raise exception 'UNKNOWN_DOMAIN' using errcode = '22023';
  end if;
  return v_ids;
end;
$$;

-- Returns the caller's evaluation for the student, creating (claiming) it if
-- the student is free. Locks the student row (one claim at a time per
-- student) and the evaluator row (serialises the per-evaluator cap check).
create or replace function public.claim_evaluation(p_student_id uuid)
returns public.evaluations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evaluator uuid := public.current_evaluator_id();
  v_eval      public.evaluations;
  v_cap       integer;
  v_count     integer;
begin
  if v_evaluator is null then
    raise exception 'NOT_AN_EVALUATOR' using errcode = '42501';
  end if;

  perform 1 from public.students s where s.id = p_student_id and s.status = 'ACTIVE' for update;
  if not found then
    raise exception 'STUDENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_eval from public.evaluations e where e.student_id = p_student_id;
  if found then
    if v_eval.evaluator_id <> v_evaluator then
      raise exception 'STUDENT_TAKEN' using errcode = 'P0001';
    end if;
    return v_eval;
  end if;

  perform 1 from public.evaluators e where e.id = v_evaluator for update;
  v_cap := public.evaluation_cap(v_evaluator);
  select count(*) into v_count from public.evaluations e where e.evaluator_id = v_evaluator;
  if v_count >= v_cap then
    raise exception 'EVALUATOR_LIMIT_REACHED' using errcode = 'P0001', detail = v_cap::text;
  end if;

  insert into public.evaluations (student_id, evaluator_id, status)
  values (p_student_id, v_evaluator, 'IN_PROGRESS')
  returning * into v_eval;
  return v_eval;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Evaluator RPCs
-- ---------------------------------------------------------------------------
create or replace function public.search_students(p_query text, p_limit integer default 20)
returns table (
  student_id uuid,
  register_number text,
  name text,
  department text,
  section text,
  email text,
  submission_status text,
  claim_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_evaluator uuid := public.current_evaluator_id();
  q    text := btrim(coalesce(p_query, ''));
  reg  text;
  esc  text;
begin
  if v_evaluator is null and not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if char_length(q) < 2 then
    return;
  end if;
  esc := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  reg := upper(regexp_replace(esc, '\s', '', 'g'));

  return query
  select s.id, s.register_number, s.name, s.department, s.section, s.email,
         coalesce(i.submission_status, 'MISSING'),
         case
           when ev.id is null then 'AVAILABLE'
           when ev.evaluator_id = v_evaluator and ev.status = 'COMPLETED' then 'MINE_COMPLETED'
           when ev.evaluator_id = v_evaluator then 'MINE_IN_PROGRESS'
           else 'TAKEN'
         end
  from public.students s
  left join public.ideas i on i.student_id = s.id
  left join public.evaluations ev on ev.student_id = s.id
  where s.status = 'ACTIVE'
    and (s.register_number like reg || '%'
         or s.name ilike '%' || esc || '%'
         or lower(s.email) like lower(esc) || '%')
  order by (s.register_number = upper(regexp_replace(q, '\s', '', 'g'))) desc, s.register_number
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

create or replace function public.get_student_for_evaluation(p_student_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_evaluator uuid := public.current_evaluator_id();
  v_student   public.students;
  v_idea      public.ideas;
  v_eval      public.evaluations;
  v_claim     text;
begin
  if v_evaluator is null and not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_student from public.students where id = p_student_id and status = 'ACTIVE';
  if not found then
    return null;
  end if;
  select * into v_idea from public.ideas where student_id = p_student_id;
  select * into v_eval from public.evaluations where student_id = p_student_id;

  v_claim := case
    when v_eval.id is null then 'AVAILABLE'
    when v_eval.evaluator_id = v_evaluator and v_eval.status = 'COMPLETED' then 'MINE_COMPLETED'
    when v_eval.evaluator_id = v_evaluator then 'MINE_IN_PROGRESS'
    else 'TAKEN'
  end;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'id', v_student.id, 'register_number', v_student.register_number, 'name', v_student.name,
      'department', v_student.department, 'section', v_student.section, 'year', v_student.year,
      'email', v_student.email),
    'idea', case when v_idea.id is null then null else jsonb_build_object(
      'abstract', v_idea.abstract, 'ppt_url', v_idea.ppt_url, 'other_details', v_idea.other_details,
      'submission_status', v_idea.submission_status, 'submitted_at', v_idea.submitted_at) end,
    'claim_status', v_claim,
    'evaluation', case when v_claim in ('MINE_COMPLETED', 'MINE_IN_PROGRESS') then jsonb_build_object(
      'id', v_eval.id, 'status', v_eval.status, 'remarks', v_eval.remarks, 'version', v_eval.version,
      'updated_at', v_eval.updated_at, 'submitted_at', v_eval.submitted_at,
      'total_score', v_eval.total_score, 'max_total', v_eval.max_total,
      'scores', coalesce((select jsonb_object_agg(sc.criterion_id::text, sc.score)
                            from public.evaluation_scores sc where sc.evaluation_id = v_eval.id), '{}'::jsonb),
      'domain_ids', coalesce((select jsonb_agg(d.domain_id)
                                from public.evaluation_domains d where d.evaluation_id = v_eval.id), '[]'::jsonb)
    ) else null end
  );
end;
$$;

create or replace function public.save_evaluation_draft(
  p_student_id uuid,
  p_scores jsonb,
  p_remarks text,
  p_domain_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status  text;
  v_eval    public.evaluations;
  v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
  v_domains uuid[];
begin
  if public.current_evaluator_id() is null then
    raise exception 'NOT_AN_EVALUATOR' using errcode = '42501';
  end if;
  select s.event_status into v_status from public.app_settings s where s.id;
  if v_status not in ('LIVE', 'PAUSED') then
    raise exception 'EVENT_NOT_LIVE' using errcode = 'P0001', detail = v_status;
  end if;
  if v_remarks is not null and char_length(v_remarks) > 5000 then
    raise exception 'REMARKS_TOO_LONG' using errcode = '22023';
  end if;
  v_domains := public.validated_domains(p_domain_ids);

  v_eval := public.claim_evaluation(p_student_id);
  if v_eval.status = 'COMPLETED' then
    raise exception 'ALREADY_SUBMITTED' using errcode = 'P0001';
  end if;

  delete from public.evaluation_scores where evaluation_id = v_eval.id;
  insert into public.evaluation_scores (evaluation_id, criterion_id, score)
  select v_eval.id, vs.criterion_id, vs.score from public.validated_scores(p_scores, false) vs;

  delete from public.evaluation_domains where evaluation_id = v_eval.id;
  insert into public.evaluation_domains (evaluation_id, domain_id)
  select v_eval.id, d from unnest(v_domains) d;

  update public.evaluations e
     set remarks = v_remarks,
         version = e.version + 1,
         total_score = (select sum(sc.score) from public.evaluation_scores sc where sc.evaluation_id = e.id),
         max_total = (select sum(c.max_marks) from public.evaluation_criteria c where c.is_active)
   where e.id = v_eval.id
  returning * into v_eval;

  return jsonb_build_object('evaluation_id', v_eval.id, 'version', v_eval.version, 'saved_at', v_eval.updated_at);
end;
$$;

create or replace function public.submit_evaluation(
  p_student_id uuid,
  p_scores jsonb,
  p_remarks text,
  p_domain_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.app_settings;
  v_eval     public.evaluations;
  v_remarks  text := nullif(btrim(coalesce(p_remarks, '')), '');
  v_domains  uuid[];
  v_new      jsonb;
  v_old      jsonb;
  v_old_dom  uuid[];
  v_total    integer;
  v_max      integer;
  v_action   text := 'EVALUATION_SUBMITTED';
begin
  if public.current_evaluator_id() is null then
    raise exception 'NOT_AN_EVALUATOR' using errcode = '42501';
  end if;
  select * into v_settings from public.app_settings s where s.id;
  if v_settings.event_status <> 'LIVE' then
    raise exception 'EVENT_NOT_LIVE' using errcode = 'P0001', detail = v_settings.event_status;
  end if;
  if v_remarks is not null and char_length(v_remarks) > 5000 then
    raise exception 'REMARKS_TOO_LONG' using errcode = '22023';
  end if;
  v_domains := public.validated_domains(p_domain_ids);
  select coalesce(jsonb_object_agg(vs.criterion_id::text, vs.score), '{}'::jsonb), sum(vs.score)
    into v_new, v_total
    from public.validated_scores(p_scores, true) vs
    join public.evaluation_criteria c on c.id = vs.criterion_id and c.is_active;
  select sum(c.max_marks) into v_max from public.evaluation_criteria c where c.is_active;

  v_eval := public.claim_evaluation(p_student_id);

  if v_eval.status = 'COMPLETED' then
    select coalesce(jsonb_object_agg(sc.criterion_id::text, sc.score), '{}'::jsonb) into v_old
      from public.evaluation_scores sc where sc.evaluation_id = v_eval.id;
    select coalesce(array_agg(d.domain_id order by d.domain_id), '{}') into v_old_dom
      from public.evaluation_domains d where d.evaluation_id = v_eval.id;
    -- Identical payload again (double click / retry after timeout): succeed quietly.
    if v_old = v_new and v_eval.remarks is not distinct from v_remarks
       and v_old_dom = coalesce((select array_agg(x order by x) from unnest(v_domains) x), '{}') then
      return jsonb_build_object('evaluation_id', v_eval.id, 'submitted_at', v_eval.submitted_at,
                                'total_score', v_eval.total_score, 'max_total', v_eval.max_total, 'duplicate', true);
    end if;
    if not v_settings.allow_resubmission then
      raise exception 'ALREADY_SUBMITTED' using errcode = 'P0001';
    end if;
    v_action := 'EVALUATION_UPDATED';
  end if;

  delete from public.evaluation_scores where evaluation_id = v_eval.id;
  insert into public.evaluation_scores (evaluation_id, criterion_id, score)
  select v_eval.id, (k)::uuid, (v #>> '{}')::integer from jsonb_each(v_new) as t(k, v);

  delete from public.evaluation_domains where evaluation_id = v_eval.id;
  insert into public.evaluation_domains (evaluation_id, domain_id)
  select v_eval.id, d from unnest(v_domains) d;

  update public.evaluations e
     set remarks = v_remarks,
         status = 'COMPLETED',
         total_score = v_total,
         max_total = v_max,
         submitted_at = now(),
         version = e.version + 1
   where e.id = v_eval.id
  returning * into v_eval;

  perform public.write_audit(
    v_action, 'evaluation', v_eval.id::text,
    jsonb_build_object('student_id', p_student_id, 'evaluator_id', v_eval.evaluator_id,
                       'scores', v_new, 'total', v_total, 'max_total', v_max, 'domains', to_jsonb(v_domains))
  );

  return jsonb_build_object('evaluation_id', v_eval.id, 'submitted_at', v_eval.submitted_at,
                            'total_score', v_total, 'max_total', v_max, 'duplicate', false);
end;
$$;

-- Evaluator gives back a student they started but did not submit.
create or replace function public.release_my_evaluation(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evaluator uuid := public.current_evaluator_id();
  v_eval public.evaluations;
begin
  if v_evaluator is null then
    raise exception 'NOT_AN_EVALUATOR' using errcode = '42501';
  end if;
  select * into v_eval from public.evaluations
   where student_id = p_student_id and evaluator_id = v_evaluator for update;
  if not found then
    raise exception 'EVALUATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_eval.status = 'COMPLETED' then
    raise exception 'ALREADY_SUBMITTED' using errcode = 'P0001';
  end if;
  delete from public.evaluations where id = v_eval.id;
  perform public.write_audit('EVALUATION_RELEASED', 'evaluation', v_eval.id::text,
                             jsonb_build_object('student_id', p_student_id, 'by', 'evaluator'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Admin RPCs
-- ---------------------------------------------------------------------------
create or replace function public.admin_reopen_evaluation(p_evaluation_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eval public.evaluations;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  select * into v_eval from public.evaluations where id = p_evaluation_id for update;
  if not found then
    raise exception 'EVALUATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_eval.status <> 'COMPLETED' then
    raise exception 'EVALUATION_NOT_COMPLETED' using errcode = 'P0001';
  end if;
  update public.evaluations
     set status = 'IN_PROGRESS', submitted_at = null, version = version + 1
   where id = p_evaluation_id;
  perform public.write_audit('EVALUATION_REOPENED', 'evaluation', p_evaluation_id::text,
    jsonb_build_object('reason', p_reason, 'previous_total', v_eval.total_score, 'evaluator_id', v_eval.evaluator_id));
end;
$$;

-- Frees the student so another evaluator can take them. Scores are kept in the audit log.
create or replace function public.admin_release_evaluation(p_evaluation_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eval public.evaluations;
  v_scores jsonb;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  select * into v_eval from public.evaluations where id = p_evaluation_id for update;
  if not found then
    raise exception 'EVALUATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  select jsonb_object_agg(criterion_id::text, score) into v_scores
    from public.evaluation_scores where evaluation_id = p_evaluation_id;
  delete from public.evaluations where id = p_evaluation_id;
  perform public.write_audit('EVALUATION_RELEASED', 'evaluation', p_evaluation_id::text,
    jsonb_build_object('reason', p_reason, 'by', 'admin', 'student_id', v_eval.student_id,
                       'evaluator_id', v_eval.evaluator_id, 'status', v_eval.status,
                       'total', v_eval.total_score, 'scores', v_scores, 'remarks', v_eval.remarks));
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Student CSV import (service role). CSV is the master record.
-- ---------------------------------------------------------------------------
create or replace function public.import_students(p_rows jsonb, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r           jsonb;
  v_reg       text;
  v_email     text;
  v_existing  public.students;
  v_changed   integer;
  v_inserted  integer := 0;
  v_updated   integer := 0;
  v_unchanged integer := 0;
  v_skipped   integer := 0;
  v_errors    jsonb := '[]'::jsonb;
  v_run_id    uuid;
  v_status    text;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INVALID_PAYLOAD' using errcode = '22023';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    begin
      v_reg := upper(regexp_replace(coalesce(r->>'register_number', ''), '\s', '', 'g'));
      v_email := nullif(lower(btrim(r->>'email')), '');
      if v_reg = '' or coalesce(btrim(r->>'name'), '') = '' then
        v_skipped := v_skipped + 1;
        v_errors := v_errors || jsonb_build_object('row', r->>'_row', 'register_number', v_reg,
                                                   'error', 'Register number and name are required');
        continue;
      end if;
      if v_email is not null and exists (
        select 1 from public.students s where lower(s.email) = v_email and s.register_number <> v_reg) then
        v_skipped := v_skipped + 1;
        v_errors := v_errors || jsonb_build_object('row', r->>'_row', 'register_number', v_reg,
                                                   'error', format('Email %s already belongs to another student', v_email));
        continue;
      end if;

      select * into v_existing from public.students where register_number = v_reg for update;
      if not found then
        insert into public.students (register_number, name, gender, department, email, phone, source)
        values (v_reg, btrim(r->>'name'), nullif(btrim(r->>'gender'), ''), nullif(btrim(r->>'department'), ''),
                v_email, nullif(btrim(r->>'phone'), ''), 'IMPORT');
        v_inserted := v_inserted + 1;
      else
        update public.students s set
          name = btrim(r->>'name'),
          gender = coalesce(nullif(btrim(r->>'gender'), ''), s.gender),
          department = coalesce(nullif(btrim(r->>'department'), ''), s.department),
          email = coalesce(v_email, s.email),
          phone = coalesce(nullif(btrim(r->>'phone'), ''), s.phone)
        where s.id = v_existing.id
          and (s.name, s.gender, s.department, s.email, s.phone) is distinct from
              (btrim(r->>'name'), coalesce(nullif(btrim(r->>'gender'), ''), s.gender),
               coalesce(nullif(btrim(r->>'department'), ''), s.department), coalesce(v_email, s.email),
               coalesce(nullif(btrim(r->>'phone'), ''), s.phone));
        get diagnostics v_changed = row_count;
        if v_changed > 0 then v_updated := v_updated + 1; else v_unchanged := v_unchanged + 1; end if;
      end if;
    exception when others then
      v_skipped := v_skipped + 1;
      v_errors := v_errors || jsonb_build_object('row', r->>'_row', 'register_number', v_reg, 'error', sqlerrm);
    end;
  end loop;

  v_status := case when v_skipped = 0 then 'SUCCESS'
                   when v_skipped < jsonb_array_length(p_rows) then 'PARTIAL' else 'FAILED' end;
  insert into public.form_sync_runs (source, status, received, inserted, updated, unchanged, skipped, errors, triggered_by)
  values ('CSV_IMPORT', v_status, jsonb_array_length(p_rows), v_inserted, v_updated, v_unchanged, v_skipped, v_errors, p_actor)
  returning id into v_run_id;
  perform public.write_audit('STUDENT_IMPORT', 'form_sync_run', v_run_id::text,
    jsonb_build_object('received', jsonb_array_length(p_rows), 'inserted', v_inserted, 'updated', v_updated,
                       'skipped', v_skipped), p_actor);

  return jsonb_build_object('run_id', v_run_id, 'status', v_status, 'received', jsonb_array_length(p_rows),
    'inserted', v_inserted, 'updated', v_updated, 'unchanged', v_unchanged, 'skipped', v_skipped, 'errors', v_errors);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Problem statement (form) ingestion (service role)
--
-- Each response is linked by register number, then email. If neither
-- matches, the student is created (flagged matched_by = CREATED) so no
-- submission is lost. Student master fields from CSV are never overwritten;
-- the form only fills blanks. Older responses never replace newer ones.
-- ---------------------------------------------------------------------------
create or replace function public.upsert_form_submissions(
  p_rows jsonb,
  p_source text,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r             jsonb;
  v_reg         text;
  v_email       text;
  v_submitted   timestamptz;
  v_student     public.students;
  v_idea        public.ideas;
  v_matched     text;
  v_other       jsonb;
  v_changed     integer;
  v_inserted    integer := 0;
  v_updated     integer := 0;
  v_unchanged   integer := 0;
  v_skipped     integer := 0;
  v_errors      jsonb := '[]'::jsonb;
  v_run_id      uuid;
  v_status      text;
begin
  if p_source not in ('APPS_SCRIPT', 'SHEETS_PULL') then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INVALID_PAYLOAD' using errcode = '22023';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    begin
      v_reg := upper(regexp_replace(coalesce(r->>'register_number', ''), '\s', '', 'g'));
      v_email := nullif(lower(btrim(r->>'email')), '');
      v_submitted := nullif(r->>'submitted_at', '')::timestamptz;
      v_other := coalesce(r->'other_details', '{}'::jsonb);

      if v_reg = '' and v_email is null then
        v_skipped := v_skipped + 1;
        v_errors := v_errors || jsonb_build_object('row', r->>'_row', 'error', 'Missing register number and email');
        continue;
      end if;

      v_matched := null;
      if v_reg <> '' then
        select * into v_student from public.students where register_number = v_reg for update;
        if found then v_matched := 'REGISTER_NUMBER'; end if;
      end if;
      if v_matched is null and v_email is not null then
        select * into v_student from public.students where lower(email) = v_email for update;
        if found then
          v_matched := 'EMAIL';
          if v_reg <> '' and v_reg <> v_student.register_number then
            v_other := v_other || jsonb_build_object('Register number on form', v_reg);
          end if;
        end if;
      end if;

      if v_matched is null then
        if v_reg = '' or coalesce(btrim(r->>'name'), '') = '' then
          v_skipped := v_skipped + 1;
          v_errors := v_errors || jsonb_build_object('row', r->>'_row', 'register_number', v_reg, 'email', v_email,
            'error', 'No matching student by register number or email, and the response lacks a register number or name');
          continue;
        end if;
        insert into public.students (register_number, name, department, section, email, phone, source, form_submitted_at)
        values (v_reg, btrim(r->>'name'), nullif(btrim(r->>'department'), ''), nullif(btrim(r->>'section'), ''),
                case when v_email is not null and not exists (select 1 from public.students s where lower(s.email) = v_email)
                     then v_email end,
                nullif(btrim(r->>'phone'), ''), 'FORM', v_submitted)
        returning * into v_student;
        v_matched := 'CREATED';
      else
        -- Fill blanks only; imported master data wins.
        update public.students s set
          department = coalesce(s.department, nullif(btrim(r->>'department'), '')),
          section = coalesce(s.section, nullif(btrim(r->>'section'), '')),
          phone = coalesce(s.phone, nullif(btrim(r->>'phone'), '')),
          email = coalesce(s.email, case when v_email is not null and not exists (
                    select 1 from public.students x where lower(x.email) = v_email) then v_email end),
          form_submitted_at = greatest(s.form_submitted_at, v_submitted)
        where s.id = v_student.id
          and (s.department is null and nullif(btrim(r->>'department'), '') is not null
               or s.section is null and nullif(btrim(r->>'section'), '') is not null
               or s.phone is null and nullif(btrim(r->>'phone'), '') is not null
               or s.email is null and v_email is not null
               or s.form_submitted_at is distinct from greatest(s.form_submitted_at, v_submitted));
      end if;

      select * into v_idea from public.ideas where student_id = v_student.id;
      if found and v_idea.submitted_at is not null and v_submitted is not null and v_submitted < v_idea.submitted_at then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;

      insert into public.ideas (student_id, abstract, ppt_url, other_details, submission_status,
                                submitted_at, response_row, matched_by)
      values (
        v_student.id,
        nullif(btrim(r->>'abstract'), ''),
        nullif(btrim(r->>'ppt_url'), ''),
        v_other,
        case when nullif(btrim(r->>'abstract'), '') is null or nullif(btrim(r->>'ppt_url'), '') is null
             then 'INCOMPLETE' else 'SUBMITTED' end,
        v_submitted,
        nullif(r->>'_row', '')::integer,
        v_matched
      )
      on conflict (student_id) do update set
        abstract = excluded.abstract,
        ppt_url = excluded.ppt_url,
        other_details = excluded.other_details,
        submission_status = excluded.submission_status,
        submitted_at = excluded.submitted_at,
        response_row = excluded.response_row,
        matched_by = excluded.matched_by
      where (public.ideas.abstract, public.ideas.ppt_url, public.ideas.other_details, public.ideas.submission_status,
             public.ideas.submitted_at, public.ideas.response_row, public.ideas.matched_by)
            is distinct from
            (excluded.abstract, excluded.ppt_url, excluded.other_details, excluded.submission_status,
             excluded.submitted_at, excluded.response_row, excluded.matched_by);
      get diagnostics v_changed = row_count;

      if v_idea.id is null then
        v_inserted := v_inserted + 1;
      elsif v_changed > 0 then
        v_updated := v_updated + 1;
      else
        v_unchanged := v_unchanged + 1;
      end if;
    exception when others then
      v_skipped := v_skipped + 1;
      v_errors := v_errors || jsonb_build_object('row', r->>'_row', 'register_number', v_reg, 'error', sqlerrm);
    end;
  end loop;

  v_status := case when v_skipped = 0 then 'SUCCESS'
                   when v_skipped < jsonb_array_length(p_rows) then 'PARTIAL' else 'FAILED' end;
  insert into public.form_sync_runs (source, status, received, inserted, updated, unchanged, skipped, errors, triggered_by)
  values (p_source, v_status, jsonb_array_length(p_rows), v_inserted, v_updated, v_unchanged, v_skipped, v_errors, p_actor)
  returning id into v_run_id;
  perform public.write_audit('GOOGLE_FORM_SYNC', 'form_sync_run', v_run_id::text,
    jsonb_build_object('source', p_source, 'received', jsonb_array_length(p_rows), 'inserted', v_inserted,
                       'updated', v_updated, 'skipped', v_skipped), p_actor);

  return jsonb_build_object('run_id', v_run_id, 'status', v_status, 'received', jsonb_array_length(p_rows),
    'inserted', v_inserted, 'updated', v_updated, 'unchanged', v_unchanged, 'skipped', v_skipped, 'errors', v_errors);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Sync maintenance
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_full_resync()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before integer;
  v_after integer;
begin
  if not public.is_admin() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select count(*) into v_before from public.sheet_sync_queue where status = 'PENDING';
  perform public.enqueue_sheet_sync('STUDENT', id) from public.students;
  perform public.enqueue_sheet_sync('EVALUATOR', id) from public.evaluators;
  perform public.enqueue_sheet_sync('EVALUATION', id) from public.evaluations where status = 'COMPLETED';
  perform public.enqueue_sheet_sync('RESPONSE_ROW', student_id) from public.evaluations where status = 'COMPLETED';
  perform public.enqueue_sheet_sync('RESULTS', public.results_sync_key());
  select count(*) into v_after from public.sheet_sync_queue where status = 'PENDING';
  perform public.write_audit('SHEET_FULL_RESYNC', 'sheet_sync_queue', null, jsonb_build_object('enqueued', v_after - v_before));
  return v_after - v_before;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Reporting views
-- ---------------------------------------------------------------------------
create view public.my_evaluations
with (security_invoker = true) as
select
  e.id            as evaluation_id,
  e.status,
  e.total_score,
  e.max_total,
  e.started_at,
  e.submitted_at,
  e.updated_at,
  s.id            as student_id,
  s.register_number,
  s.name          as student_name,
  s.department,
  s.section
from public.evaluations e
join public.students s on s.id = e.student_id
where e.evaluator_id = public.current_evaluator_id();

create view public.evaluator_progress
with (security_invoker = true) as
select
  e.id as evaluator_id,
  e.name,
  e.email,
  e.employee_id,
  e.department,
  e.status,
  e.max_evaluations,
  public.evaluation_cap(e.id)                                     as evaluation_cap,
  count(ev.id)                                                    as claimed_count,
  count(ev.id) filter (where ev.status = 'COMPLETED')             as completed_count,
  count(ev.id) filter (where ev.status = 'IN_PROGRESS')           as in_progress_count,
  round(avg(100.0 * ev.total_score / nullif(ev.max_total, 0)) filter (where ev.status = 'COMPLETED'), 1)
                                                                  as average_percentage
from public.evaluators e
left join public.evaluations ev on ev.evaluator_id = e.id
group by e.id;

create view public.student_overview
with (security_invoker = true) as
select
  s.id,
  s.register_number,
  s.name,
  s.gender,
  s.department,
  s.section,
  s.email,
  s.status,
  s.source,
  s.created_at,
  s.updated_at,
  coalesce(i.submission_status, 'MISSING')        as submission_status,
  i.ppt_url,
  i.matched_by,
  coalesce(ev.status, 'NOT_EVALUATED')            as evaluation_status,
  ev.id                                           as evaluation_id,
  ev.total_score,
  ev.max_total,
  ee.name                                         as evaluator_name
from public.students s
left join public.ideas i on i.student_id = s.id
left join public.evaluations ev on ev.student_id = s.id
left join public.evaluators ee on ee.id = ev.evaluator_id;

create view public.evaluation_overview
with (security_invoker = true) as
select
  ev.id               as evaluation_id,
  ev.status,
  ev.total_score,
  ev.max_total,
  ev.remarks,
  ev.started_at,
  ev.submitted_at,
  ev.updated_at,
  s.id                as student_id,
  s.register_number,
  s.name              as student_name,
  s.department,
  e.id                as evaluator_id,
  e.name              as evaluator_name,
  coalesce((select jsonb_object_agg(sc.criterion_id::text, sc.score)
              from public.evaluation_scores sc where sc.evaluation_id = ev.id), '{}'::jsonb) as scores,
  coalesce((select array_agg(d.id order by d.sort_order, d.name)
              from public.evaluation_domains ed join public.domains d on d.id = ed.domain_id
             where ed.evaluation_id = ev.id), '{}')                                       as domain_ids,
  (select string_agg(d.name, ', ' order by d.sort_order, d.name)
     from public.evaluation_domains ed join public.domains d on d.id = ed.domain_id
    where ed.evaluation_id = ev.id)                                                       as domains
from public.evaluations ev
join public.students s on s.id = ev.student_id
join public.evaluators e on e.id = ev.evaluator_id;

create view public.student_results
with (security_invoker = true) as
select
  s.id                 as student_id,
  s.register_number,
  s.name,
  s.department,
  s.section,
  s.status,
  s.tie_break_priority,
  o.evaluation_id,
  o.total_score,
  o.max_total,
  o.scores,
  o.domains,
  o.evaluator_name,
  o.submitted_at
from public.students s
join public.evaluation_overview o on o.student_id = s.id and o.status = 'COMPLETED';

-- ---------------------------------------------------------------------------
-- 15. Dashboard stats
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'total_students',        (select count(*) from public.students where status = 'ACTIVE'),
      'ideas_submitted',       (select count(*) from public.ideas i join public.students s on s.id = i.student_id
                                 where s.status = 'ACTIVE' and i.submission_status = 'SUBMITTED'),
      'ideas_incomplete',      (select count(*) from public.ideas i join public.students s on s.id = i.student_id
                                 where s.status = 'ACTIVE' and i.submission_status = 'INCOMPLETE'),
      'unmatched_submissions', (select count(*) from public.ideas where matched_by = 'CREATED'),
      'total_evaluators',      (select count(*) from public.evaluators where status = 'ACTIVE'),
      'evaluation_capacity',   (select coalesce(sum(public.evaluation_cap(id)), 0) from public.evaluators where status = 'ACTIVE'),
      'completed_evaluations', (select count(*) from public.evaluations where status = 'COMPLETED'),
      'in_progress_evaluations', (select count(*) from public.evaluations where status = 'IN_PROGRESS'),
      'not_evaluated',         (select count(*) from public.students s where s.status = 'ACTIVE'
                                 and not exists (select 1 from public.evaluations e where e.student_id = s.id)),
      'average_percentage',    (select round(avg(100.0 * total_score / nullif(max_total, 0)), 1)
                                  from public.evaluations where status = 'COMPLETED'),
      'percentage_distribution', (select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb) from (
                                  select least(floor(100.0 * total_score / nullif(max_total, 0) / 10)::int, 9) as bucket,
                                         count(*) as n
                                    from public.evaluations where status = 'COMPLETED' and max_total > 0
                                   group by 1) d),
      'domain_counts',         (select coalesce(jsonb_agg(jsonb_build_object('domain', d.name, 'count', d.n)
                                                          order by d.n desc, d.name), '[]'::jsonb) from (
                                  select dm.name, count(*) as n
                                    from public.evaluation_domains ed
                                    join public.domains dm on dm.id = ed.domain_id
                                    join public.evaluations e on e.id = ed.evaluation_id and e.status = 'COMPLETED'
                                   group by dm.name) d),
      'department_progress',   (select coalesce(jsonb_agg(d order by d.department), '[]'::jsonb) from (
                                  select coalesce(s.department, 'Unknown') as department,
                                         count(*) as students,
                                         count(e.id) filter (where e.status = 'COMPLETED') as completed
                                    from public.students s
                                    left join public.evaluations e on e.student_id = s.id
                                   where s.status = 'ACTIVE'
                                   group by coalesce(s.department, 'Unknown')) d),
      'event_status',          (select event_status from public.app_settings where id),
      'sync_pending',          (select count(*) from public.sheet_sync_queue where status in ('PENDING', 'PROCESSING')),
      'sync_failed',           (select count(*) from public.sheet_sync_queue where status = 'FAILED'),
      'last_sync_at',          (select max(processed_at) from public.sheet_sync_queue where status = 'SUCCESS'),
      'last_form_sync_at',     (select max(created_at) from public.form_sync_runs)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. Privileges (reset function/view grants, then grant the minimum)
-- ---------------------------------------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on public.my_evaluations, public.evaluator_progress, public.student_overview,
              public.evaluation_overview, public.student_results from anon, authenticated;
grant select on public.my_evaluations, public.evaluator_progress, public.student_overview,
                public.evaluation_overview, public.student_results to service_role;
grant all on all functions in schema public to service_role;

grant execute on function public.app_role()                  to authenticated;
grant execute on function public.is_admin()                  to authenticated;
grant execute on function public.current_evaluator_id()      to authenticated;
grant execute on function public.is_my_student(uuid)         to authenticated;
grant execute on function public.evaluation_cap(uuid)        to authenticated;

grant select on public.my_evaluations to authenticated;
grant execute on function public.search_students(text, integer)                      to authenticated;
grant execute on function public.get_student_for_evaluation(uuid)                    to authenticated;
grant execute on function public.save_evaluation_draft(uuid, jsonb, text, uuid[])    to authenticated;
grant execute on function public.submit_evaluation(uuid, jsonb, text, uuid[])        to authenticated;
grant execute on function public.release_my_evaluation(uuid)                         to authenticated;

grant execute on function public.set_event_status(text)                    to authenticated;
grant execute on function public.admin_reopen_evaluation(uuid, text)       to authenticated;
grant execute on function public.admin_release_evaluation(uuid, text)      to authenticated;
grant execute on function public.retry_failed_sync_jobs()                  to authenticated;
grant execute on function public.enqueue_full_resync()                     to authenticated;
grant execute on function public.dashboard_stats()                         to authenticated;
