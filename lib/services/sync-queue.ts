import "server-only";
import { isMysqlError, one, pool, rows, run, uuid, withTransaction, chunk, type Queryable } from "@/lib/db/sql";
import type { SyncEntityType, SyncJobRow } from "@/types/database";
import { writeAudit } from "./audit";

/** Id of the singleton "rebuild Results + Dashboard tabs" job. */
export const RESULTS_KEY = "00000000-0000-0000-0000-000000000000";

const COLUMNS = "id, entity_type, entity_id, status, attempts, last_error, next_retry_at, locked_at, created_at, processed_at";

/**
 * Queues a Sheets update. At most one PENDING job exists per entity (unique
 * `pending_key`), so bursts of changes coalesce; call it inside the same
 * transaction as the change so the job exists iff the change committed.
 */
export async function enqueueSync(db: Queryable, type: SyncEntityType, entityId: string) {
  await run(
    db,
    "INSERT INTO sheet_sync_queue (id, entity_type, entity_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = id",
    [uuid(), type, entityId],
  );
}

export async function enqueueMany(db: Queryable, type: SyncEntityType, entityIds: readonly string[]) {
  for (const part of chunk([...new Set(entityIds)], 200)) {
    await run(
      db,
      "INSERT INTO sheet_sync_queue (id, entity_type, entity_id) VALUES ? ON DUPLICATE KEY UPDATE id = id",
      [part.map((id) => [uuid(), type, id])],
    );
  }
}

