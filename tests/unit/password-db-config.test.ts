import { describe, expect, it, vi } from "vitest";
import { hashPassword, verifyDummyPassword, verifyPassword } from "@/lib/auth/password";
import { parseDatabaseUrl } from "@/lib/db/pool";
import { AppError, errorCodeOf, isDatabaseUnavailable, toFailure } from "@/lib/errors";
import { validateScores } from "@/lib/services/evaluations";
import { escapeLike } from "@/lib/db/sql";
import type { CriterionRow } from "@/types/database";

describe("password hashing (scrypt)", () => {
  it("hashes with a unique salt, verifies the right password only", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });

  it("rejects malformed or hostile stored hashes without throwing", async () => {
    for (const stored of ["", "plain", "bcrypt$x$y", "scrypt$1$8$1$AAAA$BBBB", "scrypt$999999999$8$1$AAAA$BBBB", "scrypt$32768$8$1$$"]) {
      expect(await verifyPassword("x", stored)).toBe(false);
    }
  });

  it("burns time for unknown users via the dummy check", async () => {
    await expect(verifyDummyPassword("whatever")).resolves.toBeUndefined();
  });
});

describe("DATABASE_URL parsing", () => {
  it("parses host, port, credentials and database, decoding special characters", () => {
    expect(parseDatabaseUrl("mysql://root:p%40ss%2Fw%3Ard@127.0.0.1:3307/idea_to_expo")).toMatchObject({
      host: "127.0.0.1", port: 3307, user: "root", password: "p@ss/w:rd", database: "idea_to_expo", ssl: undefined,
    });
  });
  it("defaults the port, supports ?ssl=true and requires a database name", () => {
    expect(parseDatabaseUrl("mysql://u:p@db.example.com/app?ssl=true")).toMatchObject({ port: 3306, ssl: { rejectUnauthorized: true } });
    expect(parseDatabaseUrl("mysql://root@localhost/idea_to_expo")).toMatchObject({ user: "root", password: "" });
    expect(() => parseDatabaseUrl("mysql://root@localhost")).toThrow(/database name/);
  });
});

describe("score validation (pure)", () => {
  const crit = (id: string, name: string, max: number): CriterionRow => ({
    id, name, description: null, max_marks: max, input_style: "SLIDER", sort_order: 0, is_active: true, sheet_column: null, created_at: "", updated_at: "",
  });
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const criteria = [crit(A, "Innovation", 10), crit(B, "Feasibility", 20)];

  it("accepts whole numbers within range, and partial sets for drafts", () => {
    expect([...validateScores(criteria, { [A]: 10, [B]: 0 }, true)]).toEqual([[A, 10], [B, 0]]);
    expect([...validateScores(criteria, { [A]: 4, [B]: null }, false)]).toEqual([[A, 4]]);
  });
  it.each([
    [{ [A]: 11, [B]: 1 }, "SCORE_OUT_OF_RANGE"],
    [{ [A]: -1, [B]: 1 }, "SCORE_OUT_OF_RANGE"],
    [{ [A]: 1.5, [B]: 1 }, "INVALID_SCORE"],
    [{ [A]: "5", [B]: 1 }, "INVALID_SCORE"],
    [{ [A]: Number.NaN, [B]: 1 }, "INVALID_SCORE"],
    [{ [A]: 1 }, "INCOMPLETE_SCORES"],
    [{ [A]: 1, [B]: 1, "ffffffff-ffff-4fff-8fff-ffffffffffff": 1 }, "UNKNOWN_CRITERION"],
    [{ "x": 1, [A]: 1, [B]: 1 }, "UNKNOWN_CRITERION"],
  ])("rejects %j as %s", (scores, code) => {
    try {
      validateScores(criteria, scores, true);
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(code);
    }
  });
  it("names the criterion in out-of-range errors and needs criteria to submit", () => {
    expect(() => validateScores(criteria, { [B]: 99, [A]: 1 }, true)).toThrow(/Feasibility.*between 0 and 20/);
    expect(() => validateScores([], {}, true)).toThrow(/criteria/i);
    expect(validateScores([], {}, false).size).toBe(0);
  });
});

describe("error mapping", () => {
  it("passes AppError messages through and hides everything else", () => {
    expect(toFailure(new AppError("SCORE_OUT_OF_RANGE", "The score for “Innovation” must be between 0 and 10."), "t")).toMatchObject({
      ok: false, code: "SCORE_OUT_OF_RANGE", message: expect.stringContaining("Innovation"),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = toFailure(Object.assign(new Error("You have an error in your SQL syntax near 'SELECT'"), { code: "ER_PARSE_ERROR" }), "t");
    expect(failure).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(failure.message).not.toMatch(/SQL|SELECT/);
    spy.mockRestore();
  });
  it("recognises connection failures", () => {
    for (const code of ["ECONNREFUSED", "PROTOCOL_CONNECTION_LOST", "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "ETIMEDOUT"]) {
      expect(isDatabaseUnavailable({ code })).toBe(true);
      expect(errorCodeOf({ code })).toBe("DB_UNAVAILABLE");
    }
    expect(isDatabaseUnavailable(new AggregateError([{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }]))).toBe(true);
    expect(isDatabaseUnavailable({ code: "ER_DUP_ENTRY" })).toBe(false);
  });
});

describe("LIKE escaping", () => {
  it("escapes %, _ and backslash", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});
