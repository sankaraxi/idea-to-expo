import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { DrivePreviewError, driveFileId, presentationPdf } from "@/lib/drive/ppt-pdf";

export const maxDuration = 60;

/** Streams a Drive-hosted presentation as PDF using the service account (signed-in admins/evaluators only). */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user || (user.role !== "ADMIN" && !user.evaluatorId)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const fileId = driveFileId(request.nextUrl.searchParams.get("url") ?? "");
  if (!fileId) return NextResponse.json({ error: "Not a Google Drive link" }, { status: 400 });

  try {
    const pdf = await presentationPdf(fileId);
    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="presentation.pdf"',
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    if (error instanceof DrivePreviewError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[ppt-preview]", error);
    return NextResponse.json({ error: "Preview failed" }, { status: 500 });
  }
}
