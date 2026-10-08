-- =============================================================================
-- Business functions, sync-queue triggers and reporting views
--
-- Error convention: functions raise exceptions whose MESSAGE is a stable code
-- (e.g. 'EVENT_NOT_LIVE'). lib/errors.ts maps codes to user-facing text.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Audit helper (internal)
-- ---------------------------------------------------------------------------
create or replace function public.write_audit(
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_user_id uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (user_id, action, entity_type, entity_id, metadata)
  values (coalesce(p_user_id, auth.uid()), p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- Sync queue: enqueue with coalescing
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_sheet_sync(p_entity_type text, p_entity_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.sheet_sync_queue (entity_type, entity_id)
  values (p_entity_type, p_entity_id)
  on conflict (entity_type, entity_id) where status = 'PENDING' do nothing;
$$;

-- Well-known id for the singleton "rebuild Results + Dashboard tabs" job.
create or replace function public.results_sync_key()
returns uuid
language sql
immutable
as $$ select '00000000-0000-0000-0000-000000000000'::uuid $$;

create or replace function public.trg_sync_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_sheet_sync('STUDENT', new.id);
  if tg_op = 'UPDATE' and (old.name, old.register_number, old.department)
       is distinct from (new.name, new.register_number, new.department) then
    -- Denormalised student columns appear on other tabs too.
    perform public.enqueue_sheet_sync('ASSIGNMENT', a.id)
      from public.evaluation_assignments a where a.student_id = new.id;
    perform public.enqueue_sheet_sync('EVALUATION', e.id)
      from public.evaluations e where e.student_id = new.id and e.status = 'COMPLETED';
  end if;
  perform public.enqueue_sheet_sync('RESULTS', public.results_sync_key());
  return null;
end;
$$;

create trigger students_sheet_sync after insert or update on public.students
  for each row execute function public.trg_sync_student();

create or replace function public.trg_sync_idea()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_sheet_sync('STUDENT', new.student_id);
  return null;
end;
$$;

create trigger ideas_sheet_sync after insert or update on public.ideas
  for each row execute function public.trg_sync_idea();

create or replace function public.trg_sync_evaluator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_sheet_sync('EVALUATOR', new.id);
  if tg_op = 'UPDATE' and (old.name, old.employee_id) is distinct from (new.name, new.employee_id) then
    perform public.enqueue_sheet_sync('ASSIGNMENT', a.id)
      from public.evaluation_assignments a where a.evaluator_id = new.id;
    perform public.enqueue_sheet_sync('EVALUATION', e.id)
      from public.evaluations e where e.evaluator_id = new.id and e.status = 'COMPLETED';
  end if;
  return null;
end;
$$;

create trigger evaluators_sheet_sync after insert or update on public.evaluators
  for each row execute function public.trg_sync_evaluator();

create or replace function public.trg_sync_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_sheet_sync('ASSIGNMENT', new.id);
  perform public.enqueue_sheet_sync('EVALUATOR', new.evaluator_id);
  perform public.enqueue_sheet_sync('RESULTS', public.results_sync_key());
  return null;
end;
$$;

create trigger evaluation_assignments_sheet_sync after insert or update on public.evaluation_assignments
  for each row execute function public.trg_sync_assignment();

-- Drafts are private to the evaluator; only completed evaluations (and a
-- completed evaluation being reopened) are reported to the sheet.
create or replace function public.trg_sync_evaluation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'COMPLETED' or (tg_op = 'UPDATE' and old.status = 'COMPLETED') then
    perform public.enqueue_sheet_sync('EVALUATION', new.id);
    perform public.enqueue_sheet_sync('RESULTS', public.results_sync_key());
  end if;
  return null;
end;
$$;

create trigger evaluations_sheet_sync after insert or update on public.evaluations
  for each row execute function public.trg_sync_evaluation();

-- ---------------------------------------------------------------------------
-- Evaluation: save draft
-- ---------------------------------------------------------------------------
create or replace function public.save_evaluation_draft(
  p_assignment_id uuid,
  p_score integer,
  p_remarks text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evaluator   uuid := public.current_evaluator_id();
  v_status      text;
  v_assignment  public.evaluation_assignments;
  v_eval        public.evaluations;
  v_remarks     text := nullif(btrim(coalesce(p_remarks, '')), '');
begin
  if v_evaluator is null then
    raise exception 'NOT_AN_EVALUATOR' using errcode = '42501';
  end if;

  select s.event_status into v_status from public.app_settings s where s.id;
  if v_status not in ('LIVE', 'PAUSED') then
    raise exception 'EVENT_NOT_LIVE' using errcode = 'P0001', detail = v_status;
  end if;

  if p_score is not null and (p_score < 1 or p_score > 10) then
    raise exception 'INVALID_SCORE' using errcode = '22023';
  end if;
  if v_remarks is not null and char_length(v_remarks) > 5000 then
    raise exception 'REMARKS_TOO_LONG' using errcode = '22023';
  end if;

  -- Row lock serialises concurrent draft saves / submits for one assignment.
  select * into v_assignment
  from public.evaluation_assignments a
  where a.id = p_assignment_id and a.evaluator_id = v_evaluator and a.status <> 'REPLACED'
  for update;
  if not found then
    raise exception 'ASSIGNMENT_NOT_FOUND' using errcode = '42501';
  end if;

  select * into v_eval from public.evaluations e where e.assignment_id = p_assignment_id;
  if found and v_eval.status = 'COMPLETED' then
    raise exception 'ALREADY_SUBMITTED' using errcode = 'P0001';
  end if;

  insert into public.evaluations (assignment_id, student_id, evaluator_id, score, remarks, status)
  values (p_assignment_id, v_assignment.student_id, v_evaluator, p_score, v_remarks, 'IN_PROGRESS')
  on conflict (assignment_id) do update
    set score = excluded.score,
        remarks = excluded.remarks,
        version = public.evaluations.version + 1
  returning * into v_eval;

  if v_assignment.status = 'PENDING' then
    update public.evaluation_assignments set status = 'IN_PROGRESS' where id = p_assignment_id;
  end if;

  return jsonb_build_object(
    'evaluation_id', v_eval.id,
    'status', v_eval.status,
    'version', v_eval.version,
    'saved_at', v_eval.updated_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Evaluation: final submission (atomic, idempotent for double-clicks)
-- ---------------------------------------------------------------------------
create or replace function public.submit_evaluation(
  p_assignment_id uuid,
  p_score integer,
  p_remarks text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evaluator   uuid := public.current_evaluator_id();
  v_settings    public.app_settings;
  v_assignment  public.evaluation_assignments;
  v_existing    public.evaluations;
  v_eval        public.evaluations;
  v_remarks     text := nullif(btrim(coalesce(p_remarks, '')), '');
  v_action      text := 'EVALUATION_SUBMITTED';
begin
  if v_evaluator is null then
    raise exception 'NOT_AN_EVALUATOR' using errcode = '42501';
  end if;

  select * into v_settings from public.app_settings s where s.id;
  if v_settings.event_status <> 'LIVE' then
    raise exception 'EVENT_NOT_LIVE' using errcode = 'P0001', detail = v_settings.event_status;
  end if;

  if p_score is null or p_score < 1 or p_score > 10 then
    raise exception 'INVALID_SCORE' using errcode = '22023';
  end if;
  if v_remarks is not null and char_length(v_remarks) > 5000 then
    raise exception 'REMARKS_TOO_LONG' using errcode = '22023';
  end if;

  select * into v_assignment
  from public.evaluation_assignments a
  where a.id = p_assignment_id and a.evaluator_id = v_evaluator and a.status <> 'REPLACED'
  for update;
  if not found then
    raise exception 'ASSIGNMENT_NOT_FOUND' using errcode = '42501';
  end if;

  select * into v_existing from public.evaluations e where e.assignment_id = p_assignment_id;
  if found and v_existing.status = 'COMPLETED' then
    -- Same payload again (double click / retry after timeout): succeed quietly.
    if v_existing.score = p_score and v_existing.remarks is not distinct from v_remarks then
      return jsonb_build_object(
        'evaluation_id', v_existing.id,
        'submitted_at', v_existing.submitted_at,
        'duplicate', true
      );
    end if;
    if not v_settings.allow_resubmission then
      raise exception 'ALREADY_SUBMITTED' using errcode = 'P0001';
    end if;
    v_action := 'EVALUATION_UPDATED';
  end if;

  insert into public.evaluations (
    assignment_id, student_id, evaluator_id, score, remarks, status, submitted_at
  )
  values (
    p_assignment_id, v_assignment.student_id, v_evaluator, p_score, v_remarks, 'COMPLETED', now()
  )
  on conflict (assignment_id) do update
    set score = excluded.score,
        remarks = excluded.remarks,
        status = 'COMPLETED',
        submitted_at = now(),
        version = public.evaluations.version + 1
  returning * into v_eval;

  update public.evaluation_assignments
     set status = 'COMPLETED', completed_at = now()
   where id = p_assignment_id;

  perform public.write_audit(
    v_action, 'evaluation', v_eval.id::text,
    jsonb_build_object('assignment_id', p_assignment_id, 'student_id', v_assignment.student_id,
                       'evaluator_id', v_evaluator, 'score', p_score)
  );

  return jsonb_build_object(
    'evaluation_id', v_eval.id,
    'submitted_at', v_eval.submitted_at,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: reopen a completed evaluation so its evaluator can revise it
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
  update public.evaluation_assignments
     set status = 'IN_PROGRESS', completed_at = null
   where id = v_eval.assignment_id;

  perform public.write_audit(
    'EVALUATION_REOPENED', 'evaluation', p_evaluation_id::text,
    jsonb_build_object('reason', p_reason, 'previous_score', v_eval.score, 'evaluator_id', v_eval.evaluator_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: event status
-- ---------------------------------------------------------------------------
create or replace function public.set_event_status(p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_status not in ('NOT_STARTED', 'LIVE', 'PAUSED', 'CLOSED') then
    raise exception 'INVALID_EVENT_STATUS' using errcode = '22023';
  end if;
  select event_status into v_old from public.app_settings where id for update;
  update public.app_settings set event_status = p_status, updated_by = auth.uid() where id;
  perform public.write_audit('EVENT_STATUS_CHANGED', 'app_settings', 'event',
                             jsonb_build_object('from', v_old, 'to', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: confirm an allocation computed (and previewed) by the app server.
--
-- The app computes the randomized plan from a seed; this function validates
-- it against the *current* state under an exclusive lock and either commits
-- every assignment or nothing.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_allocation(
  p_allocation_type text,
  p_seed text,
  p_max_per_evaluator integer,
  p_evaluators_per_student integer,
  p_assignments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_id     uuid;
  v_replaced     integer := 0;
  v_inserted     integer := 0;
  v_students     integer;
  v_evaluators   integer;
  v_bad          integer;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_allocation_type not in ('INITIAL', 'INCREMENTAL', 'FULL_REALLOCATION') then
    raise exception 'INVALID_ALLOCATION_TYPE' using errcode = '22023';
  end if;
  if p_max_per_evaluator not between 1 and 1000 or p_evaluators_per_student not between 1 and 5 then
    raise exception 'INVALID_ALLOCATION_CONFIG' using errcode = '22023';
  end if;
  if jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) = 0 then
    raise exception 'EMPTY_ALLOCATION' using errcode = '22023';
  end if;

  -- Only one allocation may be confirmed at a time.
  perform pg_advisory_xact_lock(hashtext('idea_to_expo.allocation'));

  -- Every referenced student/evaluator must still be eligible.
  select count(*) into v_bad
  from jsonb_to_recordset(p_assignments) as x(student_id uuid, evaluator_id uuid)
  left join public.students s on s.id = x.student_id and s.status = 'ACTIVE'
  left join public.evaluators e on e.id = x.evaluator_id and e.status = 'ACTIVE'
  where s.id is null or e.id is null;
  if v_bad > 0 then
    raise exception 'STALE_PREVIEW' using errcode = 'P0001',
      detail = format('%s assignment(s) reference ineligible students or evaluators', v_bad);
  end if;

  if p_allocation_type = 'FULL_REALLOCATION' then
    -- Only untouched assignments are replaced; anything with evaluation
    -- activity is preserved. History rows are kept, never deleted.
    update public.evaluation_assignments a
       set status = 'REPLACED', replaced_at = now()
     where a.status = 'PENDING'
       and not exists (select 1 from public.evaluations e where e.assignment_id = a.id);
    get diagnostics v_replaced = row_count;

    update public.allocation_batches
       set status = 'REPLACED', replaced_at = now()
     where status = 'CONFIRMED';
  end if;

  select count(distinct x.student_id), count(distinct x.evaluator_id)
    into v_students, v_evaluators
  from jsonb_to_recordset(p_assignments) as x(student_id uuid, evaluator_id uuid);

  insert into public.allocation_batches (
    created_by, allocation_type, student_count, evaluator_count, assignment_count,
    replaced_count, max_per_evaluator, evaluators_per_student, seed, status
  ) values (
    auth.uid(), p_allocation_type, v_students, v_evaluators, jsonb_array_length(p_assignments),
    v_replaced, p_max_per_evaluator, p_evaluators_per_student, p_seed, 'CONFIRMED'
  )
  returning id into v_batch_id;

  begin
    insert into public.evaluation_assignments (student_id, evaluator_id, allocation_batch_id, status)
    select x.student_id, x.evaluator_id, v_batch_id, 'PENDING'
    from jsonb_to_recordset(p_assignments) as x(student_id uuid, evaluator_id uuid);
    get diagnostics v_inserted = row_count;
  exception when unique_violation then
    raise exception 'STALE_PREVIEW' using errcode = 'P0001',
      detail = 'A student is already assigned to the same evaluator';
  end;

  -- Post-conditions: no student over-assigned, no evaluator over capacity.
  select count(*) into v_bad from (
    select a.student_id
    from public.evaluation_assignments a
    where a.status <> 'REPLACED'
    group by a.student_id
    having count(*) > p_evaluators_per_student
  ) t;
  if v_bad > 0 then
    raise exception 'STALE_PREVIEW' using errcode = 'P0001',
      detail = format('%s student(s) would exceed %s evaluator(s)', v_bad, p_evaluators_per_student);
  end if;

  select count(*) into v_bad from (
    select e.id
    from public.evaluators e
    join public.evaluation_assignments a on a.evaluator_id = e.id and a.status <> 'REPLACED'
    group by e.id, e.max_assignments
    having count(*) > least(e.max_assignments, p_max_per_evaluator)
  ) t;
  if v_bad > 0 then
    raise exception 'CAPACITY_EXCEEDED' using errcode = 'P0001',
      detail = format('%s evaluator(s) would exceed capacity', v_bad);
  end if;

  update public.app_settings
     set max_per_evaluator = p_max_per_evaluator,
         evaluators_per_student = p_evaluators_per_student,
         updated_by = auth.uid()
   where id;

  perform public.write_audit(
    'ALLOCATION_CONFIRMED', 'allocation_batch', v_batch_id::text,
    jsonb_build_object('type', p_allocation_type, 'assignments', v_inserted, 'replaced', v_replaced,
                       'students', v_students, 'evaluators', v_evaluators, 'seed', p_seed)
  );

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'assignment_count', v_inserted,
    'replaced_count', v_replaced
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Google Form / CSV ingestion (service role only)
--
-- Idempotent upsert keyed on register_number. A row older than what is already
-- stored (by form timestamp) never overwrites newer data, so replaying the
-- whole response sheet is always safe.
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
  v_submitted   timestamptz;
  v_student     public.students;
  v_student_src text := case when p_source = 'CSV_IMPORT' then 'IMPORT' else 'FORM' end;
  v_inserted    integer := 0;
  v_updated     integer := 0;
  v_unchanged   integer := 0;
  v_skipped     integer := 0;
  v_changed     integer;
  v_idea_changed integer;
  v_is_new      boolean;
  v_errors      jsonb := '[]'::jsonb;
  v_run_id      uuid;
  v_status      text;
begin
  if p_source not in ('APPS_SCRIPT', 'SHEETS_PULL', 'CSV_IMPORT') then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INVALID_PAYLOAD' using errcode = '22023';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    begin
      v_reg := upper(regexp_replace(coalesce(r->>'register_number', ''), '\s', '', 'g'));
      if v_reg = '' then
        v_skipped := v_skipped + 1;
        v_errors := v_errors || jsonb_build_object('row', r->>'_row', 'error', 'Missing register number');
        continue;
      end if;
      if coalesce(btrim(r->>'name'), '') = '' then
        v_skipped := v_skipped + 1;
        v_errors := v_errors || jsonb_build_object('row', r->>'_row', 'register_number', v_reg, 'error', 'Missing name');
        continue;
      end if;

      v_submitted := nullif(r->>'submitted_at', '')::timestamptz;

      select * into v_student from public.students where register_number = v_reg for update;
      v_is_new := not found;

      if v_is_new then
        insert into public.students (register_number, name, department, year, section, email, phone, source, form_submitted_at)
        values (v_reg, btrim(r->>'name'), nullif(btrim(r->>'department'), ''), nullif(r->>'year', '')::integer,
                nullif(btrim(r->>'section'), ''), nullif(lower(btrim(r->>'email')), ''), nullif(btrim(r->>'phone'), ''),
                v_student_src, v_submitted)
        returning * into v_student;
        v_inserted := v_inserted + 1;
        v_changed := 1;
      else
        if v_student.form_submitted_at is not null and v_submitted is not null
           and v_submitted < v_student.form_submitted_at then
          v_unchanged := v_unchanged + 1;
          continue;
        end if;

        update public.students s set
          name = btrim(r->>'name'),
          department = coalesce(nullif(btrim(r->>'department'), ''), s.department),
          year = coalesce(nullif(r->>'year', '')::integer, s.year),
          section = coalesce(nullif(btrim(r->>'section'), ''), s.section),
          email = coalesce(nullif(lower(btrim(r->>'email')), ''), s.email),
          phone = coalesce(nullif(btrim(r->>'phone'), ''), s.phone),
          form_submitted_at = coalesce(v_submitted, s.form_submitted_at)
        where s.id = v_student.id
          and (s.name, s.department, s.year, s.section, s.email, s.phone, s.form_submitted_at)
              is distinct from
              (btrim(r->>'name'),
               coalesce(nullif(btrim(r->>'department'), ''), s.department),
               coalesce(nullif(r->>'year', '')::integer, s.year),
               coalesce(nullif(btrim(r->>'section'), ''), s.section),
               coalesce(nullif(lower(btrim(r->>'email')), ''), s.email),
               coalesce(nullif(btrim(r->>'phone'), ''), s.phone),
               coalesce(v_submitted, s.form_submitted_at));
        get diagnostics v_changed = row_count;
      end if;

      insert into public.ideas (student_id, title, problem_statement, idea_description, team_details, ppt_url, other_details, submission_status)
      values (
        v_student.id,
        nullif(btrim(r->>'title'), ''),
        nullif(btrim(r->>'problem_statement'), ''),
        nullif(btrim(r->>'idea_description'), ''),
        nullif(btrim(r->>'team_details'), ''),
        nullif(btrim(r->>'ppt_url'), ''),
        coalesce(r->'other_details', '{}'::jsonb),
        case when nullif(btrim(r->>'problem_statement'), '') is null
               or nullif(btrim(r->>'ppt_url'), '') is null then 'INCOMPLETE' else 'SUBMITTED' end
      )
      on conflict (student_id) do update set
        title = excluded.title,
        problem_statement = excluded.problem_statement,
        idea_description = excluded.idea_description,
        team_details = excluded.team_details,
        ppt_url = excluded.ppt_url,
        other_details = excluded.other_details,
        submission_status = excluded.submission_status
      where (public.ideas.title, public.ideas.problem_statement, public.ideas.idea_description,
             public.ideas.team_details, public.ideas.ppt_url, public.ideas.other_details, public.ideas.submission_status)
            is distinct from
            (excluded.title, excluded.problem_statement, excluded.idea_description,
             excluded.team_details, excluded.ppt_url, excluded.other_details, excluded.submission_status);
      get diagnostics v_idea_changed = row_count;

      if v_is_new then
        null; -- already counted as inserted
      elsif v_changed > 0 or v_idea_changed > 0 then
        v_updated := v_updated + 1;
      else
        v_unchanged := v_unchanged + 1;
      end if;
    exception when others then
      v_skipped := v_skipped + 1;
      v_errors := v_errors || jsonb_build_object('row', r->>'_row', 'register_number', v_reg, 'error', sqlerrm);
    end;
  end loop;

  v_status := case
    when v_skipped = 0 then 'SUCCESS'
    when v_skipped < jsonb_array_length(p_rows) then 'PARTIAL'
    else 'FAILED' end;

  insert into public.form_sync_runs (source, status, received, inserted, updated, unchanged, skipped, errors, triggered_by)
  values (p_source, v_status, jsonb_array_length(p_rows), v_inserted, v_updated, v_unchanged, v_skipped,
          v_errors, p_actor)
  returning id into v_run_id;

  perform public.write_audit(
    case when p_source = 'CSV_IMPORT' then 'STUDENT_IMPORT' else 'GOOGLE_FORM_SYNC' end,
    'form_sync_run', v_run_id::text,
    jsonb_build_object('source', p_source, 'received', jsonb_array_length(p_rows), 'inserted', v_inserted,
                       'updated', v_updated, 'skipped', v_skipped),
    p_actor
  );

  return jsonb_build_object(
    'run_id', v_run_id, 'status', v_status, 'received', jsonb_array_length(p_rows),
    'inserted', v_inserted, 'updated', v_updated, 'unchanged', v_unchanged,
    'skipped', v_skipped, 'errors', v_errors
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Sync worker primitives (service role only)
-- ---------------------------------------------------------------------------

-- Lease lock so only one worker writes to the spreadsheet at a time
-- (row positions for new keys are computed from the sheet's current state).
create or replace function public.acquire_sync_lock(p_name text, p_holder text, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  insert into public.sync_locks (name) values (p_name) on conflict (name) do nothing;
  update public.sync_locks
     set holder = p_holder, lease_until = now() + make_interval(secs => p_ttl_seconds)
   where name = p_name and (lease_until < now() or holder = p_holder)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.release_sync_lock(p_name text, p_holder text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.sync_locks set lease_until = '-infinity', holder = null
  where name = p_name and holder = p_holder;
$$;

-- Claims due jobs. PROCESSING jobs whose worker died (stale lock) are reclaimed.
create or replace function public.claim_sync_jobs(p_limit integer)
returns setof public.sheet_sync_queue
language sql
security definer
set search_path = ''
as $$
  update public.sheet_sync_queue q
     set status = 'PROCESSING', locked_at = now(), attempts = q.attempts + 1
   where q.id in (
     select id from public.sheet_sync_queue
      where (status = 'PENDING' and next_retry_at <= now())
         or (status = 'PROCESSING' and locked_at < now() - interval '5 minutes')
      order by created_at
      limit p_limit
      for update skip locked
   )
  returning q.*;
$$;

create or replace function public.complete_sync_jobs(p_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.sheet_sync_queue
     set status = 'SUCCESS', processed_at = now(), last_error = null, locked_at = null
   where id = any(p_ids) and status = 'PROCESSING';
$$;

-- Failed jobs go back to PENDING with exponential backoff, or FAILED after
-- p_max_attempts. If a newer PENDING job for the same entity already exists,
-- this one is SUPERSEDED (the newer job re-reads current state anyway).
create or replace function public.fail_sync_jobs(p_ids uuid[], p_error text, p_max_attempts integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.sheet_sync_queue q
     set status = 'SUPERSEDED', processed_at = now(), last_error = left(p_error, 2000), locked_at = null
   where q.id = any(p_ids) and q.status = 'PROCESSING'
     and exists (select 1 from public.sheet_sync_queue p
                  where p.entity_type = q.entity_type and p.entity_id = q.entity_id and p.status = 'PENDING');

  update public.sheet_sync_queue q
     set status = case when q.attempts >= p_max_attempts then 'FAILED' else 'PENDING' end,
         last_error = left(p_error, 2000),
         locked_at = null,
         next_retry_at = now() + make_interval(secs => least(15 * power(2, greatest(q.attempts - 1, 0)), 1800)::integer)
   where q.id = any(p_ids) and q.status = 'PROCESSING';
end;
$$;

-- Admin: put FAILED jobs back in the queue.
create or replace function public.retry_failed_sync_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_admin() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update public.sheet_sync_queue q
     set status = 'SUPERSEDED', processed_at = now()
   where q.status = 'FAILED'
     and exists (select 1 from public.sheet_sync_queue p
                  where p.entity_type = q.entity_type and p.entity_id = q.entity_id and p.status = 'PENDING');
  update public.sheet_sync_queue
     set status = 'PENDING', attempts = 0, next_retry_at = now()
   where status = 'FAILED';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Admin: enqueue every entity (rebuild the spreadsheet from Supabase).
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
  perform public.enqueue_sheet_sync('ASSIGNMENT', id) from public.evaluation_assignments;
  perform public.enqueue_sheet_sync('EVALUATION', id) from public.evaluations where status = 'COMPLETED';
  perform public.enqueue_sheet_sync('RESULTS', public.results_sync_key());
  select count(*) into v_after from public.sheet_sync_queue where status = 'PENDING';
  perform public.write_audit('SHEET_FULL_RESYNC', 'sheet_sync_queue', null,
                             jsonb_build_object('enqueued', v_after - v_before));
  return v_after - v_before;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reporting views (security_invoker: callers' RLS applies)
-- ---------------------------------------------------------------------------

-- Flat per-assignment rows for the evaluator's own list. Exposes only the
-- non-sensitive student columns.
create view public.my_assignments
with (security_invoker = true) as
select
  a.id               as assignment_id,
  a.status           as assignment_status,
  a.assigned_at,
  a.completed_at,
  s.id               as student_id,
  s.register_number,
  s.name             as student_name,
  s.department,
  s.section,
  s.year,
  i.id is not null   as has_idea,
  i.ppt_url is not null as has_ppt,
  ev.score,
  ev.status          as evaluation_status,
  ev.updated_at      as evaluation_updated_at
from public.evaluation_assignments a
join public.students s on s.id = a.student_id
left join public.ideas i on i.student_id = s.id
left join public.evaluations ev on ev.assignment_id = a.id
where a.status <> 'REPLACED'
  and a.evaluator_id = public.current_evaluator_id();

create view public.evaluator_progress
with (security_invoker = true) as
select
  e.id as evaluator_id,
  e.name,
  e.email,
  e.employee_id,
  e.department,
  e.status,
  e.max_assignments,
  count(a.id)                                              as assigned_count,
  count(a.id) filter (where a.status = 'COMPLETED')        as completed_count,
  count(a.id) filter (where a.status = 'IN_PROGRESS')      as in_progress_count,
  count(a.id) filter (where a.status = 'PENDING')          as pending_count,
  round(avg(ev.score) filter (where ev.status = 'COMPLETED'), 2) as average_score
from public.evaluators e
left join public.evaluation_assignments a on a.evaluator_id = e.id and a.status <> 'REPLACED'
left join public.evaluations ev on ev.assignment_id = a.id
group by e.id;

create view public.student_results
with (security_invoker = true) as
select
  s.id as student_id,
  s.register_number,
  s.name,
  s.department,
  s.section,
  s.status,
  s.tie_break_priority,
  (select count(*) from public.evaluation_assignments a
    where a.student_id = s.id and a.status <> 'REPLACED')            as assigned_count,
  count(ev.id)                                                       as evaluation_count,
  round(avg(ev.score), 4)                                            as average_score,
  min(ev.score)                                                      as min_score,
  max(ev.score)                                                      as max_score,
  array_agg(ev.score order by ev.score desc) filter (where ev.id is not null) as scores
from public.students s
left join public.evaluations ev on ev.student_id = s.id and ev.status = 'COMPLETED'
group by s.id;

create view public.student_overview
with (security_invoker = true) as
select
  t.*,
  case
    when t.assigned_count = 0 then 'UNASSIGNED'
    when t.completed_count >= t.assigned_count then 'COMPLETED'
    else 'PENDING'
  end as evaluation_state
from (
select
  s.id,
  s.register_number,
  s.name,
  s.department,
  s.year,
  s.section,
  s.status,
  s.source,
  s.created_at,
  s.updated_at,
  coalesce(i.submission_status, 'MISSING') as submission_status,
  i.ppt_url,
  (select count(*) from public.evaluation_assignments a
    where a.student_id = s.id and a.status <> 'REPLACED')                       as assigned_count,
  (select count(*) from public.evaluations ev
    where ev.student_id = s.id and ev.status = 'COMPLETED')                      as completed_count,
  (select round(avg(ev.score), 2) from public.evaluations ev
    where ev.student_id = s.id and ev.status = 'COMPLETED')                      as average_score,
  (select string_agg(e.name, ', ' order by e.name)
     from public.evaluation_assignments a join public.evaluators e on e.id = a.evaluator_id
    where a.student_id = s.id and a.status <> 'REPLACED')                       as evaluator_names
from public.students s
left join public.ideas i on i.student_id = s.id
) t;

create view public.evaluation_overview
with (security_invoker = true) as
select
  a.id                as assignment_id,
  a.status            as assignment_status,
  a.assigned_at,
  a.allocation_batch_id,
  s.id                as student_id,
  s.register_number,
  s.name              as student_name,
  s.department,
  e.id                as evaluator_id,
  e.name              as evaluator_name,
  ev.id               as evaluation_id,
  ev.score,
  ev.remarks,
  ev.status           as evaluation_status,
  ev.submitted_at,
  ev.updated_at       as evaluation_updated_at
from public.evaluation_assignments a
join public.students s on s.id = a.student_id
join public.evaluators e on e.id = a.evaluator_id
left join public.evaluations ev on ev.assignment_id = a.id
where a.status <> 'REPLACED';

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
      'total_evaluators',      (select count(*) from public.evaluators where status = 'ACTIVE'),
      'assigned_students',     (select count(distinct student_id) from public.evaluation_assignments where status <> 'REPLACED'),
      'total_assignments',     (select count(*) from public.evaluation_assignments where status <> 'REPLACED'),
      'completed_evaluations', (select count(*) from public.evaluation_assignments where status = 'COMPLETED'),
      'in_progress_evaluations', (select count(*) from public.evaluation_assignments where status = 'IN_PROGRESS'),
      'pending_evaluations',   (select count(*) from public.evaluation_assignments where status = 'PENDING'),
      'average_score',         (select round(avg(score), 2) from public.evaluations where status = 'COMPLETED'),
      'score_distribution',    (select coalesce(jsonb_object_agg(score, n), '{}'::jsonb)
                                  from (select score, count(*) n from public.evaluations
                                         where status = 'COMPLETED' group by score) d),
      'department_progress',   (select coalesce(jsonb_agg(d order by d.department), '[]'::jsonb) from (
                                  select coalesce(s.department, 'Unknown') as department,
                                         count(a.id) as assigned,
                                         count(a.id) filter (where a.status = 'COMPLETED') as completed
                                    from public.evaluation_assignments a
                                    join public.students s on s.id = a.student_id
                                   where a.status <> 'REPLACED'
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
