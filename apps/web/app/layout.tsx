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

const ACCENTS = new Set(["gold", "ocean", "ember", "violet"]);

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading headers makes every page dynamic so the per-request CSP nonce (proxy.ts) applies.
  await headers();
  const jar = await cookies();
  const mode = jar.get("mode")?.value === "light" ? "light" : "dark";
  const a = jar.get("accent")?.value ?? "gold";
  const accent = ACCENTS.has(a) ? a : "gold";
  return (
    <html lang="en" className={`zk ${mode} t-${accent} ${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
