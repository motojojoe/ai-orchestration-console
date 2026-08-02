import { NextResponse } from "next/server";
import { getRun } from "@/lib/db";

// A run's status changes from another async pipeline function, not from this request — without
// this, GET could serve a cached snapshot while the client polls for a state change that already
// happened server-side.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json({ run });
}
