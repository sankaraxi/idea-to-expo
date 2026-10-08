-- =============================================================================
-- Function / view privileges
--
-- Supabase's default privileges grant EXECUTE on new functions (and SELECT on
-- new views) to anon and authenticated. Reset everything, then grant back the
-- minimum each role needs.
-- =============================================================================

revoke all on all functions in schema public from public, anon, authenticated;

revoke all on public.my_assignments      from anon, authenticated;
revoke all on public.evaluator_progress  from anon, authenticated;
revoke all on public.student_results     from anon, authenticated;
revoke all on public.student_overview    from anon, authenticated;
revoke all on public.evaluation_overview from anon, authenticated;

grant select on public.my_assignments      to service_role;
grant select on public.evaluator_progress  to service_role;
grant select on public.student_results     to service_role;
grant select on public.student_overview    to service_role;
grant select on public.evaluation_overview to service_role;

-- Identity helpers (used inside RLS policies and views).
grant execute on function public.app_role()                     to authenticated;
grant execute on function public.is_admin()                     to authenticated;
grant execute on function public.current_evaluator_id()         to authenticated;
grant execute on function public.is_assigned_student(uuid)      to authenticated;

-- Evaluator surface.
grant select on public.my_assignments to authenticated;
grant execute on function public.save_evaluation_draft(uuid, integer, text) to authenticated;
grant execute on function public.submit_evaluation(uuid, integer, text)     to authenticated;

-- Admin surface (each function re-checks is_admin()).
grant execute on function public.set_event_status(text)                                  to authenticated;
grant execute on function public.admin_reopen_evaluation(uuid, text)                     to authenticated;
grant execute on function public.confirm_allocation(text, text, integer, integer, jsonb) to authenticated;
grant execute on function public.retry_failed_sync_jobs()                                to authenticated;
grant execute on function public.enqueue_full_resync()                                   to authenticated;
grant execute on function public.dashboard_stats()                                       to authenticated;

-- Service role (server-only workers and ingestion).
grant execute on all functions in schema public to service_role;
