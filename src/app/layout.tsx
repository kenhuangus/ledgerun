/** Root layout — app shell + top bar. */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ledger Run — Invoice Hub",
  description: "AI invoice ingestion & matching assistant",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link href="/" className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gray-900 text-xs font-bold text-white">
                LR
              </span>
              <span className="text-sm font-semibold tracking-tight">Ledger Run</span>
            </Link>
            <span className="text-xs text-gray-400">AI decides first · you review after</span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
