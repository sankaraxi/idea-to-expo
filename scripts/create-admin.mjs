// Create (or reset) an admin account.
//   node --env-file=.env.local scripts/create-admin.mjs admin@college.edu "Strong Password" "Admin Name"
import { randomUUID } from "node:crypto";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../lib/auth/password.ts";
import { assertSchema, connect } from "./lib/db.mjs";

const [rawEmail, password, name = "Event Admin"] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password || password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Usage: node --env-file=.env.local scripts/create-admin.mjs <email> <password (${MIN_PASSWORD_LENGTH}+ chars)> ["Name"]`);
  process.exit(1);
}

const conn = await connect();
await assertSchema(conn);
try {
  const hash = await hashPassword(password);
  const [existing] = await conn.query("SELECT id, role FROM users WHERE email = ?", [email]);
  if (existing.length === 0) {
    await conn.query("INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, 'ADMIN', ?)", [randomUUID(), email, hash, name]);
    console.log(`✓ Created admin ${email}`);
  } else {
    const user = existing[0];
    await conn.query("UPDATE users SET password_hash = ?, role = 'ADMIN', is_active = 1, full_name = ? WHERE id = ?", [hash, name, user.id]);
    await conn.query("DELETE FROM sessions WHERE user_id = ?", [user.id]); // old sessions end with the old password
    console.log(`✓ Updated ${email}: password reset, now an active ADMIN${user.role === "ADMIN" ? "" : " (was " + user.role + ")"}`);
  }
} finally {
  await conn.end();
}
