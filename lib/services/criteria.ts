import "server-only";
import { AppError } from "@/lib/errors";
import { isMysqlError, one, pool, rows, run, uuid, withTransaction, type Queryable } from "@/lib/db/sql";
import type { CriterionRow, DomainRow, InputStyle } from "@/types/database";
import { writeAudit } from "./audit";
import { enqueueFullResync } from "./sync-queue";

export const listCriteria = (db: Queryable = pool()) =>
  rows<CriterionRow>(db, "SELECT * FROM evaluation_criteria ORDER BY sort_order, name");

export const listActiveCriteria = (db: Queryable = pool()) =>
  rows<CriterionRow>(db, "SELECT * FROM evaluation_criteria WHERE is_active = 1 ORDER BY sort_order, name");

export const listDomains = (db: Queryable = pool()) => rows<DomainRow>(db, "SELECT * FROM domains ORDER BY sort_order, name");

export const listActiveDomains = (db: Queryable = pool()) =>
  rows<DomainRow>(db, "SELECT * FROM domains WHERE is_active = 1 ORDER BY sort_order, name");

/** How many scores / evaluations use each criterion / domain (to explain why one cannot be deleted). */
export async function getUsageCounts() {
  const [scores, domains] = await Promise.all([
    rows<{ id: string; n: number }>(pool(), "SELECT criterion_id AS id, COUNT(*) AS n FROM evaluation_scores GROUP BY criterion_id"),
    rows<{ id: string; n: number }>(pool(), "SELECT domain_id AS id, COUNT(*) AS n FROM evaluation_domains GROUP BY domain_id"),
  ]);
  const toMap = (list: { id: string; n: number }[]) => Object.fromEntries(list.map((r) => [r.id, Number(r.n)]));
  return { criteria: toMap(scores), domains: toMap(domains) };
}

export interface CriterionInput {
  id?: string;
  name: string;
  description: string | null;
  maxMarks: number;
  inputStyle: InputStyle;
  sortOrder: number;
  isActive: boolean;
  sheetColumn: string | null;
}

export async function saveCriterion(adminId: string, c: CriterionInput) {
  await withTransaction(async (tx) => {
    if (c.id) {
      // Never invalidate scores already given.
      const top = await one<{ top: number | null }>(tx, "SELECT MAX(score) AS top FROM evaluation_scores WHERE criterion_id = ?", [c.id]);
      if (top?.top !== null && top?.top !== undefined && top.top > c.maxMarks) {
        throw new AppError(
          "CRITERION_IN_USE",
          `Scores up to ${top.top} were already given for this criterion; the maximum cannot go below that.`,
        );
      }
    }
    const values = [c.name, c.description, c.maxMarks, c.inputStyle, c.sortOrder, c.isActive ? 1 : 0, c.sheetColumn];
    try {
      if (c.id) {
        await run(
          tx,
          "UPDATE evaluation_criteria SET name = ?, description = ?, max_marks = ?, input_style = ?, sort_order = ?, is_active = ?, sheet_column = ? WHERE id = ?",
          [...values, c.id],
        );
      } else {
        await run(
          tx,
          "INSERT INTO evaluation_criteria (id, name, description, max_marks, input_style, sort_order, is_active, sheet_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [uuid(), ...values],
        );
      }
    } catch (error) {
      if (isMysqlError(error, "ER_DUP_ENTRY")) throw new AppError("VALIDATION", "A criterion with this name already exists.");
      throw error;
    }
    await writeAudit(tx, {
      userId: adminId,
      action: c.id ? "CRITERION_UPDATED" : "CRITERION_CREATED",
      entityType: "criterion",
      entityId: c.id ?? null,
      metadata: { name: c.name, maxMarks: c.maxMarks, inputStyle: c.inputStyle, isActive: c.isActive },
    });
  });
  // Totals / max totals / column headers may have changed: refresh the sheets.
  await enqueueFullResync(adminId).catch((e) => console.error("[criteria] resync", e));
}

export async function deleteCriterion(adminId: string, id: string) {
  await withTransaction(async (tx) => {
    const used = await one<{ n: number }>(tx, "SELECT COUNT(*) AS n FROM evaluation_scores WHERE criterion_id = ?", [id]);
    if (Number(used?.n) > 0) throw new AppError("CRITERION_IN_USE");
    try {
      await run(tx, "DELETE FROM evaluation_criteria WHERE id = ?", [id]);
    } catch (error) {
      if (isMysqlError(error, "ER_ROW_IS_REFERENCED_2")) throw new AppError("CRITERION_IN_USE");
      throw error;
    }
    await writeAudit(tx, { userId: adminId, action: "CRITERION_DELETED", entityType: "criterion", entityId: id });
  });
}

export interface DomainInput {
  id?: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export async function saveDomain(adminId: string, d: DomainInput) {
  await withTransaction(async (tx) => {
    try {
      if (d.id) {
        await run(tx, "UPDATE domains SET name = ?, sort_order = ?, is_active = ? WHERE id = ?", [d.name, d.sortOrder, d.isActive ? 1 : 0, d.id]);
      } else {
        await run(tx, "INSERT INTO domains (id, name, sort_order, is_active) VALUES (?, ?, ?, ?)", [uuid(), d.name, d.sortOrder, d.isActive ? 1 : 0]);
      }
    } catch (error) {
      if (isMysqlError(error, "ER_DUP_ENTRY")) throw new AppError("VALIDATION", "A domain with this name already exists.");
      throw error;
    }
    await writeAudit(tx, {
      userId: adminId,
      action: d.id ? "DOMAIN_UPDATED" : "DOMAIN_CREATED",
      entityType: "domain",
      entityId: d.id ?? null,
      metadata: { name: d.name, isActive: d.isActive },
    });
  });
}

export async function deleteDomain(adminId: string, id: string) {
  await withTransaction(async (tx) => {
    const used = await one<{ n: number }>(tx, "SELECT COUNT(*) AS n FROM evaluation_domains WHERE domain_id = ?", [id]);
    if (Number(used?.n) > 0) throw new AppError("DOMAIN_IN_USE");
    try {
      await run(tx, "DELETE FROM domains WHERE id = ?", [id]);
    } catch (error) {
      if (isMysqlError(error, "ER_ROW_IS_REFERENCED_2")) throw new AppError("DOMAIN_IN_USE");
      throw error;
    }
    await writeAudit(tx, { userId: adminId, action: "DOMAIN_DELETED", entityType: "domain", entityId: id });
  });
}
