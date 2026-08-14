import { findDoc, readDoc } from "@/lib/docs";

// The docs are read from the working tree, which changes under a running dev server — same
// reasoning as the run routes: a cached response here would serve yesterday's file.
export const dynamic = "force-dynamic";

/** Serves a registered doc as its own HTML document, for the viewer page's iframe to load. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = findDoc(slug);
  if (!entry) {
    return new Response("Doc not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  try {
    const html = await readDoc(entry);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  } catch {
    // The registry names a file that isn't there — a checkout without it, or a moved doc. Say which
    // file, because the fix is on disk and the slug alone doesn't identify it.
    return new Response(`Doc "${entry.slug}" is registered but ${entry.file} could not be read.`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
