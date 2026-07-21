import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@autocode/db', '@autocode/cv', '@autocode/types'],
  serverExternalPackages: ['@prisma/client'],
};

export default nextConfig;
