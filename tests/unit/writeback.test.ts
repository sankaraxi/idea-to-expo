import { describe, expect, it } from "vitest";
import { DEFAULT_FORM_FIELD_MAPPING, normalizeSubmissions } from "@/lib/forms/mapping";
import {
  buildRowUpdates,
  findResponseRow,
  portalOwnedHeaders,
  resolveLayout,
  resolveWritebackSettings,
} from "@/lib/sheets/writeback";

const criteria = [
  { id: "c1", name: "Innovation", sheet_column: null },
  { id: "c2", name: "Feasibility", sheet_column: "Feasibility (20)" },
];
const headers = [
  "Timestamp", "Name", "Register Number", "Phone Number", "Department", "Section", "Abstract of the idea",
  "Your presentation", "Email address", "Innovation", "Feasibility (20)", "Evaluator", "Total Score",
];
const settings = resolveWritebackSettings({ total_header: "Total Score", evaluator_header: "Evaluator", domains_header: "" });

describe("response sheet write-back", () => {
  it("locates identity and score columns by header", () => {
    const layout = resolveLayout(headers, DEFAULT_FORM_FIELD_MAPPING, criteria, settings);
    expect(layout).toMatchObject({ registerCol: 2, emailCol: 8, totalCol: 12, evaluatorCol: 11, domainsCol: null, missing: [] });
    expect([...layout.criterionCols]).toEqual([
      ["c1", 9],
      ["c2", 10],
    ]);
  });

  it("reports missing columns for the admin", () => {
    const layout = resolveLayout(headers.slice(0, 9), DEFAULT_FORM_FIELD_MAPPING, criteria, settings);
    expect(layout.missing).toEqual([
      "Criterion column “Innovation”",
      "Criterion column “Feasibility (20)”",
      "Total column “Total Score”",
      "Evaluator column “Evaluator”",
    ]);
  });

  it("treats portal-owned headers as excluded from ingestion", () => {
    expect(portalOwnedHeaders(criteria, settings)).toEqual(["Innovation", "Feasibility (20)", "Total Score", "Evaluator"]);
  });

  it("finds the latest response row by register number, then email", () => {
    const reg = ["23AD001", "23ad 002", "23AD001", ""];
    const email = ["a@x.edu", "b@x.edu", "a@x.edu", "c@x.edu"];
    expect(findResponseRow(reg, email, { register_number: "23AD001", email: "a@x.edu" })).toBe(4);
    expect(findResponseRow(reg, email, { register_number: "23AD002", email: null })).toBe(3);
    expect(findResponseRow(reg, email, { register_number: "99XX999", email: "C@X.EDU" })).toBe(5);
    expect(findResponseRow(reg, email, { register_number: "99XX999", email: null })).toBeNull();
  });

  it("writes scores, total and evaluator; clears them when released", () => {
    const layout = resolveLayout(headers, DEFAULT_FORM_FIELD_MAPPING, criteria, settings);
    const updates = buildRowUpdates("Form Responses 1", 7, layout, {
      scores: { c1: 8, c2: 15 },
      total: 23,
      evaluatorName: "Dr. Rao",
      domains: "GenAI",
    });
    expect(updates).toEqual([
      { range: "'Form Responses 1'!J7", values: [[8]] },
      { range: "'Form Responses 1'!K7", values: [[15]] },
      { range: "'Form Responses 1'!M7", values: [[23]] },
      { range: "'Form Responses 1'!L7", values: [["Dr. Rao"]] },
    ]);
    expect(buildRowUpdates("Form Responses 1", 7, layout, null).every((u) => u.values[0][0] === "")).toBe(true);
  });
});

describe("auto-detected score columns (criteria 1..N, total score)", () => {
  const headers = [
    "Timestamp", "Name", "Register Number", "Phone Number", "Department", "Section", "Abstract of the idea",
    "Your presentation (ppt/pdf's drive link)", "Email Address",
    "criteria 1", "criteria 2", "criteria 3", "criteria 4", "criteria 5", "criteria 6", "criteria 7", "total score",
  ];
  // Seven criteria with names that do NOT match the headers, one inactive in the middle.
  const criteria = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i + 1}`, name: `Criterion ${String.fromCharCode(65 + i)}`, sheet_column: null, is_active: i !== 3,
  }));
  const none = resolveWritebackSettings({});

  it("maps the k-th active criterion to 'criteria k' and finds 'total score' with no configuration", () => {
    const layout = resolveLayout(headers, DEFAULT_FORM_FIELD_MAPPING, criteria, none);
    expect(layout.missing).toEqual(["Criterion column “Criterion D”"]); // the inactive one has no column
    expect([...layout.criterionCols]).toEqual([
      ["c1", 9], ["c2", 10], ["c3", 11], ["c5", 12], ["c6", 13], ["c7", 14], ["c8", 15],
    ]);
    expect(layout.totalCol).toBe(16);
    expect([layout.registerCol, layout.emailCol]).toEqual([2, 8]);
  });

  it("writes J..P for the scores and Q for the total", () => {
    const layout = resolveLayout(headers, DEFAULT_FORM_FIELD_MAPPING, criteria.filter((c) => c.is_active), none);
    const scores = Object.fromEntries(["c1", "c2", "c3", "c5", "c6", "c7", "c8"].map((id, i) => [id, i + 3]));
    const updates = buildRowUpdates("Form Responses 1", 2, layout, { scores, total: 38, evaluatorName: "E", domains: "" });
    expect(updates.map((u) => [u.range, u.values[0][0]])).toEqual([
      ["'Form Responses 1'!J2", 3], ["'Form Responses 1'!K2", 4], ["'Form Responses 1'!L2", 5], ["'Form Responses 1'!M2", 6],
      ["'Form Responses 1'!N2", 7], ["'Form Responses 1'!O2", 8], ["'Form Responses 1'!P2", 9], ["'Form Responses 1'!Q2", 38],
    ]);
  });

  it("an explicit header still wins over the positional fallback", () => {
    const layout = resolveLayout(headers, DEFAULT_FORM_FIELD_MAPPING, [{ id: "x", name: "X", sheet_column: "criteria 7", is_active: true }], none);
    expect(layout.criterionCols.get("x")).toBe(15);
  });

  it("never ingests those columns as form answers", () => {
    const row = ["2026-10-01T10:00:00Z", "Asha", "23AD001", "98", "CSE", "A", "Abstract", "https://drive.google.com/file/d/a/view", "a@x.edu", 8, 7, 6, 5, 4, 3, 2, 35];
    const { submissions } = normalizeSubmissions(headers, [row], DEFAULT_FORM_FIELD_MAPPING);
    expect(submissions[0].other_details).toEqual({});
    expect(submissions[0]).toMatchObject({ register_number: "23AD001", email: "a@x.edu", abstract: "Abstract" });
  });
});
