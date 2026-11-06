#!/bin/sh
set -eu

# Use two fresh mounts for the encrypted store and its dedicated key. The loopback
# request also checks the exact pid/stdio boundary shipped to TrueNAS.
docker run --rm -i --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt=no-new-privileges \
  --tmpfs /data:rw,uid=1000,gid=1000,mode=0700 \
  --tmpfs /keys:rw,uid=1000,gid=1000,mode=0700 \
  --tmpfs /tmp:rw,mode=1777 \
  "${1:?specify the SDK test image}" sh -es <<'SMOKE'
test "$DRIVE_BACKEND" = sdk
test "$PROTON_DRIVE_CREDENTIALS_STORE" = pass
test -x /usr/local/bin/drive-sdk-worker
test ! -e /usr/local/bin/proton-drive

gpg --batch --pinentry-mode loopback --passphrase "" \
  --quick-generate-key 'NAS SDK smoke' future-default default 0
pass init 'NAS SDK smoke'
echo offline-test | pass insert -mf smoke/probe
test "$(pass show smoke/probe)" = offline-test
pass rm -f smoke/probe

node server.js &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const base = 'http://127.0.0.1:3000';
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(base + '/api/health')).ok) break;
  } catch {}
  await setTimeout(500);
}
async function get(route) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  return response.json();
}
const version = await get('/api/version');
assert.equal(version.backend, 'SDK');
assert.match(JSON.stringify(version.cli), /js@0\.23\.0\+05c91159/);
const status = await get('/api/auth/status');
assert.equal(status.authenticated, false);
assert.equal(status.loginState, 'idle');
JS
SMOKE
