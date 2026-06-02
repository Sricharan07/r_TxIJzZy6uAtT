/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are published as TypeScript source, so Next transpiles
  // them as part of the app build.
  transpilePackages: ["@kiln/shared", "@kiln/grader", "@kiln/runner"],
};

export default nextConfig;
