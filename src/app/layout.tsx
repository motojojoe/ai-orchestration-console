import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Orchestration Console",
  description: "Plan → Execute → Review pipeline console",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
