import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { WorkspaceNavigation } from "@/components/workspace-navigation";
import { WorkspaceFooter } from "@/components/workspace-footer";
import { FactoryOsSessionProvider } from "@/components/auth/factoryos-session-provider";
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
  description: "A governed workspace for manufacturing operations, warehouse execution and AI-assisted workflows.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        <a
          href="#main-content"
          className="sr-only z-50 rounded-lg bg-white px-4 py-3 font-semibold text-slate-950 shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-brand-600"
        >
          Skip to content
        </a>
        <FactoryOsSessionProvider>
          <div className="flex min-h-screen flex-col md:flex-row">
            <WorkspaceNavigation />
            <div className="flex min-h-screen min-w-0 flex-1 flex-col">
              <div id="main-content" tabIndex={-1} className="min-h-0 flex-1 outline-none">
                {children}
              </div>
              <WorkspaceFooter />
            </div>
          </div>
        </FactoryOsSessionProvider>
      </body>
    </html>
  );
}
