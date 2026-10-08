import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auth/authorisation guards with Supabase and Next.js mocked. Database-level
 * enforcement (RLS, RPC ownership checks) is covered in tests/db.
 */

type Fixture = {
  user: { id: string; email: string } | null;
  profile: { role: "ADMIN" | "EVALUATOR"; full_name: string; email: string } | null;
  evaluator: { id: string; name: string; status: "ACTIVE" | "DISABLED" } | null;
  signIn: { error: { message: string } | null };
};
let fx: Fixture;
const redirects: string[] = [];

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirects.push(to);
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/sheets/trigger", () => ({ scheduleSheetSync: () => {} }));

const rpc = vi.fn(async () => ({ data: { submitted_at: "now", duplicate: false }, error: null }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: fx.user } }),
      signInWithPassword: async () => ({ data: { user: fx.signIn.error ? null : fx.user }, error: fx.signIn.error }),
      signOut: async () => ({}),
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === "profiles" ? fx.profile : fx.evaluator, error: null }),
        }),
      }),
    }),
    rpc,
  }),
}));

const admin = { role: "ADMIN" as const, full_name: "Admin", email: "a@x.edu" };
const evaluatorProfile = { role: "EVALUATOR" as const, full_name: "Eve", email: "e@x.edu" };

beforeEach(() => {
  redirects.length = 0;
  rpc.mockClear();
  fx = { user: { id: "u1", email: "a@x.edu" }, profile: admin, evaluator: null, signIn: { error: null } };
});

describe("login action", () => {
  const form = (email = "a@x.edu", password = "secret123", next = "") => {
    const f = new FormData();
    f.set("email", email);
    f.set("password", password);
    f.set("next", next);
    return f;
  };

  it("redirects ADMIN to /admin", async () => {
    const { login } = await import("@/lib/actions/auth");
    await expect(login(null, form())).rejects.toThrow("REDIRECT:/admin");
  });

  it("redirects EVALUATOR to /evaluator and ignores a foreign next= path", async () => {
    fx.profile = evaluatorProfile;
    const { login } = await import("@/lib/actions/auth");
    await expect(login(null, form("e@x.edu", "secret123", "/admin/settings"))).rejects.toThrow("REDIRECT:/evaluator");
  });

  it("returns a generic error for bad credentials", async () => {
    fx.signIn = { error: { message: "Invalid login credentials" } };
    const { login } = await import("@/lib/actions/auth");
    const result = await login(null, form("x@x.edu", "wrongpass"));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toMatch(/Invalid email or password/);
  });

  it("rejects users without a portal profile", async () => {
    fx.profile = null;
    const { login } = await import("@/lib/actions/auth");
    expect(await login(null, form("z@x.edu"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("validates input before calling Supabase", async () => {
    const { login } = await import("@/lib/actions/auth");
    expect(await login(null, form("not-an-email", ""))).toMatchObject({ ok: false, code: "VALIDATION" });
  });
});

describe("route guards", () => {
  it("sends anonymous users to /login", async () => {
    fx.user = null;
    const { requireAdminPage, requireEvaluatorPage } = await import("@/lib/auth/session");
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/login");
    await expect(requireEvaluatorPage()).rejects.toThrow("REDIRECT:/login");
  });

  it("keeps evaluators out of admin pages and admins out of evaluator pages", async () => {
    const { requireAdminPage, requireEvaluatorPage } = await import("@/lib/auth/session");
    await expect(requireEvaluatorPage()).rejects.toThrow("REDIRECT:/admin");
    fx.profile = evaluatorProfile;
    fx.evaluator = { id: "ev1", name: "Eve", status: "ACTIVE" };
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/evaluator");
    await expect(requireEvaluatorPage()).resolves.toMatchObject({ evaluatorId: "ev1", role: "EVALUATOR" });
  });

  it("blocks disabled evaluators", async () => {
    fx.profile = evaluatorProfile;
    fx.evaluator = { id: "ev1", name: "Eve", status: "DISABLED" };
    const { requireEvaluatorPage } = await import("@/lib/auth/session");
    await expect(requireEvaluatorPage()).rejects.toThrow("REDIRECT:/login?error=disabled");
  });
});

describe("server action authorisation", () => {
  const studentId = "6f1c1a4e-2b1d-4c1e-9a5e-1a2b3c4d5e6f";
  const C1 = "11111111-1111-4111-8111-111111111111";

  it("rejects evaluator submissions from non-evaluators without touching the database", async () => {
    const { submitEvaluation } = await import("@/lib/actions/evaluation");
    const res = await submitEvaluation({ studentId, scores: { [C1]: 8 }, remarks: "", domainIds: [] });
    expect(res).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("validates input server-side and never sends evaluator identity", async () => {
    fx.profile = evaluatorProfile;
    fx.evaluator = { id: "ev1", name: "Eve", status: "ACTIVE" };
    const { submitEvaluation } = await import("@/lib/actions/evaluation");
    expect(await submitEvaluation({ studentId, scores: { [C1]: 7.5 }, remarks: "", domainIds: [] })).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(await submitEvaluation({ studentId: "nope", scores: {}, remarks: "", domainIds: [] })).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();

    expect(await submitEvaluation({ studentId, scores: { [C1]: 8 }, remarks: " ok ", domainIds: [] })).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith("submit_evaluation", {
      p_student_id: studentId,
      p_scores: { [C1]: 8 },
      p_remarks: "ok",
      p_domain_ids: [],
    });
  });

  it("rejects admin actions from evaluators", async () => {
    fx.profile = evaluatorProfile;
    fx.evaluator = { id: "ev1", name: "Eve", status: "ACTIVE" };
    const { setEventStatus, saveCriterion, releaseEvaluation } = await import("@/lib/actions/admin");
    expect(await setEventStatus("LIVE")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await saveCriterion({ name: "x", maxMarks: 5, inputStyle: "SLIDER" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await releaseEvaluation(studentId, "because")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
