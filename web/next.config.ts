import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

/**
 * Phone testing (./start-luna.sh): the laptop serves everything from one HTTPS origin.
 * The browser calls /luna-api and /ngo-api; Next forwards them to the local API and
 * food checker, so the phone never needs plain-http or a second certificate.
 * Only active when LUNA_LOCAL_PROXY=1, so Netlify builds are unaffected.
 */
const localProxy = process.env.LUNA_LOCAL_PROXY === "1";

const nextConfig: NextConfig = {
  // Trip contracts and pure GPS geometry are shared with the API workspace.
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
  // Lets a phone on the same Wi-Fi load the dev server (hot reload, chunks) by the laptop's address.
  allowedDevOrigins: (process.env.LUNA_DEV_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  async rewrites() {
    if (!localProxy) return [];
    return [
      { source: "/luna-api/:path*", destination: `${process.env.LUNA_API_TARGET ?? "http://127.0.0.1:8787"}/:path*` },
      { source: "/ngo-api/:path*", destination: `${process.env.LUNA_NGO_TARGET ?? "http://127.0.0.1:8000"}/:path*` },
    ];
  },
};

export default nextConfig;
