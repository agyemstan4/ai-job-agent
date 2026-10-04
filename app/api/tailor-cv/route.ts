import { NextResponse } from "next/server";
import { tailorCv } from "@/lib/generation/tailor-cv";

// Thin route over lib/generation/tailor-cv.ts (shared with server-side
// preparation, POST /api/applications/prepare).
export async function POST(req: Request) {
  try {
    const { structuredCV, job } = await req.json();

    if (!structuredCV || !job) {
      return NextResponse.json(
        { error: "Missing structuredCV or job." },
        { status: 400 }
      );
    }

    const tailoredCV = await tailorCv(structuredCV, job);

    return NextResponse.json({
      success: true,
      tailoredCV,
    });
  } catch (error) {
    console.error("FULL ERROR:");
    console.error(error);

    return NextResponse.json(
      {
        error: "Tailoring failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
