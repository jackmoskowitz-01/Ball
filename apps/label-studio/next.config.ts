import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@autocode/db', '@autocode/cv', '@autocode/types'],
  serverExternalPackages: ['@prisma/client'],
  webpack: (config) => {
    // konva's node entry wants the native 'canvas' pkg; we only render client-side
    config.resolve.alias = { ...config.resolve.alias, canvas: false };
    return config;
  },
};

export default nextConfig;
