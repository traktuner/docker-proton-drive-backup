/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  // The Proton SDK is NOT bundled by Next: scripts/build-proton.mjs bundles it once
  // into dist-proton/runtime.mjs, loaded at runtime by src/server/drive.ts.
  serverExternalPackages: ['sharp'],
  // Next 16's tracer over-includes the repo into the standalone output.
  outputFileTracingExcludes: { '*': ['scripts/**', 'test/**', 'src/server/proton/vendor/**', 'dist-proton/**'] },
};
