/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @kiln/shared is published as TypeScript source from the workspace.
  transpilePackages: ["@kiln/shared"],
};

export default nextConfig;
