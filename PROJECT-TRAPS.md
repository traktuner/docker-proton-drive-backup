# Project traps

- CLI 0.8.0 requires `-f create-new-revision` for changed files; `-f merge` was valid only in older CLI versions and makes Backup/Mirror uploads fail, while folder conflicts still use `-d merge` (`src/server/engine.ts`, `src/server/cli.ts`, `Dockerfile`).
