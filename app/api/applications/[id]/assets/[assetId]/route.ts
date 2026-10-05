import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { getAsset, getAssetFile } from "@/lib/repositories/applications";
import { attachmentHeaders } from "@/lib/download-headers";

// Downloads a stored file asset (the tailored CV) of an application.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  try {
    const { id, assetId } = await params;
    const asset = getAsset(db, Number(assetId));
    if (!asset || asset.applicationId !== Number(id) || !asset.hasFile) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const file = getAssetFile(db, asset.id)!;
    return new NextResponse(new Uint8Array(file), {
      headers: attachmentHeaders(asset.filename || "CV.pdf", asset.mimeType),
    });
  } catch (error) {
    console.error("GET /api/applications/[id]/assets/[assetId] error:", error);
    return NextResponse.json({ error: "Failed to fetch file" }, { status: 500 });
  }
}
