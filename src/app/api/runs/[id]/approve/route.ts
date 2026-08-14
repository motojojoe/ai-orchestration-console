import { NextResponse } from "next/server";
import { getRun } from "@/lib/db";
import { approvalRefusal, approveRun } from "@/lib/orchestrator/pipeline";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { planText?: string };
  // Spec §6: edit-then-approve — whatever text is submitted here is what Execute uses.
  const finalPlanText = body.planText?.trim() || run.plan_text || "";

  // Checked here, after the body has been read, and with the pipeline's own predicate rather than
  // a copy of it. `approveRun` cannot be awaited for this answer — it awaits the whole pipeline —
  // so the route used to fire it off and reply `{ok:true}` regardless, telling the browser an
  // approve succeeded that approveRun's guard then refused into console.error. Reading the request
  // body is the only await between the check and the call, and it now happens first, so nothing
  // can move the row in the gap and the two verdicts cannot differ.
  const refusal = approvalRefusal(id);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });

  void approveRun(id, finalPlanText).catch((err) => {
    console.error(`approveRun(${id}) crashed outside its own error handling:`, err);
  });

  return NextResponse.json({ ok: true });
}
