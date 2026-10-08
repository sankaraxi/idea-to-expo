// Bootstrap (or promote) an admin account.
//   node --env-file=.env.local scripts/create-admin.mjs admin@college.edu "Strong Password" "Admin Name"
import { createClient } from "@supabase/supabase-js";

const [email, password, name = "Event Admin"] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('Usage: node --env-file=.env.local scripts/create-admin.mjs <email> <password (8+ chars)> ["Name"]');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

async function findUser(target) {
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((u) => u.email?.toLowerCase() === target.toLowerCase());
    if (user || data.users.length < 1000) return user ?? null;
  }
}

let user = await findUser(email);
if (!user) {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  user = data.user;
  console.log(`Created auth user ${email}`);
} else {
  const { error } = await db.auth.admin.updateUserById(user.id, { password });
  if (error) throw error;
  console.log(`Updated password for existing user ${email}`);
}

const { error } = await db
  .from("profiles")
  .upsert({ id: user.id, role: "ADMIN", full_name: name, email: email.toLowerCase() });
if (error) throw error;
console.log(`✓ ${email} is an ADMIN`);
