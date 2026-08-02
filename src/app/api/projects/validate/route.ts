import { NextResponse } from "next/server";
import { validateProject } from "@/lib/git";

export async function POST(req: Request) {
  const body = (await req.json()) as { projectPath?: string };
  const projectPath = body.projectPath?.trim();
  if (!projectPath) {
    return NextResponse.json({ ok: false, reason: "Enter a project path." });
  }

  const result = await validateProject(projectPath);
  return NextResponse.json(result);
}
