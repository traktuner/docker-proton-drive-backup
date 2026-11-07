# Upstream patches and boundary specifics

Everything listed here is applied at the boundary (bundle or one file), never by
editing upstream sources. `npm run sdk:check` verifies the vendored account
module is byte-identical to the pinned upstream tag.

| # | What | Why | Where | Test |
|---|---|---|---|---|
| 1 | Alias `openpgp/lightweight` → `openpgp` | `@protontech/crypto` imports the lightweight entry, which `@protontech/openpgp` exports only under the `browser` condition; in Node the import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Upstream's CLI applies the same change as `config/js/patches/@protontech%2Fcrypto@*.patch`. | `scripts/build-proton.mjs` (`alias`), `tsconfig.proton.json` (`paths`) | `test/proton-runtime.test.ts` loads the bundle and initialises the crypto endpoint |
| 2 | EXIF helper imported from `@protontech/drive-sdk/dist/additionalNodeMetadata` | The package has no `exports` map; the CLI uses the source path inside the monorepo. | `runtime.ts` | bundle build + typecheck |
| 3 | `generateAdditionalNodeMetadata` gets only the first 256 KiB of an image | The SDK reads `file.arrayBuffer()` — the WHOLE image — into memory for EXIF. EXIF is in the header for every format it parses. | `runtime.ts` (`headerBlob`) | bounded memory, no full read |
| 4 | `iterateFolderChildrenNodeUids` + `iterateNodes` instead of `iterateFolderChildren` | The latter is deprecated upstream. | `runtime.ts` (`children`) | typecheck |
| 5 | Session store = the CLI's `auth-session.json` | Upgrade and rollback compatibility with every CLI-era release (0.5–0.9 use this format). Written atomically, unknown fields preserved. | `session-store.ts` | `session-store.test.ts`, upgrade test |
| 6 | Error 200300 (TOO_MANY_CHILDREN) → continuation folders | Proton caps items per folder (~30k). The engine reacts to the error (no hard-coded number) and continues in "<name> · part N" siblings recorded in `drive_parts` (schema v2). | `engine.ts` (`RunContext.overflow`) | `engine.test.ts › continuation folders` |
| 7 | SDK block buffer per file 15 → 6 (`MAX_BUFFERED_BLOCKS`, env `PDB_SDK_BUFFERED_BLOCKS`) | The SDK encrypts up to 15 × 4 MiB blocks ahead of its 5 block uploads. Encryption is far faster than the upload, so a lead of one block is enough; 15 cost ~400 MB of ArrayBuffers for one file in production. | `scripts/build-proton.mjs` (`SDK_PATCHES`; the build fails if the upstream line changes) | `test/proton-runtime.test.ts` checks the bundle |
| 8 | Crypto endpoint frees keys the SDK no longer holds | The `@protontech/crypto` endpoint keeps every imported or generated key until `clearKey()`, and the SDK never calls it: each decrypted Drive node (every listed file and folder, every upload) stayed in memory, ~8 KB each, for the life of the process (production: +600 MB live heap after 7 h). The endpoint registers each returned key reference with a `FinalizationRegistry` and clears the key once the reference is garbage collected. Safe because the SDK reaches a key only through that object (the crypto cache stores it as is). `cacheStats().keys` shows the count. | `runtime.ts` (`CryptoEndpoint`) | `test/crypto-keystore.test.ts` |