/** Claims due jobs. PROCESSING jobs whose worker died (stale > 5 min) are reclaimed. */
export async function claimSyncJobs(limit: number): Promise<SyncJobRow[]> {
  return withTransaction(async (tx) => {
    // Ordered by the (status, next_retry_at) index so only the claimed rows are locked
    // (an unindexed ORDER BY would lock every candidate row before applying LIMIT).
    const picked = await rows<{ id: string }>(
      tx,
      `SELECT id FROM sheet_sync_queue
        WHERE status = 'PENDING' AND next_retry_at <= NOW(3)
        ORDER BY next_retry_at
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (picked.length < limit) {
      picked.push(
        ...(await rows<{ id: string }>(
          tx,
          `SELECT id FROM sheet_sync_queue
            WHERE status = 'PROCESSING' AND locked_at < NOW(3) - INTERVAL 5 MINUTE
            LIMIT ?
            FOR UPDATE SKIP LOCKED`,
          [limit - picked.length],
        )),
      );
    }
    if (picked.length === 0) return [];
    const ids = picked.map((p) => p.id);
    await run(
      tx,
      "UPDATE sheet_sync_queue SET status = 'PROCESSING', locked_at = NOW(3), attempts = attempts + 1 WHERE id IN (?)",
      [ids],
    );
    return rows<SyncJobRow>(tx, `SELECT ${COLUMNS} FROM sheet_sync_queue WHERE id IN (?) ORDER BY created_at`, [ids]);
  });
}

export async function completeSyncJobs(ids: readonly string[]) {
  for (const part of chunk(ids)) {
    await run(
      pool(),
      "UPDATE sheet_sync_queue SET status = 'SUCCESS', processed_at = NOW(3), last_error = NULL, locked_at = NULL WHERE id IN (?) AND status = 'PROCESSING'",
      [part],
    );
  }
}

/**
 * Failed jobs go back to PENDING with exponential backoff (15 s … 30 min), or
 * FAILED after `maxAttempts`. If a newer PENDING job for the same entity exists,
 * this one is SUPERSEDED (the newer job re-reads current state anyway).
 */
export async function failSyncJobs(ids: readonly string[], error: string, maxAttempts: number) {
  const message = error.slice(0, 2000);
  await withTransaction(async (tx) => {
    for (const id of ids) {
      const job = await one<{ entity_type: SyncEntityType; entity_id: string; attempts: number }>(
        tx,
        "SELECT entity_type, entity_id, attempts FROM sheet_sync_queue WHERE id = ? AND status = 'PROCESSING' FOR UPDATE",
        [id],
      );
      if (!job) continue;
      const twin = await one(
        tx,
        "SELECT id FROM sheet_sync_queue WHERE entity_type = ? AND entity_id = ? AND status = 'PENDING' LIMIT 1",
        [job.entity_type, job.entity_id],
      );
      const supersede = () =>
        run(tx, "UPDATE sheet_sync_queue SET status = 'SUPERSEDED', processed_at = NOW(3), last_error = ?, locked_at = NULL WHERE id = ?", [message, id]);
      if (twin) {
        await supersede();
        continue;
      }
      const backoff = Math.min(15 * 2 ** Math.max(job.attempts - 1, 0), 1800);
      try {
        await run(
          tx,
          `UPDATE sheet_sync_queue
              SET status = ?, last_error = ?, locked_at = NULL, next_retry_at = NOW(3) + INTERVAL ? SECOND
            WHERE id = ?`,
          [job.attempts >= maxAttempts ? "FAILED" : "PENDING", message, backoff, id],
        );
      } catch (e) {
        if (!isMysqlError(e, "ER_DUP_ENTRY")) throw e;
        await supersede(); // a newer PENDING job appeared concurrently
      }
    }
  });
}

/** Lease lock: only one worker writes to the spreadsheets at a time. */
export async function acquireSyncLock(name: string, holder: string, ttlSeconds: number): Promise<boolean> {
  await run(pool(), "INSERT IGNORE INTO sync_locks (name) VALUES (?)", [name]);
  const result = await run(
    pool(),
    "UPDATE sync_locks SET holder = ?, lease_until = NOW(3) + INTERVAL ? SECOND WHERE name = ? AND (lease_until < NOW(3) OR holder = ?)",
    [holder, ttlSeconds, name, holder],
  );
  return result.affectedRows > 0;
}

export async function releaseSyncLock(name: string, holder: string) {
  await run(pool(), "UPDATE sync_locks SET holder = NULL, lease_until = '1970-01-01 00:00:00.000' WHERE name = ? AND holder = ?", [
    name,
    holder,
  ]);
}

export async function isSyncWorkerActive(name = "google_sheets") {
  const lock = await one<{ lease_until: string }>(pool(), "SELECT lease_until FROM sync_locks WHERE name = ?", [name]);
  return !!lock && Date.parse(lock.lease_until) > Date.now();
}

/** FAILED jobs back to PENDING (those with a newer pending twin are superseded). Returns how many were re-queued. */
export async function retryFailedSyncJobs(): Promise<number> {
  return withTransaction(async (tx) => {
    const failed = await rows<{ id: string }>(tx, "SELECT id FROM sheet_sync_queue WHERE status = 'FAILED' FOR UPDATE");
    let requeued = 0;
    for (const { id } of failed) {
      try {
        await run(tx, "UPDATE sheet_sync_queue SET status = 'PENDING', attempts = 0, next_retry_at = NOW(3) WHERE id = ?", [id]);
        requeued++;
      } catch (e) {
        if (!isMysqlError(e, "ER_DUP_ENTRY")) throw e;
        await run(tx, "UPDATE sheet_sync_queue SET status = 'SUPERSEDED', processed_at = NOW(3) WHERE id = ?", [id]);
      }
    }
    return requeued;
  });
}

/** Queues every entity (rebuilds the spreadsheets from the database). Returns the number of jobs added. */
export async function enqueueFullResync(actorId: string | null = null): Promise<number> {
  return withTransaction(async (tx) => {
    const pending = async () =>
      Number((await one<{ n: number }>(tx, "SELECT COUNT(*) AS n FROM sheet_sync_queue WHERE status = 'PENDING'"))?.n ?? 0);
    const before = await pending();
    const upsert = (type: SyncEntityType, select: string) =>
      run(
        tx,
        `INSERT INTO sheet_sync_queue (id, entity_type, entity_id)
         SELECT UUID(), '${type}', src.entity_id FROM (${select}) AS src
         ON DUPLICATE KEY UPDATE sheet_sync_queue.id = sheet_sync_queue.id`,
      );
    await upsert("STUDENT", "SELECT id AS entity_id FROM students");
    await upsert("EVALUATOR", "SELECT id AS entity_id FROM evaluators");
    await upsert("EVALUATION", "SELECT id AS entity_id FROM evaluations WHERE status = 'COMPLETED'");
    await upsert("RESPONSE_ROW", "SELECT student_id AS entity_id FROM evaluations WHERE status = 'COMPLETED'");
    await enqueueSync(tx, "RESULTS", RESULTS_KEY);
    const added = (await pending()) - before;
    await writeAudit(tx, { userId: actorId, action: "SHEET_FULL_RESYNC", entityType: "sheet_sync_queue", metadata: { enqueued: added } });
    return added;
  });
}
