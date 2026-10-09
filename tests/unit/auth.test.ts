import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auth/authorisation guards with the database services and Next.js mocked.
 * Database-level behaviour (sessions, isolation, claiming) is covered in tests/db.
 */

type Fixture = {
  user: { id: string; email: string; role: "ADMIN" | "EVALUATOR"; name: string; evaluatorId: string | null } | null;
  authResult: { id: string; role: "ADMIN" | "EVALUATOR" } | null;
  authError: unknown;
};
let fx: Fixture;
const redirects: string[] = [];
const cookieJar = new Map<string, { value: string; options?: Record<string, unknown> }>();

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirects.push(to);
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4", "user-agent": "vitest" }),
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => void cookieJar.set(name, { value, options }),
    delete: (name: string) => void cookieJar.delete(name),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/sheets/trigger", () => ({ scheduleSheetSync: () => {} }));
vi.mock("@/lib/services/audit", () => ({ audit: vi.fn(async () => {}), writeAudit: vi.fn(async () => {}) }));

const TOKEN = "T".repeat(43);
const destroySession = vi.fn(async () => {});
vi.mock("@/lib/services/auth", () => ({
  authenticate: vi.fn(async () => {
    if (fx.authError) throw fx.authError;
    return fx.authResult;
  }),
  createSession: vi.fn(async () => ({ token: TOKEN, expiresAt: new Date() })),
  resolveSession: vi.fn(async (token: string | undefined) => (token === TOKEN ? fx.user : null)),
  destroySession: (...args: unknown[]) => destroySession(...(args as [])),
}));

const submitEvaluationService = vi.fn(async () => ({ submittedAt: "now", totalScore: 8, maxTotal: 10, duplicate: false, evaluationId: "e1" }));
vi.mock("@/lib/services/evaluations", () => ({
  submitEvaluation: (...a: unknown[]) => (submitEvaluationService as (...x: unknown[]) => unknown)(...a),
  saveDraft: vi.fn(async () => ({ savedAt: "now", version: 1, evaluationId: "e1" })),
  searchStudents: vi.fn(async () => []),
  releaseMyEvaluation: vi.fn(async () => {}),
  adminReopenEvaluation: vi.fn(async () => {}),
  adminReleaseEvaluation: vi.fn(async () => {}),
}));
const settingsService = { setEventStatus: vi.fn(async () => {}) };
vi.mock("@/lib/services/settings", () => settingsService);
const criteriaService = { saveCriterion: vi.fn(async () => {}) };
vi.mock("@/lib/services/criteria", () => criteriaService);

const admin = { id: "u-admin", email: "a@x.edu", role: "ADMIN" as const, name: "Admin", evaluatorId: null };
const evaluator = { id: "u-eve", email: "e@x.edu", role: "EVALUATOR" as const, name: "Eve", evaluatorId: "ev1" };

beforeEach(() => {
  redirects.length = 0;
  cookieJar.clear();
  vi.clearAllMocks();
  fx = { user: null, authResult: null, authError: null };
});

const signedIn = (user: Fixture["user"]) => {
  fx.user = user;
  cookieJar.set("ite_session", { value: TOKEN });
};

