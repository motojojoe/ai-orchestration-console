import { NextResponse } from "next/server";
import { getRun } from "@/lib/db";
import { rejectRun } from "@/lib/orchestrator/pipeline";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "awaiting_approval") {
    return NextResponse.json({ error: `Run is not awaiting approval (status: ${run.status})` }, { status: 409 });
  }

  await rejectRun(id);
  return NextResponse.json({ ok: true });
}
