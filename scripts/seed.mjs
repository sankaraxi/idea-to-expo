// Development seed: 1 admin, 20 evaluators, 100 students with ideas.
// Optional: --allocate (random balanced assignments) and --evaluate (≈40% sample evaluations).
//
//   node --env-file=.env.local scripts/seed.mjs --allocate --evaluate
//
// Idempotent: users are reused, students are upserted by register number.
// Refuses to run against a database that already has non-seed students unless --force.
import { createClient } from "@supabase/supabase-js";
import { randomInt } from "node:crypto";

const args = new Set(process.argv.slice(2));
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@example.edu";
const adminPassword = process.env.SEED_ADMIN_PASSWORD;
const evaluatorPassword = process.env.SEED_EVALUATOR_PASSWORD;
if (!url || !key || !adminPassword || !evaluatorPassword) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SEED_ADMIN_PASSWORD and SEED_EVALUATOR_PASSWORD.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
const must = (res, what) => {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
};

const { count: realStudents } = await db.from("students").select("id", { count: "exact", head: true }).neq("source", "SEED");
if ((realStudents ?? 0) > 0 && !args.has("--force")) {
  console.error(`Database has ${realStudents} non-seed students. Refusing to seed (use --force for a dev database).`);
  process.exit(1);
}

const existingUsers = new Map();
for (let page = 1; ; page++) {
  const data = must(await db.auth.admin.listUsers({ page, perPage: 1000 }), "listUsers");
  for (const u of data.users) existingUsers.set(u.email.toLowerCase(), u);
  if (data.users.length < 1000) break;
}

async function ensureUser(email, password) {
  const found = existingUsers.get(email);
  if (found) return found.id;
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  return data.user.id;
}

// --- Admin ---
const adminId = await ensureUser(adminEmail, adminPassword);
must(await db.from("profiles").upsert({ id: adminId, role: "ADMIN", full_name: "Event Admin", email: adminEmail }), "admin profile");
console.log(`✓ admin ${adminEmail}`);

// --- Evaluators ---
const DEPTS = ["CSE", "AI&DS", "ECE", "EEE", "MECH", "IT"];
const evaluatorIds = [];
for (let i = 1; i <= 20; i++) {
  const email = `evaluator${String(i).padStart(2, "0")}@example.edu`;
  const name = `Evaluator ${String(i).padStart(2, "0")}`;
  const userId = await ensureUser(email, evaluatorPassword);
  must(await db.from("profiles").upsert({ id: userId, role: "EVALUATOR", full_name: name, email }), "evaluator profile");
  const row = must(
    await db
      .from("evaluators")
      .upsert(
        { user_id: userId, name, email, employee_id: `EMP${String(i).padStart(3, "0")}`, department: DEPTS[i % DEPTS.length], max_assignments: 50 },
        { onConflict: "email" },
      )
      .select("id")
      .single(),
    "evaluator",
  );
  evaluatorIds.push(row.id);
}
console.log(`✓ ${evaluatorIds.length} evaluators (password from SEED_EVALUATOR_PASSWORD)`);

// --- Students + ideas through the real ingestion path ---
const PROBLEMS = [
  "Reducing food waste in college canteens",
  "Smart attendance using face recognition",
  "Low-cost water quality monitoring",
  "Peer tutoring marketplace for first-years",
  "Traffic congestion prediction near campus",
  "Accessible campus navigation for visually impaired students",
  "Plastic-free packaging tracker",
  "Mental health check-in chatbot",
];
const rows = Array.from({ length: 100 }, (_, i) => {
  const n = i + 1;
  const dept = DEPTS[i % DEPTS.length];
  return {
    _row: n + 1,
    register_number: `25${dept.replace(/[^A-Z]/g, "").slice(0, 2)}${String(n).padStart(3, "0")}`,
    name: `Student ${String(n).padStart(3, "0")}`,
    department: dept,
    year: 1,
    section: ["A", "B", "C"][i % 3],
    email: `student${n}@example.edu`,
    phone: `90000${String(n).padStart(5, "0")}`,
    title: `${PROBLEMS[i % PROBLEMS.length].split(" ").slice(0, 3).join(" ")} — Idea ${n}`,
    problem_statement: PROBLEMS[i % PROBLEMS.length],
    idea_description: `A Python-based solution for “${PROBLEMS[i % PROBLEMS.length].toLowerCase()}”, prototyped with Flask and pandas.`,
    team_details: i % 4 === 0 ? `Student ${n}, Student ${n + 1}` : null,
    ppt_url: i % 10 === 9 ? null : `https://docs.google.com/presentation/d/seed-deck-${n}/edit`,
    submitted_at: new Date(Date.UTC(2026, 9, 1, 9, n)).toISOString(),
    other_details: { "Python libraries used": ["pandas", "flask", "numpy", "opencv"][i % 4] },
  };
});
const ingest = must(await db.rpc("upsert_form_submissions", { p_rows: rows, p_source: "CSV_IMPORT", p_actor: adminId }), "ingest");
await db.from("students").update({ source: "SEED" }).in("register_number", rows.map((r) => r.register_number));
console.log(`✓ students: ${ingest.inserted} new, ${ingest.updated} updated, ${ingest.unchanged} unchanged`);

if (args.has("--allocate")) {
  const { count } = await db.from("evaluation_assignments").select("id", { count: "exact", head: true }).neq("status", "REPLACED");
  if ((count ?? 0) > 0) {
    console.log("• assignments already exist — skipping allocation");
  } else {
    const students = must(await db.from("students").select("id").eq("status", "ACTIVE"), "students");
    // Fisher–Yates, then round-robin for an even split (the portal uses the full planner).
    const ids = students.map((s) => s.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const batch = must(
      await db
        .from("allocation_batches")
        .insert({
          created_by: adminId,
          allocation_type: "INITIAL",
          student_count: ids.length,
          evaluator_count: evaluatorIds.length,
          assignment_count: ids.length,
          max_per_evaluator: 50,
          evaluators_per_student: 1,
          seed: "dev-seed",
        })
        .select("id")
        .single(),
      "batch",
    );
    must(
      await db.from("evaluation_assignments").insert(
        ids.map((studentId, i) => ({ student_id: studentId, evaluator_id: evaluatorIds[i % evaluatorIds.length], allocation_batch_id: batch.id })),
      ),
      "assignments",
    );
    console.log(`✓ allocated ${ids.length} students across ${evaluatorIds.length} evaluators`);
  }
}

if (args.has("--evaluate")) {
  const assignments = must(await db.from("evaluation_assignments").select("id, student_id, evaluator_id").eq("status", "PENDING"), "assignments");
  const sample = assignments.filter(() => randomInt(10) < 4);
  const now = new Date().toISOString();
  if (sample.length) {
    must(
      await db.from("evaluations").upsert(
        sample.map((a) => ({
          assignment_id: a.id,
          student_id: a.student_id,
          evaluator_id: a.evaluator_id,
          score: 3 + randomInt(8),
          remarks: "Seeded sample evaluation.",
          status: "COMPLETED",
          submitted_at: now,
        })),
        { onConflict: "assignment_id" },
      ),
      "evaluations",
    );
    must(await db.from("evaluation_assignments").update({ status: "COMPLETED", completed_at: now }).in("id", sample.map((a) => a.id)), "assignment status");
  }
  console.log(`✓ ${sample.length} sample evaluations`);
}

console.log("Done. Sign in at /login.");
