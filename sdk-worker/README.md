# Run the experimental SDK image

Build from the repository root on a Linux Docker host for the NAS architecture.

```sh
docker build --target sdk-runner -t drive-backup:sdk-test .
```

If you build on another machine, transfer the image with `docker save` and `docker load` or push a privately tagged image to your registry. The regular release tags run the CLI. The SDK image contains a long-running worker built from the [pinned Proton source](https://github.com/ProtonDriveApps/sdk/tree/05c9115955589d9f6ab7392a36f8f0cb39327133), Bun 1.4.2, Proton's lockfile and OpenPGP patch. A two-line patch exposes the authenticated Account client and the caches that Proton already initializes.

## Prepare the test instance

Create two private, persistent directories or datasets, one for app data and one for the GPG key. The examples use UID/GID 1000. Give this identity write access to both directories and read/traverse access to the selected source. Set the key directory mode to `0700`. Use fresh directories and a separate test destination in Drive so that the instance has its own job database, credentials, and remote files.

The SDK image uses its own SQLite catalog at `/data/sdk-backup.db`. The first verified Proton account is bound to this instance. Sign back into that account after a restart or logout.

The worker encrypts its session with Proton's `pass` adapter. On the Docker host, initialize the store **once**, under the same UID and mounts the service will use. Adapt both host paths throughout this page.

```sh
docker run --rm --user 1000:1000 \
  -v /mnt/tank/apps/drive-backup-sdk/data:/data \
  -v /mnt/tank/apps/drive-backup-sdk/keys:/keys \
  drive-backup:sdk-test sh -ec '
    gpg --batch --pinentry-mode loopback --passphrase "" \
      --quick-generate-key "NAS SDK session" future-default default 0
    pass init "NAS SDK session"
  '
```

The dedicated GPG key has no passphrase so scheduled jobs can run after a reboot. Anyone who can read **both** the key and the app data can recover the session. Restrict and encrypt those datasets accordingly. If you already manage a suitable unattended GPG key, initialize `pass` with its fingerprint instead.

## Install on TrueNAS SCALE 24.10 or later

In **Apps → Discover → ⋮ → Install via YAML**, use the following Compose definition. Replace the sample LAN address and host paths. The web interface has no login of its own. Limit access to your trusted management network or put it behind an authenticating reverse proxy.

```yaml
services:
  drive-backup-sdk:
    image: drive-backup:sdk-test
    pull_policy: never
    restart: unless-stopped
    user: "1000:1000"
    ports:
      - "192.168.1.10:3005:3000"
    environment:
      TZ: Europe/Vienna
    volumes:
      - /mnt/tank/apps/drive-backup-sdk/data:/data
      - /mnt/tank/apps/drive-backup-sdk/keys:/keys
      - /mnt/tank/photos-test:/sources/photos:ro
```

For a registry-hosted image, change `image` to that tag and remove `pull_policy: never`. Open `http://<NAS-IP>:3005` and complete browser sign-in for this instance. Its jobs and logs appear in the app. TrueNAS manages the container under **Apps**.

## Check a backup end to end

Start with an unscheduled **Backup** set pointed at a new folder in My files.
Upload a small file, download it using Proton Drive, and compare its SHA-256
with the source. Change the source, run the same set again, and confirm both
versions can be restored from the same Drive file. Restart the container and
repeat the run to check persistence. Use this isolated set to compare the two
backends at the same concurrency, with the same thumbnail setting and input
files. Peak memory under load and sustained upload throughput require an
authenticated run.
