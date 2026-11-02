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
      // v2: desks and labs became Arenas and the Backtest Suite.
      { source: "/desk/gold", destination: "/arena/cfd", permanent: false },
      { source: "/desk/btc", destination: "/arena/cfd?m=BTCUSD", permanent: false },
      { source: "/desk/fx", destination: "/arena/cfd?m=EURUSD", permanent: false },
      { source: "/desk/indices", destination: "/arena/cfd?m=NAS100", permanent: false },
      { source: "/desk/:d*", destination: "/arena/cfd", permanent: false },
      { source: "/lab/:d*", destination: "/backtest", permanent: false },
      { source: "/autopilot", destination: "/league", permanent: false },
      { source: "/live", destination: "/league", permanent: false },
      { source: "/bot", destination: "/edge", permanent: false },
      { source: "/basis", destination: "/arena/delta", permanent: false },
      { source: "/prop", destination: "/arena/cfd?tab=challenge", permanent: false },
      { source: "/journal", destination: "/arena/cfd?tab=journal", permanent: false },
      { source: "/bias", destination: "/arena/cfd?tab=bias", permanent: false },
      { source: "/discipline", destination: "/arena/cfd?tab=discipline", permanent: false },
      { source: "/copilot", destination: "/arena/cfd", permanent: false },
      { source: "/setups", destination: "/arena/cfd", permanent: false },
      { source: "/orders", destination: "/arena/cfd", permanent: false },
      { source: "/news", destination: "/arena/cfd", permanent: false },
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
