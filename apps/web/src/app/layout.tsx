import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import WorkspaceNavigation from "@/components/workspace-navigation";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FactoryOS AI | Manufacturing Operations",
  description: "Governed manufacturing operations and AI workspaces.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-slate-50 text-slate-900">
        <a
          href="#main-content"
          className="sr-only z-50 rounded-lg bg-white px-4 py-3 font-semibold text-slate-950 shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-blue-600"
        >
          Skip to content
        </a>
        <WorkspaceNavigation />
        <div id="main-content" tabIndex={-1} className="min-h-0 flex-1 outline-none">
          {children}
        </div>
        <footer className="border-t border-slate-200 bg-white">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-1 px-4 py-4 text-xs text-slate-500 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
            <span>FactoryOS · Manufacturing operations workspace</span>
            <span>Access and operational actions remain API-authorized.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
