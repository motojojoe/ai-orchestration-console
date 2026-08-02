import { NextResponse } from "next/server";
import { listRuns } from "@/lib/db";
import { validateProject } from "@/lib/git";
import { createNewRun, startRun } from "@/lib/orchestrator/pipeline";
import { checkCredentials } from "@/lib/preflight";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ runs: listRuns() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    projectPath?: string;
    task?: string;
    autoApprove?: boolean;
  };
  const projectPath = body.projectPath?.trim();
  const task = body.task?.trim();

  if (!projectPath || !task) {
    return NextResponse.json({ error: "projectPath and task are required." }, { status: 400 });
  }

  // Spec §10: validated upfront, not discovered mid-pipeline.
  const projectCheck = await validateProject(projectPath);
  if (!projectCheck.ok) {
    return NextResponse.json({ error: projectCheck.reason }, { status: 400 });
  }

  // Spec §9: lightweight pre-flight, not a live API call.
  const credsCheck = await checkCredentials();
  if (!credsCheck.ok) {
    return NextResponse.json({ error: credsCheck.reason }, { status: 400 });
  }

  const run = createNewRun({
    projectPath,
    task,
    autoApprove: body.autoApprove ?? true,
  });

  // Fire-and-forget: the pipeline runs for minutes, the client follows along over SSE.
  void startRun(run.id).catch((err) => {
    console.error(`startRun(${run.id}) crashed outside its own error handling:`, err);
  });

  return NextResponse.json({ run }, { status: 201 });
}
