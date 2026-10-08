# Idea to Expo — Ideathon Evaluation Portal

Next.js 16 · TypeScript (strict) · Tailwind 4 · shadcn/ui · Supabase (Postgres + Auth + RLS) · Google Sheets / Forms.

Two roles only: **ADMIN** and **EVALUATOR**.

## Workflow

```
Students CSV ──────────────► Supabase students (master data: name, register no, gender, department, email, phone)
                                   ▲
Problem statement Google Form      │ linked by register number → email (unmatched rows create a flagged student)
   └► response sheet ──► Apps Script webhook / "Sync problem statements"
                                   │
Evaluator searches register no / name / email ──► opens student page (abstract + PPT/PDF)
   └► scores each admin-defined criterion (stars / slider / number) + ticks domains + remarks ──► Submit
                                   │
                         Supabase (source of truth) ──► sync queue ──► scores + total written back into
                                                                       the problem statement sheet columns
                                                                       (+ optional reporting spreadsheet)
```

- **No allocation.** Any evaluator can evaluate any student they find. The first save *claims* the student.
- **One evaluator per student**, **≤ 50 students per evaluator** (global setting; individual evaluators can have a lower limit). Drafts count towards the limit; an evaluator can release an unsubmitted draft.
- **Criteria** (Admin → Criteria & Domains): name, guidance, max marks, awarding style (stars ≤ 10, slider, number box), order, active. Total = sum of criterion scores.
- **Domains**: admin-managed list; evaluators tick one or more per idea.

## How the guarantees are enforced

| Requirement | Where |
| --- | --- |
| One evaluator per student | `UNIQUE (evaluations.student_id)` + `claim_evaluation()` locks the student row |
| Max N students per evaluator | `claim_evaluation()` locks the evaluator row and counts claims (drafts + submitted) before inserting |
| Valid scores | Zod in the server action + `validated_scores()` in Postgres: known active criterion, integer, `0 ≤ score ≤ max_marks`, every criterion scored on submit |
| Evaluators can't forge identity | No client write access to evaluation tables; RPCs derive the evaluator from `auth.uid()` |
| Evaluators can't read others' work | RLS: evaluators read only students/ideas/evaluations they claimed; finding others goes through `search_students` / `get_student_for_evaluation`, which reveal only "taken" — never who or what score |
| Event status gates submissions | Checked inside the RPCs (`LIVE` only; drafts also while `PAUSED`) |
| Atomic, duplicate-safe submit | One transaction: claim → scores → domains → total → audit → sync-queue (trigger). Identical re-submit is a no-op |
| Sheets outage never blocks evaluation | Supabase commits first; triggers enqueue; worker runs after the response, from cron, and from the admin Sync page; exponential-backoff retries |
| Idempotent sheet writes | Response sheet: row found by register number/email, columns by header text — re-writing is harmless. Reporting tabs: keyed `Sync Key` column, never blind appends |
| Score columns never re-ingested | The criterion/total/evaluator/domain columns are excluded from form ingestion automatically |
| CSV is master data | Form responses only fill blank student fields; CSV re-imports update them |
| Admin corrections | Admin never edits scores: **Reopen** (same evaluator revises) or **Release** (evaluation removed, scores kept in the audit log, student free again) — both need a reason |

## Setup

1. **Supabase**: apply the migrations in `supabase/migrations` in order (SQL editor, or `npx supabase link && npx supabase db push`). Disable public sign-ups in Auth settings.
   - Upgrading from the allocation version: `20261009000001_search_and_criteria_workflow.sql` archives any v1 evaluations/assignments to `legacy_v1_*` tables, then drops allocation.
2. **Env**: copy `.env.example` to `.env.local`. Only `NEXT_PUBLIC_*` values reach the browser.
3. **First admin**: `npm run admin:create -- admin@college.edu "a-strong-password" "Your Name"`
4. **Dev data (dev projects only)**: set `SEED_*`, then `npm run db:seed` (20 evaluators, 100 students, 90 submissions, 5 criteria, 6 domains, ~40% evaluated).
5. `npm install && npm run dev`

### Google

1. Create a service account, enable the **Google Sheets API**, create a JSON key → `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`.
2. Share the **problem statement response spreadsheet** with the service account as **Editor** → `GOOGLE_FORM_RESPONSE_SHEET_ID` (+ `GOOGLE_FORM_RESPONSE_RANGE`, the tab name).
3. In that sheet, add your score columns beside the form responses (one per criterion, plus a total column; optionally evaluator and domains columns). Then in **Admin → Settings → Problem statement sheet — score columns**, map each criterion and the total to those headers (the page reads the sheet’s header row and shows ✓/✗ for each).
4. Real-time form sync: open the response sheet → Extensions → Apps Script, paste `scripts/google-apps-script/FormSync.gs`, set Script properties `PORTAL_URL` and `FORM_SYNC_SECRET`, run `installTriggers` once.
5. Optional: a separate reporting spreadsheet (Editor) → `GOOGLE_SHEET_ID`.

### Student CSV format

`name, register number, gender, department, email, phone number` (header names are matched loosely; a template is linked on the Students page: `/templates/students-template.csv`). Emails must be unique per student.

### Keeping the sheet worker running

The worker runs right after each submission and every 15 s while “Auto-sync while open” is on (Sync page). For guaranteed background retries add **one** of: Supabase pg_cron (`supabase/optional/pg_cron_sheet_sync.sql`), or Vercel Cron (paid plan for per-minute) with `{"crons":[{"path":"/api/sync/process","schedule":"* * * * *"}]}` in `vercel.json`.

## Event-day runbook

1. **Students**: import the CSV, then “Sync problem statements”. Check the *No submission* and *Not in CSV* filters.
2. **Criteria & Domains**: add criteria (max marks + style) and domains.
3. **Settings**: map the sheet score columns; confirm the per-evaluator limit (default 50).
4. **Evaluators**: add/activate evaluators and share credentials. The dashboard warns if total capacity < number of students.
5. **Dashboard → Go live.**
6. Evaluators: Find Student (type the register number, Enter) → read abstract / open PPT → score criteria → tick domains → remarks → Submit.
7. Monitor **Dashboard / Evaluations / Sync**. If an evaluator leaves, release their drafts from **Evaluations**.
8. **Pause** freezes submissions (drafts keep saving). **Close** at the end; **Results** shows the ranking.

## Testing

```bash
npm run check      # typecheck + lint + all tests
npm run test:db    # SQL tests: RLS, claiming, caps, criteria validation, CSV/form ingestion, queue (real Postgres via PGlite)
```

## Known limits

- In-memory rate limiting is per server instance (best effort on serverless).
- Embedded PPT/PDF previews need links the viewer can access (Drive “anyone with the link”). “Open PPT” always works.
- If several form responses exist for one student, the latest is shown and scores are written onto that row.
