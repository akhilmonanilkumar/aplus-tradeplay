/** @type {import('next').NextConfig} */

// Content-Security-Policy (with a per-request nonce) is set in proxy.ts.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@aplus/engine"],
  async redirects() {
    return [
      { source: "/copilot", destination: "/desk/gold", permanent: false },
      { source: "/setups", destination: "/desk/gold", permanent: false },
      { source: "/orders", destination: "/desk/gold", permanent: false },
      { source: "/news", destination: "/desk/gold", permanent: false },
      { source: "/copy", destination: "/accounts", permanent: false },
      { source: "/connections", destination: "/settings", permanent: false },
      { source: "/subscriptions", destination: "/alerts", permanent: false },
      { source: "/broadcast", destination: "/alerts", permanent: false },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
