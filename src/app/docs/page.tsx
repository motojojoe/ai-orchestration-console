import Link from "next/link";
import { DOCS } from "@/lib/docs";

export const dynamic = "force-dynamic";

export default function DocsIndexPage() {
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "3rem 1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "2rem" }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: "0.5rem" }}>
            Docs
          </div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Read about this console</h1>
        </div>
        <Link href="/" className="btn btn-ghost">
          New run
        </Link>
      </div>

      {DOCS.length === 0 ? (
        <p style={{ color: "var(--ink-60)" }}>No docs are registered.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {DOCS.map((doc) => (
            <Link
              key={doc.slug}
              href={`/docs/${doc.slug}`}
              className="card"
              style={{ display: "flex", flexDirection: "column", gap: "0.35rem", textDecoration: "none" }}
            >
              <span style={{ fontWeight: 600, color: "var(--ink)" }}>{doc.title}</span>
              <span style={{ color: "var(--ink-60)", lineHeight: 1.55 }}>{doc.blurb}</span>
              <span className="mono" style={{ fontSize: "0.78rem", color: "var(--ink-35)" }}>
                {doc.file}
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
