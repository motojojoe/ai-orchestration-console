import Link from "next/link";
import { notFound } from "next/navigation";
import { findDoc } from "@/lib/docs";

export const dynamic = "force-dynamic";

/**
 * Docs are standalone HTML documents with their own styling, keyboard handling and full-viewport
 * layout (the slide deck listens on `keydown` and paints its own dark ground). They are shown in an
 * iframe rather than inlined so none of that collides with the console's own stylesheet — and so a
 * doc can keep working exactly as it does when opened from disk.
 */
export default async function DocViewerPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = findDoc(slug);
  if (!doc) notFound();

  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          padding: "0.7rem 1.1rem",
          borderBottom: "1px solid var(--line)",
          flex: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.7rem", minWidth: 0 }}>
          <Link href="/docs" className="eyebrow" style={{ textDecoration: "none" }}>
            ← Docs
          </Link>
          <span style={{ fontWeight: 600, color: "var(--ink)" }}>{doc.title}</span>
        </div>
        <a href={`/api/docs/${doc.slug}`} target="_blank" rel="noreferrer" className="btn btn-ghost">
          Open full screen
        </a>
      </header>

      <iframe
        // The doc handles its own keyboard navigation; it only receives key events once the frame
        // has focus, which is why the full-screen link above stays available.
        src={`/api/docs/${doc.slug}`}
        title={doc.title}
        style={{ flex: 1, width: "100%", border: 0 }}
      />
    </main>
  );
}
