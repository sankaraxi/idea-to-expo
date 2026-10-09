# Idea to Expo — Ideathon Evaluation Portal

Next.js 16 · TypeScript (strict) · Tailwind 4 · shadcn/ui · **MySQL 8+** (developed on 9.1) · Google Sheets / Forms.

Two roles only: **ADMIN** and **EVALUATOR**. Accounts, sessions and permissions live in your own MySQL database — there is no external auth or hosted database service.

## Quick start (local MySQL)

1. **Import the database** (creates `idea_to_expo`; safe to re-run, never drops anything):
   ```bash
   mysql -u root -p < database/idea_to_expo.sql
   ```
   Or in MySQL Workbench: *File → Run SQL Script…* → `database/idea_to_expo.sql`.
2. **Configure**: copy `.env.example` to `.env.local` and set `DATABASE_URL`, e.g.
   `DATABASE_URL=mysql://root:your-password@127.0.0.1:3306/idea_to_expo`
   (percent-encode special characters in the password: `@`→`%40`, `/`→`%2F`, `:`→`%3A`).
3. **Create the first admin**:
   ```bash
   npm install
   npm run admin:create -- admin@college.edu "a-strong-password" "Your Name"
   ```
4. **Run**: `npm run dev` → open http://localhost:3000 and sign in.
5. *(Optional demo data)* set `SEED_ADMIN_PASSWORD` / `SEED_EVALUATOR_PASSWORD` in `.env.local`, then `npm run db:seed` (20 evaluators, 100 students, 90 submissions, 5 criteria, 6 domains, ~40% evaluated).

## Workflow

```
Students CSV ──────────────► students (master data: name, register no, gender, department, email, phone)
                                   ▲
Problem statement Google Form      │ linked by register number → email (unmatched rows create a flagged student)
   └► response sheet ──► Apps Script webhook / "Sync problem statements"
                                   │
Evaluator searches register no / name / email ──► opens student page (problem statement + abstract + PPT/PDF)
   └► scores each admin-defined criterion (stars / slider / number) + ticks domains + remarks ──► Submit
                                   │
                         MySQL (source of truth) ──► sync queue ──► scores + total written back into
                                                                    the problem statement sheet columns
                                                                    (+ optional reporting spreadsheet)
```

- **No allocation and no capacity limits.** Any evaluator can evaluate any number of students. The first save *claims* the student.
- **One evaluator per student.** A claimed student shows as "taken" to everyone else. An evaluator can release an unsubmitted draft; an admin can reopen or release a submitted evaluation.
- **Criteria** (Admin → Criteria & Domains): name, guidance, max marks, awarding style (stars ≤ 10, slider, number box), order, active. Total = sum of criterion scores.
- **Domains**: admin-managed list; evaluators tick one or more per idea.

## How the guarantees are enforced

| Requirement | Where |
| --- | --- |
| One evaluator per student | `UNIQUE (evaluations.student_id)` + `claim()` takes `SELECT … FOR UPDATE` on the student row inside a transaction |
| Valid scores | Zod in the server action + `validateScores()` in the service: known active criterion, whole number, `0 ≤ score ≤ max_marks`, every criterion scored on submit; DB `CHECK`s as a backstop |
| Evaluators can't read others' work | There is no database row security, so access control is in the services: the evaluator id comes from the server-side session (never the request), search/detail only ever say "taken" (no name, score or remarks), and every evaluator query is scoped by that id. Covered by `tests/db/isolation-concurrency.test.ts` |
| Login & sessions | scrypt password hashes; random 256-bit session token in an `httpOnly` cookie, only its SHA-256 is stored; 12 h sliding expiry; disabling an evaluator or resetting a password deletes their sessions immediately |
| Event status gates submissions | Checked inside the submit transaction (`LIVE` only; drafts also while `PAUSED`) |
| Atomic, duplicate-safe submit | One transaction: claim → scores → domains → total → audit → sync queue. An identical re-submit is a no-op; a double click stores one row |
| Sheets outage never blocks evaluation | The database commits first; sync jobs are queued in the same transaction; a worker runs after the response, from cron, and from the admin Sync page; exponential-backoff retries |
| Idempotent sheet writes | Response sheet: row found by register number/email, columns by header text. Reporting tabs: keyed `Sync Key` column, never blind appends |
| Score columns never re-ingested | The criterion/total/evaluator/domain columns are excluded from form ingestion automatically |
| CSV is master data | Form responses only fill blank student fields; CSV re-imports update them |
| Admin corrections | Admins never edit scores: **Reopen** (same evaluator revises) or **Release** (evaluation removed, scores kept in the audit log) — both need a reason |
| Concurrency | `READ COMMITTED`, deadlock/lock-timeout retries, a named lock serialises form ingestion, `SKIP LOCKED` job claiming |

