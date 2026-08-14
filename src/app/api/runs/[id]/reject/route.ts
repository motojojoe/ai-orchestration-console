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

  // rejectRun re-checks the status itself and throws if it moved. Unhandled, that surfaced as a
  // 500 with a stack for what is a refusal, not a crash — the same condition this route answers
  // with a 409 above.
  try {
    await rejectRun(id);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
