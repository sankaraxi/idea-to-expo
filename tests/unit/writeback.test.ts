import { describe, expect, it } from "vitest";
import { DEFAULT_FORM_FIELD_MAPPING } from "@/lib/forms/mapping";
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
