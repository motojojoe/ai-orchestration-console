import { NextResponse } from "next/server";
import { getRun } from "@/lib/db";
import { retryExecute } from "@/lib/orchestrator/pipeline";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "needs_changes") {
    return NextResponse.json({ error: `Run is not awaiting retry (status: ${run.status})` }, { status: 409 });
  }

  void retryExecute(id).catch((err) => {
    console.error(`retryExecute(${id}) crashed outside its own error handling:`, err);
  });

  return NextResponse.json({ ok: true });
}
