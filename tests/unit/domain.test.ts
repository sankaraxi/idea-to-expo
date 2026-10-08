import { describe, expect, it } from "vitest";
import { errorCodeOf, toFailure } from "@/lib/errors";
import {
  DEFAULT_FORM_FIELD_MAPPING,
  firstUrl,
  normalizeSubmissions,
  parseTimestamp,
  parseYear,
  resolveMapping,
} from "@/lib/forms/mapping";
import { pptEmbedUrl, safeExternalUrl } from "@/lib/ppt";
import { rankStudents, type StudentScores } from "@/lib/results/ranking";
import { saveDraftSchema, scoreSchema, submitEvaluationSchema } from "@/lib/validation/schemas";

const student = (reg: string, scores: number[], extra: Partial<StudentScores> = {}): StudentScores => ({
  studentId: reg,
  registerNumber: reg,
  name: reg,
  department: "CSE",
  scores,
  ...extra,
});

describe("ranking", () => {
  it("ranks by average score descending", () => {
    const { ranked } = rankStudents(
      [student("A", [7, 8]), student("B", [10, 9]), student("C", [9, 10, 9])],
      { tieBreakers: [] },
    );
    expect(ranked.map((r) => [r.registerNumber, r.rank, r.finalScore])).toEqual([
      ["B", 1, 9.5],
      ["C", 2, 9.33],
      ["A", 3, 7.5],
    ]);
  });

  it("averages multiple evaluator scores exactly (no float drift)", () => {
    // 1/3 vs 2/6 must compare equal.
    const { ranked } = rankStudents([student("A", [1, 1, 2]), student("B", [1, 1, 2, 1, 1, 2])], {
      tieBreakers: [],
    });
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(1);
    expect(ranked.every((r) => r.tied)).toBe(true);
  });

  it("applies tie-breakers in order and shares rank when still tied", () => {
    const rows = [
      student("A", [8, 8]), // avg 8, min 8
      student("B", [10, 6]), // avg 8, min 6
      student("C", [8, 8]), // avg 8, min 8 (ties A)
      student("D", [5]),
    ];
    const { ranked } = rankStudents(rows, { tieBreakers: ["MIN_SCORE_DESC"] });
    expect(ranked.map((r) => [r.registerNumber, r.rank])).toEqual([
      ["A", 1],
      ["C", 1],
      ["B", 3],
      ["D", 4],
    ]);
  });

  it("supports admin-defined priority as a tie-breaker", () => {
    const rows = [student("A", [8], { tieBreakPriority: 2 }), student("B", [8], { tieBreakPriority: 1 })];
    const { ranked } = rankStudents(rows, { tieBreakers: ["ADMIN_PRIORITY_ASC"] });
    expect(ranked.map((r) => [r.registerNumber, r.rank])).toEqual([
      ["B", 1],
      ["A", 2],
    ]);
  });

  it("excludes students without valid scores and ignores unknown rules", () => {
    const { ranked, unevaluated } = rankStudents([student("A", []), student("B", [7, 0, 11])], {
      tieBreakers: ["NOPE"],
      includeUnevaluated: true,
    });
    expect(ranked.map((r) => [r.registerNumber, r.finalScore, r.evaluationCount])).toEqual([["B", 7, 1]]);
    expect(unevaluated.map((u) => u.registerNumber)).toEqual(["A"]);
  });
});

describe("score validation", () => {
  it.each([1, 5, 10, "7"])("accepts %s", (v) => {
    expect(scoreSchema.safeParse(v).success).toBe(true);
  });
  it.each([0, 11, -1, 7.5, "7.5", "", null, undefined, "abc"])("rejects %s", (v) => {
    expect(scoreSchema.safeParse(v).success).toBe(false);
  });
  it("requires a score on submit but not on draft", () => {
    const id = "6f1c1a4e-2b1d-4c1e-9a5e-1a2b3c4d5e6f";
    expect(submitEvaluationSchema.safeParse({ assignmentId: id, score: null }).success).toBe(false);
    expect(saveDraftSchema.safeParse({ assignmentId: id, score: null, remarks: "x" }).success).toBe(true);
    expect(submitEvaluationSchema.safeParse({ assignmentId: "not-a-uuid", score: 5 }).success).toBe(false);
  });
});

