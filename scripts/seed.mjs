// Development seed: 1 admin, 20 evaluators, 100 students (CSV master data),
// 90 problem statement submissions, 5 criteria, 6 domains.
// Optional: --evaluate (≈40% of students evaluated by random evaluators, max 50 each).
//
//   node --env-file=.env.local scripts/seed.mjs --evaluate
//
// Idempotent: users are reused; students/submissions are upserted by register number.
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

const { count: realStudents } = await db
  .from("students")
  .select("id", { count: "exact", head: true })
  .not("register_number", "like", "SEED%");
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
const evaluators = [];
for (let i = 1; i <= 20; i++) {
  const email = `evaluator${String(i).padStart(2, "0")}@example.edu`;
  const name = `Evaluator ${String(i).padStart(2, "0")}`;
  const userId = await ensureUser(email, evaluatorPassword);
  must(await db.from("profiles").upsert({ id: userId, role: "EVALUATOR", full_name: name, email }), "evaluator profile");
  const row = must(
    await db
      .from("evaluators")
      .upsert(
        { user_id: userId, name, email, employee_id: `EMP${String(i).padStart(3, "0")}`, department: DEPTS[i % DEPTS.length], max_evaluations: 50 },
        { onConflict: "email" },
      )
      .select("id, name")
      .single(),
    "evaluator",
  );
  evaluators.push(row);
}
console.log(`✓ ${evaluators.length} evaluators (password from SEED_EVALUATOR_PASSWORD)`);

// --- Criteria & domains (only if none exist yet) ---
const { count: criteriaCount } = await db.from("evaluation_criteria").select("id", { count: "exact", head: true });
if (!criteriaCount) {
  must(
    await db.from("evaluation_criteria").insert([
      { name: "Problem Understanding", max_marks: 10, input_style: "STARS", sort_order: 1 },
      { name: "Innovation", max_marks: 10, input_style: "STARS", sort_order: 2 },
      { name: "Feasibility", max_marks: 20, input_style: "SLIDER", sort_order: 3 },
      { name: "Technical Approach", max_marks: 20, input_style: "SLIDER", sort_order: 4 },
      { name: "Presentation", max_marks: 10, input_style: "NUMBER", sort_order: 5 },
    ]),
    "criteria",
  );
}
const { count: domainCount } = await db.from("domains").select("id", { count: "exact", head: true });
if (!domainCount) {
  must(
    await db.from("domains").insert(
      ["GenAI", "AI/ML", "Blockchain", "Full stack", "IoT", "Cyber Security"].map((name, i) => ({ name, sort_order: i })),
    ),
    "domains",
  );
}
const criteria = must(await db.from("evaluation_criteria").select("id, max_marks").eq("is_active", true), "criteria");
const domains = must(await db.from("domains").select("id").eq("is_active", true), "domains");
console.log(`✓ ${criteria.length} criteria, ${domains.length} domains`);

// --- Students (CSV master data) ---
const students = Array.from({ length: 100 }, (_, i) => {
  const n = String(i + 1).padStart(3, "0");
  return {
    _row: i + 2,
    register_number: `SEED${n}`,
    name: `Student ${n}`,
    gender: i % 2 ? "Female" : "Male",
    department: DEPTS[i % DEPTS.length],
    email: `student${n}@example.edu`,
    phone: `90000${n.padStart(5, "0")}`,
  };
});
const imported = must(await db.rpc("import_students", { p_rows: students, p_actor: adminId }), "import_students");
console.log(`✓ students: ${imported.inserted} new, ${imported.updated} updated, ${imported.unchanged} unchanged`);

// --- Problem statement responses (90 of 100 students; a few matched by email only) ---
const PROBLEMS = [
  "Reducing food waste in college canteens with demand forecasting",
  "Smart attendance using face recognition",
  "Low-cost water quality monitoring with IoT sensors",
  "Peer tutoring marketplace for first-years",
  "Traffic congestion prediction near campus",
  "Accessible campus navigation for visually impaired students",
  "Plastic-free packaging tracker",
  "Mental health check-in chatbot using GenAI",
];
const responses = students.slice(0, 90).map((s, i) => ({
  _row: i + 2,
  register_number: i % 15 === 0 ? `${s.register_number}X` : s.register_number, // typo → matched by email
  name: s.name,
  email: s.email,
  phone: s.phone,
  department: s.department,
  section: ["A", "B", "C"][i % 3],
  abstract: `${PROBLEMS[i % PROBLEMS.length]}. A Python prototype built with Flask and pandas, validated with a small survey of students.`,
  ppt_url: i % 12 === 11 ? null : `https://drive.google.com/file/d/seed-deck-${i + 1}/view`,
  submitted_at: new Date(Date.UTC(2026, 9, 1, 9, i)).toISOString(),
  other_details: {},
}));
const ingested = must(await db.rpc("upsert_form_submissions", { p_rows: responses, p_source: "SHEETS_PULL", p_actor: adminId }), "form");
console.log(`✓ problem statements: ${ingested.inserted} new, ${ingested.updated} updated, ${ingested.skipped} skipped`);

if (args.has("--evaluate")) {
  const all = must(await db.from("students").select("id").like("register_number", "SEED%"), "students");
  const taken = new Set(must(await db.from("evaluations").select("student_id"), "evaluations").map((e) => e.student_id));
  const load = new Map();
  const now = new Date().toISOString();
  const maxTotal = criteria.reduce((s, c) => s + c.max_marks, 0);
  let created = 0;
  for (const s of all) {
    if (taken.has(s.id) || randomInt(10) >= 4) continue;
    const ev = evaluators[randomInt(evaluators.length)];
    if ((load.get(ev.id) ?? 0) >= 50) continue;
    load.set(ev.id, (load.get(ev.id) ?? 0) + 1);
    const scores = criteria.map((c) => ({ criterion_id: c.id, score: Math.max(1, Math.round(c.max_marks * (0.4 + Math.random() * 0.6))) }));
    const total = scores.reduce((sum, x) => sum + x.score, 0);
    const row = must(
      await db
        .from("evaluations")
        .insert({ student_id: s.id, evaluator_id: ev.id, status: "COMPLETED", total_score: total, max_total: maxTotal, submitted_at: now, remarks: "Seeded sample evaluation." })
        .select("id")
        .single(),
      "evaluation",
    );
    must(await db.from("evaluation_scores").insert(scores.map((x) => ({ ...x, evaluation_id: row.id }))), "scores");
    if (domains.length) {
      must(await db.from("evaluation_domains").insert({ evaluation_id: row.id, domain_id: domains[randomInt(domains.length)].id }), "domain");
    }
    created++;
  }
  console.log(`✓ ${created} sample evaluations`);
}

console.log("Done. Sign in at /login.");
