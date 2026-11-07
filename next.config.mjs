/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  // The Proton SDK is NOT bundled by Next: scripts/build-proton.mjs bundles it once
  // into dist-proton/runtime.mjs, loaded at runtime by src/server/drive.ts.
  serverExternalPackages: ['sharp'],
  // Runtime paths (/config, /sources, /data) are marked /*turbopackIgnore: true*/
  // where they are read, so the tracer does not copy the repository into the image.
  // sharp (+ libvips) is copied into the image by the Dockerfile for the SDK bundle,
  // so it is kept out of the trace instead of being shipped twice.
  outputFileTracingExcludes: {
    '*': [
      'scripts/**',
      'test/**',
      'src/server/proton/vendor/**',
      'dist-proton/**',
      'Dockerfile',
      'node_modules/sharp/**',
      'node_modules/@img/**',
      'node_modules/detect-libc/**',
      'node_modules/semver/**',
    ],
  },
};
