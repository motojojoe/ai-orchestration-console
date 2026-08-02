import { NextResponse } from "next/server";
import { listRecentProjects } from "@/lib/db";

export async function GET() {
  return NextResponse.json({ projects: listRecentProjects() });
}
