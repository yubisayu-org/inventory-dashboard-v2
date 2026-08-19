import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the phone (same WiFi/hotspot) to hit the dev server for mobile testing.
  //
  // Without the machine's current address here the dev server serves the HTML
  // and then refuses the /_next chunks, so the page hangs on whatever it
  // rendered on the server — a loading line, forever, with nothing in the
  // console to explain it. The address changes with the network, so this is a
  // list rather than one entry.
  allowedDevOrigins: ["172.20.10.12", "192.168.18.211"],
};

export default nextConfig;
