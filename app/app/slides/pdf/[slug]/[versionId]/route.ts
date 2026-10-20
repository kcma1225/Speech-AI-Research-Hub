import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isUuid } from "@/lib/origin";
import { slideAccess } from "@/lib/slide-access";
import { projectDir } from "@/lib/slides";

export async function GET(_: Request, { params }: { params: Promise<{ slug: string; versionId: string }> }) {
  const { slug, versionId } = await params;
  if (!isUuid(versionId)) return new NextResponse("Not found", { status: 404 });
  const access = await slideAccess(slug);
  if (!access) return new NextResponse("Not found", { status: 404 });
  const version = await (await db()).query(
    "SELECT id FROM slide_versions WHERE id=$1 AND project_id=$2 AND status='published'",
    [versionId, access.project.id],
  );
  if (!version.rowCount) return new NextResponse("Not found", { status: 404 });
  try {
    const pdf = new Uint8Array(await readFile(path.join(projectDir(access.project.id), "versions", versionId, "output", "slides.pdf")));
    if (new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") throw new Error("Invalid PDF");
    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${slug}-v${versionId}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("PDF 尚未產生。", { status: 404 });
  }
}