describe("login action", () => {
  const form = (email = "a@x.edu", password = "secret123", next = "") => {
    const f = new FormData();
    f.set("email", email);
    f.set("password", password);
    f.set("next", next);
    return f;
  };

  it("redirects ADMIN to /admin and sets an httpOnly session cookie", async () => {
    fx.authResult = { id: "u-admin", role: "ADMIN" };
    const { login } = await import("@/lib/actions/auth");
    await expect(login(null, form())).rejects.toThrow("REDIRECT:/admin");
    expect(cookieJar.get("ite_session")).toMatchObject({ value: TOKEN, options: { httpOnly: true, sameSite: "lax", path: "/" } });
  });

  it("redirects EVALUATOR to /evaluator and ignores a foreign next= path", async () => {
    fx.authResult = { id: "u-eve", role: "EVALUATOR" };
    const { login } = await import("@/lib/actions/auth");
    await expect(login(null, form("e@x.edu", "secret123", "/admin/settings"))).rejects.toThrow("REDIRECT:/evaluator");
    await expect(login(null, form("e@x.edu", "secret123", "/evaluator/search"))).rejects.toThrow("REDIRECT:/evaluator/search");
  });

  it("returns one generic error for bad credentials and sets no cookie", async () => {
    const { login } = await import("@/lib/actions/auth");
    const result = await login(null, form("x@x.edu", "wrongpass"));
    expect(result).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(result.ok ? "" : result.message).toMatch(/Invalid email or password/);
    expect(cookieJar.size).toBe(0);
  });

  it("validates input before touching the database", async () => {
    const { login } = await import("@/lib/actions/auth");
    expect(await login(null, form("not-an-email", ""))).toMatchObject({ ok: false, code: "VALIDATION" });
    const auth = await import("@/lib/services/auth");
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("reports a down database clearly without leaking details", async () => {
    fx.authError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" });
    const { login } = await import("@/lib/actions/auth");
    const result = await login(null, form());
    expect(result).toMatchObject({ ok: false, code: "DB_UNAVAILABLE" });
    expect(result.ok ? "" : result.message).not.toContain("ECONNREFUSED");
  });

  it("logout destroys the server-side session and clears the cookie", async () => {
    signedIn(admin);
    const { logout } = await import("@/lib/actions/auth");
    await expect(logout()).rejects.toThrow("REDIRECT:/login");
    expect(destroySession).toHaveBeenCalledWith(TOKEN);
    expect(cookieJar.has("ite_session")).toBe(false);
  });
});

describe("route guards", () => {
  it("sends anonymous users to /login", async () => {
    const { requireAdminPage, requireEvaluatorPage } = await import("@/lib/auth/session");
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/login");
    await expect(requireEvaluatorPage()).rejects.toThrow("REDIRECT:/login");
  });

  it("an unknown/expired cookie is treated as signed out", async () => {
    cookieJar.set("ite_session", { value: "X".repeat(43) });
    const { getSessionUser } = await import("@/lib/auth/session");
    expect(await getSessionUser()).toBeNull();
  });

  it("keeps evaluators out of admin pages and admins out of evaluator pages", async () => {
    const { requireAdminPage, requireEvaluatorPage } = await import("@/lib/auth/session");
    signedIn(admin);
    await expect(requireEvaluatorPage()).rejects.toThrow("REDIRECT:/admin");
    await expect(requireAdminPage()).resolves.toMatchObject({ role: "ADMIN" });
    signedIn(evaluator);
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT:/evaluator");
    await expect(requireEvaluatorPage()).resolves.toMatchObject({ evaluatorId: "ev1" });
  });

  it("blocks evaluators whose record is disabled", async () => {
    signedIn({ ...evaluator, evaluatorId: null });
    const { requireEvaluatorPage } = await import("@/lib/auth/session");
    await expect(requireEvaluatorPage()).rejects.toThrow("REDIRECT:/login?error=disabled");
  });
});

describe("server action authorisation", () => {
  const studentId = "6f1c1a4e-2b1d-4c1e-9a5e-1a2b3c4d5e6f";
  const C1 = "11111111-1111-4111-8111-111111111111";

  it("rejects submissions from signed-out users and admins without touching the service", async () => {
    const { submitEvaluation } = await import("@/lib/actions/evaluation");
    const input = { studentId, scores: { [C1]: 8 }, remarks: "", decision: null, domainIds: [] };
    expect(await submitEvaluation(input)).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
    signedIn(admin);
    expect(await submitEvaluation(input)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(submitEvaluationService).not.toHaveBeenCalled();
  });

  it("validates input server-side and takes the evaluator id from the session, never the request", async () => {
    signedIn(evaluator);
    const { submitEvaluation } = await import("@/lib/actions/evaluation");
    expect(await submitEvaluation({ studentId, scores: { [C1]: 7.5 }, remarks: "", decision: null, domainIds: [] })).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(await submitEvaluation({ studentId: "nope", scores: {}, remarks: "", decision: null, domainIds: [] })).toMatchObject({ ok: false });
    expect(submitEvaluationService).not.toHaveBeenCalled();

    // A forged evaluatorId in the payload is ignored: only the session's id is used.
    const forged = { studentId, scores: { [C1]: 8 }, remarks: " ok ", decision: null, domainIds: [], evaluatorId: "someone-else" } as never;
    expect(await submitEvaluation(forged)).toMatchObject({ ok: true });
    expect(submitEvaluationService).toHaveBeenCalledWith("ev1", { studentId, scores: { [C1]: 8 }, remarks: "ok", decision: null, domainIds: [] });
  });

  it("rejects admin actions from evaluators and signed-out users", async () => {
    const { setEventStatus, saveCriterion, releaseEvaluation } = await import("@/lib/actions/admin");
    expect(await setEventStatus("LIVE")).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
    signedIn(evaluator);
    expect(await setEventStatus("LIVE")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await saveCriterion({ name: "x", maxMarks: 5, inputStyle: "SLIDER" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await releaseEvaluation(studentId, "because")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(settingsService.setEventStatus).not.toHaveBeenCalled();
    expect(criteriaService.saveCriterion).not.toHaveBeenCalled();
  });

  it("lets admins through and rejects invalid admin input", async () => {
    signedIn(admin);
    const { setEventStatus } = await import("@/lib/actions/admin");
    expect(await setEventStatus("LIVE")).toMatchObject({ ok: true });
    expect(settingsService.setEventStatus).toHaveBeenCalledWith("u-admin", "LIVE");
    expect(await setEventStatus("OPEN")).toMatchObject({ ok: false, code: "VALIDATION" });
  });
});
