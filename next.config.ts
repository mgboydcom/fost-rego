import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Server-only libraries that should be loaded from node_modules rather than bundled.
  serverExternalPackages: ['pg', 'exceljs'],
  poweredByHeader: false,
};

export default nextConfig;
