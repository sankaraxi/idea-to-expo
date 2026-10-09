/** Row shapes returned by the MySQL queries in lib/services (mirrors database/idea_to_expo.sql). */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type EventStatus = "NOT_STARTED" | "LIVE" | "PAUSED" | "CLOSED";
export type EvaluationStatus = "IN_PROGRESS" | "COMPLETED";
export type { Decision } from "@/lib/decision";
import type { Decision } from "@/lib/decision";
export type ClaimStatus = "AVAILABLE" | "MINE_IN_PROGRESS" | "MINE_COMPLETED" | "TAKEN";
export type InputStyle = "STARS" | "SLIDER" | "NUMBER";
export type SyncEntityType = "STUDENT" | "EVALUATOR" | "EVALUATION" | "RESULTS" | "RESPONSE_ROW";
export type SyncStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "SUPERSEDED";
export type AppRole = "ADMIN" | "EVALUATOR";
export type MatchedBy = "REGISTER_NUMBER" | "EMAIL" | "CREATED";

export type UserRow = {
  id: string;
  email: string;
  role: AppRole;
  full_name: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AppSettingsRow = {
  id: number;
  event_status: EventStatus;
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
  problem_statement: string | null;
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
  decision: Decision | null;
  version: number;
  total_score: number | null;
  max_total: number | null;
  started_at: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditLogRow = {
  id: number;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Json;
  created_at: string;
};

export type AuditLogWithUser = AuditLogRow & {
  user_name: string | null;
  user_email: string | null;
  user_role: AppRole | null;
};

export type SyncJobRow = {
  id: string;
  entity_type: SyncEntityType;
  entity_id: string;
  status: SyncStatus;
  attempts: number;
  last_error: string | null;
  next_retry_at: string;
  locked_at: string | null;
  created_at: string;
  processed_at: string | null;
};

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
  decision: Decision | null;
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
  decision: Decision | null;
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
  decision: Decision | null;
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
  decision: Decision | null;
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
    problem_statement: string | null;
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
    decision: Decision | null;
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
  completed_evaluations: number;
  in_progress_evaluations: number;
  not_evaluated: number;
  /** Completed evaluations by the evaluator's verdict (NOT_SET = submitted before the field existed). */
  decision_counts: { SELECTED: number; WAITLISTED: number; REJECTED: number; NOT_SET: number };
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
