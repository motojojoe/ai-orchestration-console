import { NextResponse } from "next/server";
import { getRun } from "@/lib/db";
import { cancelRun } from "@/lib/orchestrator/pipeline";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // Spec §8: SIGTERM→SIGKILL happens asynchronously; respond once it's requested, not once it's done.
  void cancelRun(id).catch((err) => {
    console.error(`cancelRun(${id}) crashed outside its own error handling:`, err);
  });

  return NextResponse.json({ ok: true });
}
