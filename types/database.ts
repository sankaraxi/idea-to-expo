/**
 * Hand-maintained Supabase types mirroring supabase/migrations.
 * Regenerate with `npx supabase gen types typescript --linked > types/database.ts`
 * once a project is linked; keep the exported aliases at the bottom.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Insert<Row, Required extends keyof Row> = Pick<Row, Required> & Partial<Omit<Row, Required>>;

export type EventStatus = "NOT_STARTED" | "LIVE" | "PAUSED" | "CLOSED";
export type AssignmentStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REPLACED";
export type EvaluationStatus = "IN_PROGRESS" | "COMPLETED";
export type SyncEntityType = "STUDENT" | "EVALUATOR" | "ASSIGNMENT" | "EVALUATION" | "RESULTS";
export type SyncStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "SUPERSEDED";
export type AppRole = "ADMIN" | "EVALUATOR";

export type ProfileRow = {
  id: string;
  role: AppRole;
  full_name: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export type AppSettingsRow = {
  id: boolean;
  event_status: EventStatus;
  max_per_evaluator: number;
  evaluators_per_student: number;
  allow_resubmission: boolean;
  tie_breakers: string[];
  form_field_mapping: Json;
  updated_at: string;
  updated_by: string | null;
}

export type StudentRow = {
  id: string;
  register_number: string;
  name: string;
  department: string | null;
  year: number | null;
  section: string | null;
  email: string | null;
  phone: string | null;
  status: "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED";
  source: "FORM" | "IMPORT" | "MANUAL" | "SEED";
  form_submitted_at: string | null;
  tie_break_priority: number | null;
  created_at: string;
  updated_at: string;
}

export type IdeaRow = {
  id: string;
  student_id: string;
  title: string | null;
  problem_statement: string | null;
  idea_description: string | null;
  team_details: string | null;
  ppt_url: string | null;
  other_details: Json;
  submission_status: "SUBMITTED" | "INCOMPLETE";
  created_at: string;
  updated_at: string;
}

export type EvaluatorRow = {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  employee_id: string | null;
  department: string | null;
  status: "ACTIVE" | "DISABLED";
  max_assignments: number;
  created_at: string;
  updated_at: string;
}

export type AllocationBatchRow = {
  id: string;
  created_by: string | null;
  allocation_type: "INITIAL" | "INCREMENTAL" | "FULL_REALLOCATION";
  student_count: number;
  evaluator_count: number;
  assignment_count: number;
  replaced_count: number;
  max_per_evaluator: number;
  evaluators_per_student: number;
  seed: string | null;
  status: "DRAFT" | "CONFIRMED" | "REPLACED" | "CANCELLED";
  created_at: string;
  replaced_at: string | null;
}

export type AssignmentRow = {
  id: string;
  student_id: string;
  evaluator_id: string;
  allocation_batch_id: string | null;
  status: AssignmentStatus;
  assigned_at: string;
  completed_at: string | null;
  replaced_at: string | null;
  updated_at: string;
}

export type EvaluationRow = {
  id: string;
  assignment_id: string;
  student_id: string;
  evaluator_id: string;
  score: number | null;
  remarks: string | null;
  status: EvaluationStatus;
  version: number;
  started_at: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AuditLogRow = {
  id: number;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Json;
  created_at: string;
}

export type SyncJobRow = {
  id: string;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: "UPSERT";
  payload: Json;
  status: SyncStatus;
  attempts: number;
  last_error: string | null;
  next_retry_at: string;
  locked_at: string | null;
  created_at: string;
  processed_at: string | null;
}

export type SyncLockRow = {
  name: string;
  holder: string | null;
  lease_until: string;
}

export type FormSyncRunRow = {
  id: string;
  source: "APPS_SCRIPT" | "SHEETS_PULL" | "CSV_IMPORT";
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: Json;
  triggered_by: string | null;
  created_at: string;
}

export type MyAssignmentRow = {
  assignment_id: string;
  assignment_status: AssignmentStatus;
  assigned_at: string;
  completed_at: string | null;
  student_id: string;
  register_number: string;
  student_name: string;
  department: string | null;
  section: string | null;
  year: number | null;
  has_idea: boolean;
  has_ppt: boolean;
  score: number | null;
  evaluation_status: EvaluationStatus | null;
  evaluation_updated_at: string | null;
}

export type EvaluatorProgressRow = {
  evaluator_id: string;
  name: string;
  email: string;
  employee_id: string | null;
  department: string | null;
  status: "ACTIVE" | "DISABLED";
  max_assignments: number;
  assigned_count: number;
  completed_count: number;
  in_progress_count: number;
  pending_count: number;
  average_score: number | null;
}

export type StudentResultRow = {
  student_id: string;
  register_number: string;
  name: string;
  department: string | null;
  section: string | null;
  status: StudentRow["status"];
  tie_break_priority: number | null;
  assigned_count: number;
  evaluation_count: number;
  average_score: number | null;
  min_score: number | null;
  max_score: number | null;
  scores: number[] | null;
}

export type StudentOverviewRow = {
  id: string;
  register_number: string;
  name: string;
  department: string | null;
  year: number | null;
  section: string | null;
  status: StudentRow["status"];
  source: StudentRow["source"];
  created_at: string;
  updated_at: string;
  submission_status: "SUBMITTED" | "INCOMPLETE" | "MISSING";
  ppt_url: string | null;
  assigned_count: number;
  completed_count: number;
  average_score: number | null;
  evaluator_names: string | null;
  evaluation_state: "UNASSIGNED" | "PENDING" | "COMPLETED";
}

export type EvaluationOverviewRow = {
  assignment_id: string;
  assignment_status: AssignmentStatus;
  assigned_at: string;
  allocation_batch_id: string | null;
  student_id: string;
  register_number: string;
  student_name: string;
  department: string | null;
  evaluator_id: string;
  evaluator_name: string;
  evaluation_id: string | null;
  score: number | null;
  remarks: string | null;
  evaluation_status: EvaluationStatus | null;
  submitted_at: string | null;
  evaluation_updated_at: string | null;
}

export type DashboardStats = {
  total_students: number;
  ideas_submitted: number;
  ideas_incomplete: number;
  total_evaluators: number;
  assigned_students: number;
  total_assignments: number;
  completed_evaluations: number;
  in_progress_evaluations: number;
  pending_evaluations: number;
  average_score: number | null;
  score_distribution: Record<string, number>;
  department_progress: { department: string; assigned: number; completed: number }[];
  event_status: EventStatus;
  sync_pending: number;
  sync_failed: number;
  last_sync_at: string | null;
  last_form_sync_at: string | null;
}

type Table<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Insert<Row, Required>;
  Update: Partial<Row>;
  Relationships: [];
};

type View<Row> = { Row: Row; Relationships: [] };

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, "id" | "role">;
      app_settings: Table<AppSettingsRow, never>;
      students: Table<StudentRow, "register_number" | "name">;
      ideas: Table<IdeaRow, "student_id">;
      evaluators: Table<EvaluatorRow, "name" | "email">;
      allocation_batches: Table<
        AllocationBatchRow,
        "allocation_type" | "student_count" | "evaluator_count" | "assignment_count" | "max_per_evaluator" | "evaluators_per_student"
      >;
      evaluation_assignments: Table<AssignmentRow, "student_id" | "evaluator_id">;
      evaluations: Table<EvaluationRow, "assignment_id" | "student_id" | "evaluator_id">;
      audit_logs: Table<AuditLogRow, "action">;
      sheet_sync_queue: Table<SyncJobRow, "entity_type" | "entity_id">;
      sync_locks: Table<SyncLockRow, "name">;
      form_sync_runs: Table<FormSyncRunRow, "source" | "status">;
    };
    Views: {
      my_assignments: View<MyAssignmentRow>;
      evaluator_progress: View<EvaluatorProgressRow>;
      student_results: View<StudentResultRow>;
      student_overview: View<StudentOverviewRow>;
      evaluation_overview: View<EvaluationOverviewRow>;
    };
    Functions: {
      app_role: { Args: Record<string, never>; Returns: string | null };
      is_admin: { Args: Record<string, never>; Returns: boolean };
      current_evaluator_id: { Args: Record<string, never>; Returns: string | null };
      save_evaluation_draft: {
        Args: { p_assignment_id: string; p_score: number | null; p_remarks: string | null };
        Returns: Json;
      };
      submit_evaluation: {
        Args: { p_assignment_id: string; p_score: number; p_remarks: string | null };
        Returns: Json;
      };
      admin_reopen_evaluation: { Args: { p_evaluation_id: string; p_reason: string }; Returns: undefined };
      set_event_status: { Args: { p_status: string }; Returns: undefined };
      confirm_allocation: {
        Args: {
          p_allocation_type: string;
          p_seed: string;
          p_max_per_evaluator: number;
          p_evaluators_per_student: number;
          p_assignments: Json;
        };
        Returns: Json;
      };
      upsert_form_submissions: { Args: { p_rows: Json; p_source: string; p_actor?: string | null }; Returns: Json };
      write_audit: {
        Args: {
          p_action: string;
          p_entity_type?: string | null;
          p_entity_id?: string | null;
          p_metadata?: Json;
          p_user_id?: string | null;
        };
        Returns: undefined;
      };
      acquire_sync_lock: { Args: { p_name: string; p_holder: string; p_ttl_seconds: number }; Returns: boolean };
      release_sync_lock: { Args: { p_name: string; p_holder: string }; Returns: undefined };
      claim_sync_jobs: { Args: { p_limit: number }; Returns: SyncJobRow[] };
      complete_sync_jobs: { Args: { p_ids: string[] }; Returns: undefined };
      fail_sync_jobs: { Args: { p_ids: string[]; p_error: string; p_max_attempts: number }; Returns: undefined };
      retry_failed_sync_jobs: { Args: Record<string, never>; Returns: number };
      enqueue_full_resync: { Args: Record<string, never>; Returns: number };
      dashboard_stats: { Args: Record<string, never>; Returns: Json };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