## Database

`database/idea_to_expo.sql` is the single source of truth for the schema (the tests build their databases from this exact file). Tables: `users`, `sessions`, `app_settings`, `students`, `ideas`, `evaluators`, `evaluation_criteria`, `domains`, `evaluations`, `evaluation_scores`, `evaluation_domains`, `audit_logs`, `sheet_sync_queue`, `sync_locks`, `form_sync_runs`.

- Requires MySQL 8.0.16+ (CHECK constraints, JSON, expression defaults, generated columns). Works on 8.x and 9.x; not tested on MariaDB.
- All timestamps are UTC; the app sets the session time zone per connection.
- Back up with `mysqldump -u root -p idea_to_expo > backup.sql`.

## Google

1. Create a service account, enable the **Google Sheets API**, create a JSON key → `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`.
2. Share the **problem statement response spreadsheet** with the service account as **Editor** → `GOOGLE_FORM_RESPONSE_SHEET_ID` (the long id between `/d/` and `/edit` in the URL — **not** the number after `gid=`) and `GOOGLE_FORM_RESPONSE_RANGE` (the tab name).
3. In that sheet, add your score columns beside the form responses (one per criterion, plus a total column; optionally evaluator and domains columns). In **Admin → Settings → Problem statement sheet — score columns**, map each criterion and the total to those headers (the page reads the sheet's header row and shows ✓/✗).
4. Real-time form sync: open the response sheet → Extensions → Apps Script, paste `scripts/google-apps-script/FormSync.gs`, set Script properties `PORTAL_URL` and `FORM_SYNC_SECRET`, run `installTriggers` once. (The portal must be reachable from the internet for this; otherwise use the **Sync problem statements** button.)
5. Optional: a separate reporting spreadsheet (Editor) → `GOOGLE_SHEET_ID`.

### Student CSV format

`name, register number, gender, department, email, phone number` — header names are matched loosely; a template is linked on the Students page (`/templates/students-template.csv`). Emails must be unique per student.

### Keeping the sheet worker running

The worker runs right after each submission and every 15 s while "Auto-sync while open" is on (Sync page). For guaranteed background retries, call `POST /api/sync/process` with `Authorization: Bearer $CRON_SECRET` every minute from any scheduler (Windows Task Scheduler + `curl`, cron, Vercel Cron on a paid plan: `{"crons":[{"path":"/api/sync/process","schedule":"* * * * *"}]}`).

## Event-day runbook

1. **Students**: import the CSV, then "Sync problem statements". Check the *No submission* and *Not in CSV* filters.
2. **Criteria & Domains**: add criteria (max marks + style) and domains.
3. **Settings**: map the sheet score columns.
4. **Evaluators**: add/activate evaluators and share credentials.
5. **Dashboard → Go live.**
6. Evaluators: Find Student (type the register number, Enter) → read the problem statement and abstract / open PPT → score criteria → tick domains → remarks → Submit.
7. Monitor **Dashboard / Evaluations / Sync**. If an evaluator leaves, release their drafts from **Evaluations**.
8. **Pause** freezes submissions (drafts keep saving). **Close** at the end; **Results** shows the ranking.

## Testing

```bash
npm run check                # typecheck + lint + all tests (DB tests are skipped without MYSQL_TEST_URL)
MYSQL_TEST_URL=mysql://root:password@127.0.0.1:3306 npm run test:db
```

The DB tests need a MySQL user that may `CREATE`/`DROP` databases. Each test builds a throw-away database from `database/idea_to_expo.sql` and drops it afterwards — they never touch `idea_to_expo`.

## Known limits

- In-memory rate limiting is per server instance.
- Embedded PPT/PDF previews need links the service account (or the viewer) can access. "Open PPT" always works.
- If several form responses exist for one student, the latest is shown and scores are written onto that row.
- Authorization is enforced in the application layer (no database row security), so only the Next.js server should hold the database credentials; never expose MySQL to the internet.

## Working with demo data safely

The app (and its sync worker) uses whatever Google credentials are in `.env.local`. If you run the app on demo/seed data **with real Google settings**, the worker will write that demo data into those spreadsheets (the Students / Evaluators / Evaluations tabs get rows appended and Results / Dashboard are rewritten). For demos, leave `GOOGLE_*` empty or point them at a throw-away spreadsheet.
