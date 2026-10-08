import "server-only";
import { JWT } from "google-auth-library";
import type { GoogleConfig } from "@/lib/env";

export type CellValue = string | number | boolean | null;

/** The subset of the Sheets API the sync engine needs (fakeable in tests). */
export interface SheetsApi {
  listTabs(): Promise<string[]>;
  addTabs(titles: string[]): Promise<void>;
  getValues(range: string): Promise<CellValue[][]>;
  batchUpdate(data: { range: string; values: CellValue[][] }[]): Promise<void>;
  clear(range: string): Promise<void>;
}

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export class SheetsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SheetsApiError";
  }
}

/** Google Sheets REST client authenticated as a service account. Server-only. */
export class GoogleSheetsApi implements SheetsApi {
  private readonly auth: JWT;

  constructor(
    config: Pick<GoogleConfig, "clientEmail" | "privateKey">,
    private readonly spreadsheetId: string,
  ) {
    this.auth = new JWT({ email: config.clientEmail, key: config.privateKey, scopes: SCOPES });
  }

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const { token } = await this.auth.getAccessToken();
    const response = await fetch(`${BASE}/${encodeURIComponent(this.spreadsheetId)}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(25_000),
    });
    // Short in-request retry for quota / transient errors; the queue retries longer-term.
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
      return this.request<T>(path, init, attempt + 1);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SheetsApiError(`Sheets API ${response.status}: ${body.slice(0, 300)}`, response.status);
    }
    return (await response.json()) as T;
  }

  async listTabs() {
    const data = await this.request<{ sheets?: { properties: { title: string } }[] }>(
      "?fields=sheets.properties.title",
    );
    return (data.sheets ?? []).map((s) => s.properties.title);
  }

  async addTabs(titles: string[]) {
    if (titles.length === 0) return;
    await this.request(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests: titles.map((title) => ({ addSheet: { properties: { title } } })) }),
    });
  }

  async getValues(range: string) {
    const data = await this.request<{ values?: CellValue[][] }>(
      `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
    );
    return data.values ?? [];
  }

  async batchUpdate(data: { range: string; values: CellValue[][] }[]) {
    if (data.length === 0) return;
    // RAW: user-supplied text (remarks, names) is never interpreted as a formula.
    await this.request("/values:batchUpdate", {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    });
  }

  async clear(range: string) {
    await this.request(`/values/${encodeURIComponent(range)}:clear`, { method: "POST", body: "{}" });
  }
}
