import { describe, expect, it } from "vitest";
import { createTestDb } from "./harness";

describe("migrations", () => {
  it("apply cleanly on a fresh database", async () => {
    const db = await createTestDb();
    const { rows } = await db.query<{ event_status: string }>("select event_status from public.app_settings");
    expect(rows).toEqual([{ event_status: "NOT_STARTED" }]);
  });
});
