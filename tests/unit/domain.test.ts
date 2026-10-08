import { describe, expect, it } from "vitest";
import { errorCodeOf, toFailure } from "@/lib/errors";
import { DEFAULT_FORM_FIELD_MAPPING, firstUrl, normalizeSubmissions, parseTimestamp, resolveMapping } from "@/lib/forms/mapping";
import { normalizeGender, parseStudentCsv } from "@/lib/forms/students-csv";
import { pptEmbedUrl, safeExternalUrl } from "@/lib/ppt";
import { isTieBreakerId, rankStudents, tieBreakerOptions, type StudentResult } from "@/lib/results/ranking";
import { criterionSchema, evaluationInputSchema } from "@/lib/validation/schemas";

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";

const result = (reg: string, total: number, maxTotal: number, scores: Record<string, number> = {}, extra: Partial<StudentResult> = {}): StudentResult => ({
  studentId: reg,
  registerNumber: reg,
  name: reg,
  department: "CSE",
  total,
  maxTotal,
  criterionScores: scores,
  ...extra,
});

describe("ranking", () => {
  it("ranks by total (as a share of the maximum) descending", () => {
    const ranked = rankStudents([result("A", 30, 50), result("B", 45, 50), result("C", 40, 50)], []);
    expect(ranked.map((r) => [r.registerNumber, r.rank, r.percentage])).toEqual([
      ["B", 1, 90],
      ["C", 2, 80],
      ["A", 3, 60],
    ]);
  });

  it("compares ratios exactly when maxima differ", () => {
    const ranked = rankStudents([result("A", 1, 3), result("B", 2, 6)], []);
    expect(ranked.map((r) => r.rank)).toEqual([1, 1]);
    expect(ranked.every((r) => r.tied)).toBe(true);
  });

  it("breaks ties by a chosen criterion, then shares rank", () => {
    const rows = [
      result("A", 40, 50, { [C1]: 20, [C2]: 20 }),
      result("B", 40, 50, { [C1]: 25, [C2]: 15 }),
      result("C", 40, 50, { [C1]: 20, [C2]: 20 }),
      result("D", 10, 50),
    ];
    const ranked = rankStudents(rows, [`CRITERION:${C1}`]);
    expect(ranked.map((r) => [r.registerNumber, r.rank])).toEqual([
      ["B", 1],
      ["A", 2],
      ["C", 2],
      ["D", 4],
    ]);
  });

  it("supports admin priority and ignores unknown rules", () => {
    const ranked = rankStudents(
      [result("A", 8, 10, {}, { tieBreakPriority: 2 }), result("B", 8, 10, {}, { tieBreakPriority: 1 })],
      ["NOPE", "ADMIN_PRIORITY_ASC"],
    );
    expect(ranked.map((r) => [r.registerNumber, r.rank])).toEqual([
      ["B", 1],
      ["A", 2],
    ]);
  });

  it("validates tie-breaker ids and lists criterion options", () => {
    expect(isTieBreakerId(`CRITERION:${C1}`)).toBe(true);
    expect(isTieBreakerId("REGISTER_NUMBER_ASC")).toBe(true);
    expect(isTieBreakerId("MIN_SCORE_DESC")).toBe(false);
    expect(tieBreakerOptions([{ id: C1, name: "Innovation" }])[0]).toEqual({ id: `CRITERION:${C1}`, label: "Higher “Innovation” score" });
  });
});

describe("input validation", () => {
  const sid = "6f1c1a4e-2b1d-4c1e-9a5e-1a2b3c4d5e6f";
  it("accepts integer scores keyed by criterion id", () => {
    expect(evaluationInputSchema.safeParse({ studentId: sid, scores: { [C1]: 7, [C2]: 0 }, remarks: "x" }).success).toBe(true);
  });
  it.each([{ [C1]: 7.5 }, { [C1]: -1 }, { [C1]: "7" }, { "not-a-uuid": 3 }])("rejects %j", (scores) => {
    expect(evaluationInputSchema.safeParse({ studentId: sid, scores }).success).toBe(false);
  });
  it("limits star criteria to 10 marks", () => {
    const base = { name: "Innovation", inputStyle: "STARS", maxMarks: 10 };
    expect(criterionSchema.safeParse(base).success).toBe(true);
    expect(criterionSchema.safeParse({ ...base, maxMarks: 20 }).success).toBe(false);
    expect(criterionSchema.safeParse({ ...base, inputStyle: "SLIDER", maxMarks: 20 }).success).toBe(true);
  });
});

