const isGitHubPages = process.env.NEXT_PUBLIC_DEPLOY_TARGET === "github-pages";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: isGitHubPages ? "export" : undefined,
  basePath: isGitHubPages ? "/agentic-geo" : undefined,
  assetPrefix: isGitHubPages ? "/agentic-geo/" : undefined,
  images: {
    unoptimized: true
  },
  transpilePackages: ["@agentic-geo/pdp-extractor-agent", "@agentic-geo/pdp-geo-generator-agent"]
};

export default nextConfig;
