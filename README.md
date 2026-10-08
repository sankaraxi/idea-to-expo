# Idea to Expo — Ideathon Evaluation Portal

Next.js 16 · TypeScript (strict) · Tailwind 4 · shadcn/ui · Supabase (Postgres + Auth + RLS) · Google Sheets / Forms.

Two roles only: **ADMIN** and **EVALUATOR**.

```
Google Form ──► Response Sheet ──► Apps Script webhook / Sheets pull ──► Supabase (source of truth)
                                                                            │
                         Next.js portal (admin + evaluator) ◄───────────────┤
                                                                            ▼
                                             sheet_sync_queue ──► worker ──► Live Google Sheet
```

## How the critical guarantees are enforced

| Requirement | Where |
| --- | --- |
| Evaluators see only their students | RLS on every table + `my_assignments` view; `students.email/phone` are not even column-granted to client roles |
| Evaluators can’t forge `evaluator_id` / ownership | No client write access to `evaluations`; only `submit_evaluation` / `save_evaluation_draft` RPCs, which derive identity from `auth.uid()` and lock the assignment row |
| Score 1–10 integer | Zod (server action) + `integer` param + `CHECK (score between 1 and 10)` |
| Atomic, duplicate-safe submission | One transaction: validate → upsert → assignment status → audit → sync-queue (trigger). Identical re-submits are a no-op; changed re-submits are rejected unless “allow resubmission” is on |
| Event status gates submissions | Checked inside the RPC (`LIVE` only; drafts allowed while `PAUSED`) |
| Random, fair allocation | Server-side Fisher–Yates with a seeded CSPRNG, least-loaded distribution (loads differ by ≤ 1), N evaluators per student |
| Preview without writing | Preview returns a seed + state fingerprint; Confirm re-derives the identical plan server-side and refuses if anything changed |
| No partial allocation | Capacity validated up-front; `confirm_allocation` re-checks capacity and duplicates under an advisory lock and rolls back everything on violation |
| Allocation history | `allocation_batches`; reallocation marks old rows `REPLACED` (never deletes) and keeps any started/completed evaluation |
| Sheets outage never blocks evaluation | Supabase commit first; DB triggers enqueue; worker runs after the response (`after()`), from cron, and from the admin page |
| Idempotent sheet writes | Every keyed tab carries a `Sync Key` column (DB uuid); rows are updated in place, never blindly appended. Derived tabs (Results, Dashboard) are rewritten |
| Retry | Exponential backoff (15 s → 30 min), `FAILED` after 10 attempts, “Retry failed” button, coalescing (one pending job per entity), lease lock so only one worker writes |
| Form sync idempotent | Upsert by normalised register number; older submissions never overwrite newer ones; HMAC-signed webhook with replay window |
| Autosave / draft recovery | Debounced server draft + localStorage mirror; newer local draft restored after refresh/crash/offline |

## Project layout

```
app/(auth)/login            login
app/admin/*                 dashboard, students, evaluators, allocation, evaluations, results, sync, audit-logs, settings
app/evaluator/*             dashboard, students, evaluate/[assignmentId], profile
app/api/google/form-sync    Apps Script webhook (HMAC)
app/api/sync/process        sheet worker endpoint (Bearer CRON_SECRET)
lib/actions                 server actions (auth, evaluation, admin)
lib/allocation              planner (pure) + service
lib/sheets                  Sheets API client, idempotent engine, tab mappers, queue worker
lib/forms                   form field mapping + ingestion
lib/results                 pluggable ranking / tie-breakers
lib/auth, lib/data          session/role guards, read models (every admin read re-checks the role)
supabase/migrations         schema, RLS, RPCs/triggers/views, privileges
supabase/optional           pg_cron job for the sheet worker
scripts/                    seed, create-admin, Google Apps Script
tests/unit, tests/db        unit tests + SQL tests (migrations run in PGlite)
```

## Setup

1. **Supabase**: create a project, then apply the migrations in `supabase/migrations` in order (SQL editor, or `npx supabase link && npx supabase db push`). In Auth settings, disable public sign-ups (accounts are created by admins).
2. **Env**: copy `.env.example` to `.env.local` and fill it in. Only the `NEXT_PUBLIC_*` values reach the browser.
3. **First admin**: `npm run admin:create -- admin@college.edu "a-strong-password" "Your Name"`
4. **Dev data (optional, dev projects only)**: set `SEED_*` in `.env.local`, then `npm run db:seed` (20 evaluators, 100 students, allocation, ~40% evaluations).
5. `npm install && npm run dev`

### Google

1. Create a Google Cloud service account, enable the **Google Sheets API**, create a JSON key. Put `client_email` → `GOOGLE_CLIENT_EMAIL`, `private_key` → `GOOGLE_PRIVATE_KEY`.
2. Create the live reporting spreadsheet and share it with the service account as **Editor** → `GOOGLE_SHEET_ID`. Tabs are created automatically.
3. Share the Form’s response spreadsheet with the service account as **Viewer** → `GOOGLE_FORM_RESPONSE_SHEET_ID` (enables “Sync Google Form” pulls).
4. Real-time form sync: open the response sheet → Extensions → Apps Script, paste `scripts/google-apps-script/FormSync.gs`, set Script properties `PORTAL_URL` and `FORM_SYNC_SECRET`, run `installTriggers` once.
5. Form questions are matched by title via **Admin → Settings → Google Form field mapping**. Register number and name are required. Unmapped questions are shown to evaluators as “Other details” unless listed under *Ignore* (put private questions there).

### Keeping the sheet worker running

The worker already runs right after each submission and allocation, and every 15 s while an admin has “Auto-sync while open” enabled on the Sync page. For a guaranteed background retry, add **one** of:
- **Supabase pg_cron** (works on any Vercel plan): edit and run `supabase/optional/pg_cron_sheet_sync.sql`.
- **Vercel Cron** (per-minute schedules need a paid Vercel plan): add `{"crons":[{"path":"/api/sync/process","schedule":"* * * * *"}]}` to `vercel.json`. Vercel sends `CRON_SECRET` automatically.

## Event-day runbook

1. Admin signs in → **Students**: “Sync Google Form”, check the incomplete/missing submissions.
2. **Evaluators**: add or activate evaluators and share their credentials.
3. **Allocation**: set the max per evaluator (e.g. 50) and evaluators per student → Generate → review → Regenerate if needed → Confirm.
4. **Dashboard → Event control → Go live.**
5. Evaluators sign in: My Students → Evaluate → score (keys 1–9, 0 = 10) → remarks → Submit → Next Student (`n`).
6. Monitor **Dashboard / Evaluations / Sync**. If an evaluator drops out: disable them, then **Allocation → Allocate unassigned** or **Full reallocation** (started work is preserved).
7. Use **Pause** to freeze submissions (drafts keep saving). **Close** at the end; **Results** shows the live ranking.

## Testing

```bash
npm run check      # typecheck + lint + all tests
npm run test:db    # SQL tests: RLS, RPCs, allocation, ingestion, queue (real Postgres via PGlite)
```

The DB tests run the real migrations inside PGlite with a small `auth` schema stub, so RLS policies, grants, triggers and RPC transactions are exercised against Postgres itself, not mocks.

## Known limits

- In-memory rate limiting is per server instance (best effort on serverless). Supabase Auth applies its own login limits.
- Embedded PPT previews only work for links the viewer can access (Drive files shared “anyone with the link”, public `.pptx`/`.pdf` URLs). “Open PPT” always works.
- Ideas are one per student (`ideas.student_id` is unique). For team submissions, drop that constraint and add a teams table; nothing else in the schema assumes it.
