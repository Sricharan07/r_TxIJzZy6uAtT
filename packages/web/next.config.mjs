/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The web bundle imports shared directly; runner/grader stay in the worker.
  transpilePackages: ["@kiln/shared"],
};

export default nextConfig;
