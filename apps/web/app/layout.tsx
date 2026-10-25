import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import Shell from "@/components/Shell";
import "./globals.css";

const siteUrl =
  process.env.APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "A+ Tradeplay", template: "%s · A+ Tradeplay" },
  description: "Only the A+ trades.",
  applicationName: "A+ Tradeplay",
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }, { url: "/icon.svg", type: "image/svg+xml" }],
    apple: "/apple-touch-icon.png",
  },
  openGraph: { title: "A+ Tradeplay", description: "Only the A+ trades.", images: [{ url: "/og.png", width: 1200, height: 630 }], type: "website" },
  appleWebApp: { capable: true, title: "A+ Tradeplay", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0c0f" },
    { media: "(prefers-color-scheme: light)", color: "#eef1f5" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const THEMES = new Set(["dark", "light", "system"]);

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading headers makes every page dynamic so the per-request CSP nonce (proxy.ts) applies.
  await headers();
  const t = (await cookies()).get("theme")?.value ?? "dark";
  const theme = THEMES.has(t) ? t : "dark";
  return (
    <html lang="en" data-theme={theme} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen font-sans">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
