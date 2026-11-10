import type { MetadataRoute } from "next";

/** Web app manifest: lets Chrome, Edge and Android install Tradeplay as a standalone app (Safari uses the apple metadata in the layout). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Tradeplay",
    short_name: "Tradeplay",
    description: "Only the A+ trades.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "any",
    background_color: "#0b0c0f",
    theme_color: "#0b0c0f",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Dashboard", url: "/" },
      { name: "Integrations", url: "/integrations" },
      { name: "Playbook", url: "/playbook" },
    ],
  };
}
