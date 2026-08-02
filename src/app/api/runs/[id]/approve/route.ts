import { NextResponse } from "next/server";
import { getRun } from "@/lib/db";
import { approveRun } from "@/lib/orchestrator/pipeline";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "awaiting_approval") {
    return NextResponse.json({ error: `Run is not awaiting approval (status: ${run.status})` }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as { planText?: string };
  // Spec §6: edit-then-approve — whatever text is submitted here is what Execute uses.
  const finalPlanText = body.planText?.trim() || run.plan_text || "";

  void approveRun(id, finalPlanText).catch((err) => {
    console.error(`approveRun(${id}) crashed outside its own error handling:`, err);
  });

  return NextResponse.json({ ok: true });
}
