import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { buildExport, isExportKind } from "@/lib/services/exports";

export const maxDuration = 60;

/** Excel download: /api/admin/export?kind=selected|waitlisted|rejected|not-evaluated[&department=CSE] (admins only). */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kind = request.nextUrl.searchParams.get("kind");
  if (!isExportKind(kind)) return NextResponse.json({ error: "Unknown export" }, { status: 400 });
  const department = (request.nextUrl.searchParams.get("department") ?? "").trim().slice(0, 120);

  try {
    const file = await buildExport(kind, department);
    return new NextResponse(new Uint8Array(file.buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[export]", error);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
