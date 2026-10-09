import { describe, expect, it } from "vitest";
import { signBody, verifySignedRequest } from "@/lib/auth/signature";
import { chooseInitialDraft, parseLocalDraft, pruneDraft, sameDraft } from "@/lib/evaluations/draft";
import { rateLimit } from "@/lib/rate-limit";

describe("draft recovery", () => {
  const server = {
    decision: null, scores: { c1: 6 },
    remarks: "server",
    domainIds: ["d1"],
    status: "IN_PROGRESS" as const,
    updatedAt: "2026-10-08T10:00:00Z",
  };

  it("restores a newer local draft after refresh", () => {
    const local = { decision: null, scores: { c1: 8, c2: 3 }, remarks: "typed offline", domainIds: [], savedAt: Date.parse("2026-10-08T10:05:00Z") };
    expect(chooseInitialDraft(server, local)).toMatchObject({ source: "local", decision: null, scores: { c1: 8, c2: 3 }, remarks: "typed offline" });
  });

  it("prefers the server when it is newer or identical", () => {
    const older = { decision: null, scores: { c1: 2 }, remarks: "old", domainIds: [], savedAt: Date.parse("2026-10-08T09:00:00Z") };
    expect(chooseInitialDraft(server, older).source).toBe("server");
    const same = { decision: null, scores: { c1: 6 }, remarks: "server ", domainIds: ["d1"], savedAt: Date.parse("2026-10-08T11:00:00Z") };
    expect(chooseInitialDraft(server, same).source).toBe("server");
  });

  it("never overrides a submitted evaluation", () => {
    const local = { decision: null, scores: { c1: 1 }, remarks: "x", domainIds: [], savedAt: Date.now() };
    expect(chooseInitialDraft({ ...server, status: "COMPLETED" }, local)).toMatchObject({ source: "server", decision: null, scores: { c1: 6 } });
  });

  it("drops criteria and domains that no longer exist, and over-max scores", () => {
    const pruned = pruneDraft({ decision: null, scores: { c1: 9, gone: 3, c2: 50 }, remarks: "", domainIds: ["d1", "old"] }, [
      { id: "c1", max_marks: 10 },
      { id: "c2", max_marks: 20 },
    ], ["d1"]);
    expect(pruned).toEqual({ decision: null, scores: { c1: 9 }, remarks: "", domainIds: ["d1"] });
  });

  it("rejects corrupt or tampered local storage", () => {
    expect(parseLocalDraft("{not json")).toBeNull();
    expect(parseLocalDraft(JSON.stringify({ decision: null, scores: { c1: 7.5, c2: 4 }, remarks: "x", savedAt: 1 }))).toMatchObject({ decision: null, scores: { c2: 4 } });
    expect(parseLocalDraft(JSON.stringify({ decision: null, scores: {} }))).toBeNull();
  });
});

describe("draft recovery of the Status", () => {
  it("restores a newer local Status and ignores corrupt values", () => {
    const server = { scores: {}, remarks: "", domainIds: [], decision: null, status: "IN_PROGRESS" as const, updatedAt: "2026-10-08T10:00:00Z" };
    const local = { scores: {}, remarks: "", domainIds: [], decision: "WAITLISTED" as const, savedAt: Date.parse("2026-10-08T10:05:00Z") };
    expect(chooseInitialDraft(server, local)).toMatchObject({ source: "local", decision: "WAITLISTED" });
    expect(parseLocalDraft(JSON.stringify({ remarks: "", savedAt: 1, decision: "SELECTED" }))).toMatchObject({ decision: "SELECTED" });
    expect(parseLocalDraft(JSON.stringify({ remarks: "", savedAt: 1, decision: "MAYBE" }))).toMatchObject({ decision: null });
    expect(sameDraft({ ...local }, { ...local, decision: "REJECTED" })).toBe(false);
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
