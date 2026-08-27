import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: {
    // The default bottom-left position sits on top of the corpus snapshot in
    // the sidebar, which is the one piece of chrome that must stay readable.
    position: "bottom-right",
  },
};

export default nextConfig;
