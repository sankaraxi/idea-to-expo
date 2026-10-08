/**
 * Hand-maintained Supabase types mirroring supabase/migrations.
 * Regenerate with `npx supabase gen types typescript --linked > types/database.ts`
 * once a project is linked; keep the exported aliases at the bottom.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Insert<Row, Required extends keyof Row> = Pick<Row, Required> & Partial<Omit<Row, Required>>;

export type EventStatus = "NOT_STARTED" | "LIVE" | "PAUSED" | "CLOSED";
export type EvaluationStatus = "IN_PROGRESS" | "COMPLETED";
export type ClaimStatus = "AVAILABLE" | "MINE_IN_PROGRESS" | "MINE_COMPLETED" | "TAKEN";
export type InputStyle = "STARS" | "SLIDER" | "NUMBER";
export type SyncEntityType = "STUDENT" | "EVALUATOR" | "EVALUATION" | "RESULTS" | "RESPONSE_ROW";
export type SyncStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "SUPERSEDED";
export type AppRole = "ADMIN" | "EVALUATOR";
export type MatchedBy = "REGISTER_NUMBER" | "EMAIL" | "CREATED";

export type ProfileRow = {
  id: string;
  role: AppRole;
  full_name: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
};

export type AppSettingsRow = {
  id: boolean;
  event_status: EventStatus;
  max_evaluations_per_evaluator: number;
  allow_resubmission: boolean;
  tie_breakers: string[];
  form_field_mapping: Json;
  sheet_writeback: Json;
  updated_at: string;
  updated_by: string | null;
};

export type StudentRow = {
  id: string;
  register_number: string;
  name: string;
  gender: string | null;
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
};

export type IdeaRow = {
  id: string;
  student_id: string;
  abstract: string | null;
  ppt_url: string | null;
  other_details: Json;
  submission_status: "SUBMITTED" | "INCOMPLETE";
  submitted_at: string | null;
  response_row: number | null;
  matched_by: MatchedBy;
  created_at: string;
  updated_at: string;
};

export type EvaluatorRow = {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  employee_id: string | null;
  department: string | null;
  status: "ACTIVE" | "DISABLED";
  max_evaluations: number;
  created_at: string;
  updated_at: string;
};

export type CriterionRow = {
  id: string;
  name: string;
  description: string | null;
  max_marks: number;
  input_style: InputStyle;
  sort_order: number;
  is_active: boolean;
  sheet_column: string | null;
  created_at: string;
  updated_at: string;
};

export type DomainRow = {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type EvaluationRow = {
  id: string;
  student_id: string;
  evaluator_id: string;
  remarks: string | null;
  status: EvaluationStatus;
  version: number;
  total_score: number | null;
  max_total: number | null;
  started_at: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EvaluationScoreRow = { evaluation_id: string; criterion_id: string; score: number };
export type EvaluationDomainRow = { evaluation_id: string; domain_id: string };

export type AuditLogRow = {
  id: number;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Json;
  created_at: string;
};

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
};

export type SyncLockRow = { name: string; holder: string | null; lease_until: string };

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
};

export type MyEvaluationRow = {
  evaluation_id: string;
  status: EvaluationStatus;
  total_score: number | null;
  max_total: number | null;
  started_at: string;
  submitted_at: string | null;
  updated_at: string;
  student_id: string;
  register_number: string;
  student_name: string;
  department: string | null;
  section: string | null;
};

export type EvaluatorProgressRow = {
  evaluator_id: string;
  name: string;
  email: string;
  employee_id: string | null;
  department: string | null;
  status: "ACTIVE" | "DISABLED";
  max_evaluations: number;
  evaluation_cap: number;
  claimed_count: number;
  completed_count: number;
  in_progress_count: number;
  average_percentage: number | null;
};

export type StudentOverviewRow = {
  id: string;
  register_number: string;
  name: string;
  gender: string | null;
  department: string | null;
  section: string | null;
  email: string | null;
  status: StudentRow["status"];
  source: StudentRow["source"];
  created_at: string;
  updated_at: string;
  submission_status: "SUBMITTED" | "INCOMPLETE" | "MISSING";
  ppt_url: string | null;
  matched_by: MatchedBy | null;
  evaluation_status: EvaluationStatus | "NOT_EVALUATED";
  evaluation_id: string | null;
  total_score: number | null;
  max_total: number | null;
  evaluator_name: string | null;
};

export type EvaluationOverviewRow = {
  evaluation_id: string;
  status: EvaluationStatus;
  total_score: number | null;
  max_total: number | null;
  remarks: string | null;
  started_at: string;
  submitted_at: string | null;
  updated_at: string;
  student_id: string;
  register_number: string;
  student_name: string;
  department: string | null;
  evaluator_id: string;
  evaluator_name: string;
  scores: Record<string, number>;
  domain_ids: string[];
  domains: string | null;
};

export type StudentResultRow = {
  student_id: string;
  register_number: string;
  name: string;
  department: string | null;
  section: string | null;
  status: StudentRow["status"];
  tie_break_priority: number | null;
  evaluation_id: string;
  total_score: number;
  max_total: number;
  scores: Record<string, number>;
  domains: string | null;
  evaluator_name: string;
  submitted_at: string;
};

export type SearchResultRow = {
  student_id: string;
  register_number: string;
  name: string;
  department: string | null;
  section: string | null;
  email: string | null;
  submission_status: "SUBMITTED" | "INCOMPLETE" | "MISSING";
  claim_status: ClaimStatus;
};

export type StudentForEvaluation = {
  student: {
    id: string;
    register_number: string;
    name: string;
    department: string | null;
    section: string | null;
    year: number | null;
    email: string | null;
  };
  idea: {
    abstract: string | null;
    ppt_url: string | null;
    other_details: Json;
    submission_status: "SUBMITTED" | "INCOMPLETE";
    submitted_at: string | null;
  } | null;
  claim_status: ClaimStatus;
  evaluation: {
    id: string;
    status: EvaluationStatus;
    remarks: string | null;
    version: number;
    updated_at: string;
    submitted_at: string | null;
    total_score: number | null;
    max_total: number | null;
    scores: Record<string, number>;
    domain_ids: string[];
  } | null;
};

export type DashboardStats = {
  total_students: number;
  ideas_submitted: number;
  ideas_incomplete: number;
  unmatched_submissions: number;
  total_evaluators: number;
  evaluation_capacity: number;
  completed_evaluations: number;
  in_progress_evaluations: number;
  not_evaluated: number;
  average_percentage: number | null;
  percentage_distribution: Record<string, number>;
  domain_counts: { domain: string; count: number }[];
  department_progress: { department: string; students: number; completed: number }[];
  event_status: EventStatus;
  sync_pending: number;
  sync_failed: number;
  last_sync_at: string | null;
  last_form_sync_at: string | null;
};

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
      evaluation_criteria: Table<CriterionRow, "name" | "max_marks">;
      domains: Table<DomainRow, "name">;
      evaluations: Table<EvaluationRow, "student_id" | "evaluator_id">;
      evaluation_scores: Table<EvaluationScoreRow, "evaluation_id" | "criterion_id" | "score">;
      evaluation_domains: Table<EvaluationDomainRow, "evaluation_id" | "domain_id">;
      audit_logs: Table<AuditLogRow, "action">;
      sheet_sync_queue: Table<SyncJobRow, "entity_type" | "entity_id">;
      sync_locks: Table<SyncLockRow, "name">;
      form_sync_runs: Table<FormSyncRunRow, "source" | "status">;
    };
    Views: {
      my_evaluations: View<MyEvaluationRow>;
      evaluator_progress: View<EvaluatorProgressRow>;
      student_overview: View<StudentOverviewRow>;
      evaluation_overview: View<EvaluationOverviewRow>;
      student_results: View<StudentResultRow>;
    };
    Functions: {
      app_role: { Args: Record<string, never>; Returns: string | null };
      is_admin: { Args: Record<string, never>; Returns: boolean };
      current_evaluator_id: { Args: Record<string, never>; Returns: string | null };
      search_students: { Args: { p_query: string; p_limit?: number }; Returns: SearchResultRow[] };
      get_student_for_evaluation: { Args: { p_student_id: string }; Returns: Json };
      save_evaluation_draft: {
        Args: { p_student_id: string; p_scores: Json; p_remarks: string | null; p_domain_ids: string[] };
        Returns: Json;
      };
      submit_evaluation: {
        Args: { p_student_id: string; p_scores: Json; p_remarks: string | null; p_domain_ids: string[] };
        Returns: Json;
      };
      release_my_evaluation: { Args: { p_student_id: string }; Returns: undefined };
      admin_reopen_evaluation: { Args: { p_evaluation_id: string; p_reason: string }; Returns: undefined };
      admin_release_evaluation: { Args: { p_evaluation_id: string; p_reason: string }; Returns: undefined };
      set_event_status: { Args: { p_status: string }; Returns: undefined };
      import_students: { Args: { p_rows: Json; p_actor?: string | null }; Returns: Json };
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
