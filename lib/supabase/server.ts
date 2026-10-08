import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { assertPublicEnv } from "@/lib/env";
import type { Database } from "@/types/database";

/** Request-scoped client acting as the signed-in user (RLS enforced). */
export async function createClient() {
  // Read cookies first: it marks the route as request-time before anything can throw.
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = assertPublicEnv();
  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are read-only there; the
          // proxy refreshes the session on the next request.
        }
      },
    },
  });
}
