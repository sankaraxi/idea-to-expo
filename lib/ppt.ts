/**
 * PPT link handling. Only http(s) links are ever rendered (never javascript:
 * or data: URLs). Returns an embeddable preview URL where the host supports
 * one, otherwise null (the UI then offers "Open PPT" only).
 */

export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function pptEmbedUrl(raw: string | null | undefined): string | null {
  const safe = safeExternalUrl(raw);
  if (!safe) return null;
  const url = new URL(safe);
  const host = url.hostname.toLowerCase();

  if (host === "drive.google.com") {
    const id = url.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] ?? url.searchParams.get("id");
    return id ? `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview` : null;
  }

  if (host === "docs.google.com") {
    const match = url.pathname.match(/\/(presentation|document|file)\/d\/([\w-]+)/);
    if (!match) return null;
    const [, kind, id] = match;
    return kind === "presentation"
      ? `https://docs.google.com/presentation/d/${encodeURIComponent(id)}/embed?start=false&loop=false`
      : `https://docs.google.com/${kind}/d/${encodeURIComponent(id)}/preview`;
  }

  const path = url.pathname.toLowerCase();
  if (/\.(pptx?|ppsx?|docx?)$/.test(path)) {
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(safe)}`;
  }
  if (path.endsWith(".pdf")) return safe;

  return null;
}