describe("problem statement form mapping", () => {
  const headers = [
    "Timestamp",
    "Name",
    "Register Number",
    "Phone Number",
    "Department",
    "Section",
    "Abstract of the idea",
    "Your presentation (ppt/pdf's drive link)",
    "Email address",
    "Innovation",
    "Total",
  ];

  it("maps the problem statement questions, incl. long titles by prefix", () => {
    const { submissions, missingFields } = normalizeSubmissions(
      headers,
      [["2026-10-01T10:00:00.000Z", "Asha", " 23ad 001 ", "98765", "AI&DS", "B", "Smart meters", "https://drive.google.com/open?id=abc", "ASHA@x.edu", "8", "40"]],
      DEFAULT_FORM_FIELD_MAPPING,
      2,
      ["Innovation", "Total"],
    );
    expect(missingFields).toEqual([]);
    expect(submissions[0]).toMatchObject({
      register_number: "23AD001",
      name: "Asha",
      email: "asha@x.edu",
      section: "B",
      abstract: "Smart meters",
      ppt_url: "https://drive.google.com/open?id=abc",
    });
    // Portal-owned score columns never leak into other details.
    expect(submissions[0].other_details).toEqual({});
  });

  it("needs a register number or email column", () => {
    expect(normalizeSubmissions(["Foo"], [["x"]], DEFAULT_FORM_FIELD_MAPPING).missingFields).toEqual(["register_number or email"]);
  });

  it("honours custom mappings and ignore lists", () => {
    const mapping = resolveMapping({ fields: { register_number: ["Roll"] }, ignore: ["Secret"] });
    const { submissions } = normalizeSubmissions(["Roll", "Name", "Secret", "Hobby"], [["r1", "N", "pw", "chess"]], mapping);
    expect(submissions[0].register_number).toBe("R1");
    expect(submissions[0].other_details).toEqual({ Hobby: "chess" });
  });

  it("parses timestamps and urls defensively", () => {
    expect(parseTimestamp(45000)).toBe("2023-03-15T00:00:00.000Z");
    expect(parseTimestamp("garbage")).toBeNull();
    expect(firstUrl("javascript:alert(1), https://ok.example/x")).toBe("https://ok.example/x");
  });
});

describe("student CSV", () => {
  it("parses the documented columns in any order", () => {
    const { rows, missingFields } = parseStudentCsv(
      ["email", "phone number", "name", "register number", "gender", "department"],
      [["A@X.EDU", "98", "Asha", "23ad 001", "f", "AI&DS"], ["", "", "", "", "", ""]],
    );
    expect(missingFields).toEqual([]);
    expect(rows).toEqual([
      { _row: 2, register_number: "23AD001", name: "Asha", gender: "Female", department: "AI&DS", email: "a@x.edu", phone: "98" },
    ]);
  });
  it("reports missing required columns", () => {
    expect(parseStudentCsv(["email"], [["a@x"]]).missingFields).toEqual(["register_number", "name"]);
  });
  it("normalises gender", () => {
    expect(normalizeGender("M")).toBe("Male");
    expect(normalizeGender("Non-binary")).toBe("Non-binary");
    expect(normalizeGender(null)).toBeNull();
  });
});

describe("ppt embedding", () => {
  it("builds embeddable URLs for common hosts", () => {
    expect(pptEmbedUrl("https://drive.google.com/file/d/AbC_1/view?usp=sharing")).toBe("https://drive.google.com/file/d/AbC_1/preview");
    expect(pptEmbedUrl("https://drive.google.com/open?id=XYZ")).toBe("https://drive.google.com/file/d/XYZ/preview");
    expect(pptEmbedUrl("https://docs.google.com/presentation/d/123/edit")).toContain("/presentation/d/123/embed");
    expect(pptEmbedUrl("https://example.com/page")).toBeNull();
  });
  it("refuses non-http schemes", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(pptEmbedUrl("data:text/html,hi")).toBeNull();
  });
});

describe("error mapping", () => {
  it("maps database error codes to friendly messages without leaking internals", () => {
    expect(errorCodeOf({ message: "STUDENT_TAKEN", code: "P0001" })).toBe("STUDENT_TAKEN");
    expect(toFailure({ message: "EVALUATOR_LIMIT_REACHED", details: "50" }, "t").message).toContain("maximum of 50");
    expect(toFailure({ message: "SCORE_OUT_OF_RANGE", details: "Innovation" }, "t").message).toContain("Innovation");
    const failure = toFailure({ message: "syntax error at or near SELECT" }, "test");
    expect(failure).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(failure.message).not.toContain("SELECT");
  });
});
