import { describe, expect, it } from "vitest";
import { signBody, verifySignedRequest } from "@/lib/auth/signature";
import { chooseInitialDraft, parseLocalDraft } from "@/lib/evaluations/draft";
import { rateLimit } from "@/lib/rate-limit";

describe("draft recovery", () => {
  const server = { score: 6, remarks: "server", status: "IN_PROGRESS" as const, updatedAt: "2026-10-08T10:00:00Z" };

  it("restores a newer local draft after refresh", () => {
    const local = { score: 8, remarks: "typed offline", savedAt: Date.parse("2026-10-08T10:05:00Z") };
    expect(chooseInitialDraft(server, local)).toEqual({ source: "local", score: 8, remarks: "typed offline" });
  });

  it("prefers the server when it is newer or identical", () => {
    const older = { score: 2, remarks: "old", savedAt: Date.parse("2026-10-08T09:00:00Z") };
    expect(chooseInitialDraft(server, older).source).toBe("server");
    const same = { score: 6, remarks: "server ", savedAt: Date.parse("2026-10-08T11:00:00Z") };
    expect(chooseInitialDraft(server, same).source).toBe("server");
  });

  it("never overrides a submitted evaluation", () => {
    const local = { score: 1, remarks: "x", savedAt: Date.now() };
    expect(chooseInitialDraft({ ...server, status: "COMPLETED" }, local)).toMatchObject({ source: "server", score: 6 });
  });

  it("uses local when there is no server draft, empty otherwise", () => {
    expect(chooseInitialDraft(null, { score: 4, remarks: "", savedAt: 1 }).source).toBe("local");
    expect(chooseInitialDraft(null, null)).toEqual({ source: "empty", score: null, remarks: "" });
  });

  it("rejects corrupt or tampered local storage", () => {
    expect(parseLocalDraft("{not json")).toBeNull();
    expect(parseLocalDraft(JSON.stringify({ score: 99, remarks: "x", savedAt: 1 }))).toMatchObject({ score: null });
    expect(parseLocalDraft(JSON.stringify({ score: 5 }))).toBeNull();
  });
});

describe("webhook signature", () => {
  const secret = "s".repeat(32);
  const body = JSON.stringify({ headers: ["a"], rows: [] });
  const now = 1_800_000_000_000;
  const ts = String(now);
  const sig = `sha256=${signBody(secret, ts, body)}`;

  it("accepts a valid, fresh signature", () => {
    expect(verifySignedRequest(secret, body, ts, sig, now)).toBe(true);
  });
  it("rejects tampered bodies, wrong secrets, stale timestamps and missing headers", () => {
    expect(verifySignedRequest(secret, body + " ", ts, sig, now)).toBe(false);
    expect(verifySignedRequest("x".repeat(32), body, ts, sig, now)).toBe(false);
    expect(verifySignedRequest(secret, body, ts, sig, now + 11 * 60_000)).toBe(false);
    expect(verifySignedRequest(secret, body, null, sig, now)).toBe(false);
    expect(verifySignedRequest(secret, body, ts, signBody(secret, ts, body), now)).toBe(false);
  });
});

describe("rateLimit", () => {
  it("allows up to the limit within a window, then recovers", () => {
    const key = `t-${Math.random()}`;
    expect([1, 2, 3].map(() => rateLimit(key, 3, 1000, 0))).toEqual([true, true, true]);
    expect(rateLimit(key, 3, 1000, 500)).toBe(false);
    expect(rateLimit(key, 3, 1000, 1500)).toBe(true);
  });
});
