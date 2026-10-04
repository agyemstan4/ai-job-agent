import type { MetadataRoute } from "next";

// Installable app (Phase 4a): Job Agent can be added to a phone's home screen
// and opens like an app on "Today". No service worker yet — installing needs
// only this manifest (plus HTTPS when it is hosted), and nothing is cached or
// sent in the background.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Job Agent",
    short_name: "Job Agent",
    description: "Your personal career agent: your best opportunities and applications, ready for you to review.",
    id: "/today",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f5f6f8",
    theme_color: "#4f46e5",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