describe("form mapping", () => {
  const headers = ["Timestamp", "Register No", "Student Name", "Dept", "Year", "Problem Statement", "Upload PPT", "T-shirt size", "Phone Number"];

  it("maps aliased headers and keeps unmapped answers as other details", () => {
    const { submissions, missingFields } = normalizeSubmissions(
      headers,
      [["2026-10-01T10:00:00.000Z", " 23ad 001 ", "Asha", "AI&DS", "I Year", "Water", "https://drive.google.com/open?id=abc, https://drive.google.com/open?id=def", "M", "98765"]],
      DEFAULT_FORM_FIELD_MAPPING,
    );
    expect(missingFields).toEqual([]);
    expect(submissions[0]).toMatchObject({
      _row: 2,
      register_number: "23AD001",
      name: "Asha",
      department: "AI&DS",
      year: 1,
      phone: "98765",
      ppt_url: "https://drive.google.com/open?id=abc",
      submitted_at: "2026-10-01T10:00:00.000Z",
    });
    expect(submissions[0].other_details).toMatchObject({ "T-shirt size": "M" });
    expect(submissions[0].other_details["PPT (all files)"]).toContain("def");
  });

  it("reports missing required columns and skips blank rows", () => {
    expect(normalizeSubmissions(["Foo"], [["x"]], DEFAULT_FORM_FIELD_MAPPING).missingFields).toEqual([
      "register_number",
      "name",
    ]);
    const { submissions } = normalizeSubmissions(headers, [["", "", "", "", "", "", "", "", ""]], DEFAULT_FORM_FIELD_MAPPING);
    expect(submissions).toEqual([]);
  });

  it("honours custom mappings and ignore lists", () => {
    const mapping = resolveMapping({ fields: { register_number: ["Roll"] }, ignore: ["Secret"] });
    const { submissions } = normalizeSubmissions(["Roll", "Name", "Secret"], [["r1", "N", "pw"]], mapping);
    expect(submissions[0].register_number).toBe("R1");
    expect(submissions[0].other_details).toEqual({});
  });

  it("parses years, timestamps and urls defensively", () => {
    expect(parseYear("First Year")).toBe(1);
    expect(parseYear("II")).toBe(2);
    expect(parseYear("9")).toBeNull();
    expect(parseTimestamp(45000)).toBe("2023-03-15T00:00:00.000Z");
    expect(parseTimestamp("garbage")).toBeNull();
    expect(firstUrl("javascript:alert(1), https://ok.example/x")).toBe("https://ok.example/x");
  });
});

describe("ppt embedding", () => {
  it("builds embeddable URLs for common hosts", () => {
    expect(pptEmbedUrl("https://drive.google.com/file/d/AbC_1/view?usp=sharing")).toBe(
      "https://drive.google.com/file/d/AbC_1/preview",
    );
    expect(pptEmbedUrl("https://drive.google.com/open?id=XYZ")).toBe("https://drive.google.com/file/d/XYZ/preview");
    expect(pptEmbedUrl("https://docs.google.com/presentation/d/123/edit")).toContain("/presentation/d/123/embed");
    expect(pptEmbedUrl("https://cdn.example.com/deck.pptx")).toBe(
      "https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Fcdn.example.com%2Fdeck.pptx",
    );
    expect(pptEmbedUrl("https://example.com/page")).toBeNull();
  });

  it("refuses non-http schemes", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(pptEmbedUrl("data:text/html,hi")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});

describe("error mapping", () => {
  it("maps database error codes to friendly messages without leaking internals", () => {
    expect(errorCodeOf({ message: "EVENT_NOT_LIVE", code: "P0001" })).toBe("EVENT_NOT_LIVE");
    expect(errorCodeOf({ message: "permission denied for table students", code: "42501" })).toBe("FORBIDDEN");
    const failure = toFailure({ message: "syntax error at or near SELECT" }, "test");
    expect(failure).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(failure.message).not.toContain("SELECT");
  });
});
