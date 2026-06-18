/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  // Tauri serves the bundle from a custom protocol; relative asset paths keep it portable.
  assetPrefix: "",
  reactStrictMode: true,
  // Hide Next's dev-mode badge. It's injected into EVERY window in `next dev`,
  // and in the tiny 116×30 voice HUD it renders as a big clipped dark blob over
  // the capsule (the "half-circle"). Dev-only; the static export never had it.
  devIndicators: false,
};

export default nextConfig;
