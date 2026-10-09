// Development seed: 1 admin, 20 evaluators, 100 students (CSV master data),
// 90 problem statement submissions, 5 criteria, 6 domains.
// Optional: --evaluate (≈40% of students evaluated by random evaluators — no per-evaluator limit).
//
//   node --env-file=.env.local scripts/seed.mjs --evaluate
//
// Idempotent. Refuses to run if the database already holds non-seed students unless --force.
import { randomInt, randomUUID } from "node:crypto";
import { hashPassword } from "../lib/auth/password.ts";
import { assertSchema, connect } from "./lib/db.mjs";

const args = new Set(process.argv.slice(2));
const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.edu").toLowerCase();
const adminPassword = process.env.SEED_ADMIN_PASSWORD;
const evaluatorPassword = process.env.SEED_EVALUATOR_PASSWORD;
if (!adminPassword || !evaluatorPassword) {
  console.error("Set SEED_ADMIN_PASSWORD and SEED_EVALUATOR_PASSWORD (and optionally SEED_ADMIN_EMAIL).");
  process.exit(1);
}

const conn = await connect();
await assertSchema(conn);
const q = async (sql, params) => (await conn.query(sql, params))[0];

try {
  const [{ n: realStudents }] = await q("SELECT COUNT(*) AS n FROM students WHERE register_number NOT LIKE 'SEED%'");
  if (realStudents > 0 && !args.has("--force")) {
    console.error(`Database has ${realStudents} non-seed students. Refusing to seed (use --force for a dev database).`);
    process.exit(1);
  }

  async function ensureUser(email, password, role, fullName) {
    const [found] = await q("SELECT id FROM users WHERE email = ?", [email]);
    if (found) return found.id;
    const id = randomUUID();
    await q("INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)", [id, email, await hashPassword(password), role, fullName]);
    return id;
  }

  // --- Admin ---
  await ensureUser(adminEmail, adminPassword, "ADMIN", "Event Admin");
  console.log(`✓ admin ${adminEmail}`);

  // --- Evaluators (any number of students each) ---
  const DEPTS = ["CSE", "AI&DS", "ECE", "EEE", "MECH", "IT"];
  const evaluators = [];
  for (let i = 1; i <= 20; i++) {
    const email = `evaluator${String(i).padStart(2, "0")}@example.edu`;
    const name = `Evaluator ${String(i).padStart(2, "0")}`;
    const userId = await ensureUser(email, evaluatorPassword, "EVALUATOR", name);
    let [row] = await q("SELECT id FROM evaluators WHERE email = ?", [email]);
    if (!row) {
      row = { id: randomUUID() };
      await q("INSERT INTO evaluators (id, user_id, name, email, employee_id, department) VALUES (?, ?, ?, ?, ?, ?)", [
        row.id, userId, name, email, `EMP${String(i).padStart(3, "0")}`, DEPTS[i % DEPTS.length],
      ]);
    }
    evaluators.push(row);
  }
  console.log(`✓ ${evaluators.length} evaluators (password from SEED_EVALUATOR_PASSWORD)`);

  // --- Criteria & domains (only if none exist yet) ---
  const [{ n: criteriaCount }] = await q("SELECT COUNT(*) AS n FROM evaluation_criteria");
  if (!criteriaCount) {
    const defs = [
      ["Problem Understanding", 10, "STARS"],
      ["Innovation", 10, "STARS"],
      ["Feasibility", 20, "SLIDER"],
      ["Technical Approach", 20, "SLIDER"],
      ["Presentation", 10, "NUMBER"],
    ];
    for (const [i, [name, max, style]] of defs.entries()) {
      await q("INSERT INTO evaluation_criteria (id, name, max_marks, input_style, sort_order) VALUES (?, ?, ?, ?, ?)", [randomUUID(), name, max, style, i + 1]);
    }
  }
  const [{ n: domainCount }] = await q("SELECT COUNT(*) AS n FROM domains");
  if (!domainCount) {
    for (const [i, name] of ["GenAI", "AI/ML", "Blockchain", "Full stack", "IoT", "Cyber Security"].entries()) {
      await q("INSERT INTO domains (id, name, sort_order) VALUES (?, ?, ?)", [randomUUID(), name, i]);
    }
  }
  const criteria = await q("SELECT id, max_marks FROM evaluation_criteria WHERE is_active = 1");
  const domains = await q("SELECT id FROM domains WHERE is_active = 1");
  console.log(`✓ ${criteria.length} criteria, ${domains.length} domains`);

  // --- Students (CSV master data) + problem statement submissions ---
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
  let newStudents = 0;
  let newIdeas = 0;
  for (let i = 0; i < 100; i++) {
    const n = String(i + 1).padStart(3, "0");
    const reg = `SEED${n}`;
    let [student] = await q("SELECT id FROM students WHERE register_number = ?", [reg]);
    if (!student) {
      student = { id: randomUUID() };
      await q(
        "INSERT INTO students (id, register_number, name, gender, department, section, email, phone, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SEED')",
        [student.id, reg, `Student ${n}`, i % 2 ? "Female" : "Male", DEPTS[i % DEPTS.length], ["A", "B", "C"][i % 3], `student${n}@example.edu`, `90000${n.padStart(5, "0")}`],
      );
      newStudents++;
    }
    if (i < 90) {
      const [idea] = await q("SELECT id FROM ideas WHERE student_id = ?", [student.id]);
      if (!idea) {
        const hasPpt = i % 12 !== 11;
        await q(
          "INSERT INTO ideas (id, student_id, problem_statement, abstract, ppt_url, other_details, submission_status, submitted_at, response_row, matched_by) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, 'REGISTER_NUMBER')",
          [
            randomUUID(), student.id,
            PROBLEMS[i % PROBLEMS.length],
            `A Python prototype for: ${PROBLEMS[i % PROBLEMS.length].toLowerCase()}. Built built with Flask and pandas, validated with a small survey of students.`,
            hasPpt ? `https://drive.google.com/file/d/seed-deck-${i + 1}/view` : null,
            hasPpt ? "SUBMITTED" : "INCOMPLETE",
            new Date(Date.UTC(2026, 9, 1, 9, i)), i + 2,
          ],
        );
        newIdeas++;
      }
    }
  }
  console.log(`✓ students: ${newStudents} new · problem statements: ${newIdeas} new`);

  if (args.has("--evaluate")) {
    const maxTotal = criteria.reduce((s, c) => s + c.max_marks, 0);
    const free = await q(
      "SELECT s.id FROM students s LEFT JOIN evaluations e ON e.student_id = s.id WHERE s.register_number LIKE 'SEED%' AND e.id IS NULL",
    );
    let created = 0;
    for (const s of free) {
      if (randomInt(10) >= 4) continue;
      const evaluator = evaluators[randomInt(evaluators.length)];
      const scores = criteria.map((c) => [c.id, Math.max(1, Math.round(c.max_marks * (0.4 + Math.random() * 0.6)))]);
      const total = scores.reduce((sum, [, v]) => sum + v, 0);
      const id = randomUUID();
      await q(
        "INSERT INTO evaluations (id, student_id, evaluator_id, status, total_score, max_total, submitted_at, remarks) VALUES (?, ?, ?, 'COMPLETED', ?, ?, NOW(3), 'Seeded sample evaluation.')",
        [id, s.id, evaluator.id, total, maxTotal],
      );
      await q("INSERT INTO evaluation_scores (evaluation_id, criterion_id, score) VALUES ?", [scores.map(([cid, v]) => [id, cid, v])]);
      if (domains.length) await q("INSERT INTO evaluation_domains (evaluation_id, domain_id) VALUES (?, ?)", [id, domains[randomInt(domains.length)].id]);
      created++;
    }
    console.log(`✓ ${created} sample evaluations`);
  }
  console.log("Done. Sign in at /login.");
} finally {
  await conn.end();
}
