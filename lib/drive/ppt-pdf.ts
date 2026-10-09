import "server-only";
import { JWT } from "google-auth-library";
import { googleConfig } from "@/lib/env";

const API = "https://www.googleapis.com/drive/v3/files";
const SLIDES = "application/vnd.google-apps.presentation";
const MAX_BYTES = 50 * 1024 * 1024;

export class DrivePreviewError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Extracts a Drive/Docs file id from a share link; null for any other host. */
export function driveFileId(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "drive.google.com" && url.hostname !== "docs.google.com") return null;
    return url.pathname.match(/\/d\/([\w-]+)/)?.[1] ?? url.searchParams.get("id")?.match(/^[\w-]+$/)?.[0] ?? null;
  } catch {
    return null;
  }
}

async function call(auth: JWT, url: string, init: RequestInit = {}) {
  const { token } = await auth.getAccessToken();
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(50_000),
  });
}

async function fail(res: Response): Promise<never> {
  const body = await res.text().catch(() => "");
  if (res.status === 403 || res.status === 404) {
    throw new DrivePreviewError(
      "The service account cannot access this file. Share it with the service account email or set it to 'Anyone with the link'.",
      res.status,
    );
  }
  throw new DrivePreviewError(`Drive API ${res.status}: ${body.slice(0, 200)}`, 502);
}

async function read(res: Response): Promise<ArrayBuffer> {
  if (!res.ok) return fail(res);
  return res.arrayBuffer();
}

/** Returns the presentation as PDF bytes, fetched as the service account. */
export async function presentationPdf(fileId: string): Promise<ArrayBuffer> {
  const config = googleConfig();
  if (!config) throw new DrivePreviewError("Google service account is not configured", 503);
  const auth = new JWT({
    email: config.clientEmail,
    key: config.privateKey,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const id = encodeURIComponent(fileId);

  const metaRes = await call(auth, `${API}/${id}?fields=mimeType,size&supportsAllDrives=true`);
  if (!metaRes.ok) return fail(metaRes);
  const meta = (await metaRes.json()) as { mimeType: string; size?: string };
  if (meta.size && Number(meta.size) > MAX_BYTES) throw new DrivePreviewError("File too large to preview", 413);

  if (meta.mimeType === "application/pdf") {
    return read(await call(auth, `${API}/${id}?alt=media&supportsAllDrives=true`));
  }
  if (meta.mimeType === SLIDES) {
    return read(await call(auth, `${API}/${id}/export?mimeType=application%2Fpdf`));
  }

  // Uploaded .ppt/.pptx: convert a temporary copy to Slides, export it, then delete it.
  const copyRes = await call(auth, `${API}/${id}/copy?supportsAllDrives=true&fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mimeType: SLIDES, name: "preview-temp" }),
  });
  if (!copyRes.ok) return fail(copyRes);
  const { id: copyId } = (await copyRes.json()) as { id: string };
  try {
    return await read(await call(auth, `${API}/${encodeURIComponent(copyId)}/export?mimeType=application%2Fpdf`));
  } finally {
    await call(auth, `${API}/${encodeURIComponent(copyId)}?supportsAllDrives=true`, { method: "DELETE" }).catch(() => {});
  }
}
