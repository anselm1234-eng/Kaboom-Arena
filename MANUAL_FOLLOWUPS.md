# Rebrand to Blastmates — manual follow-ups

Code, docs, assets and metadata are fully renamed. The items below touch
live infrastructure or machine-local state and were intentionally **not**
changed automatically:

1. **Deployed database file**: existing Docker volumes still contain
   `/data/bomberma.db`. The new image defaults to `DB_PATH=/data/blastmates.db`,
   so on the next deploy either:
   - set `DB_PATH=/data/bomberma.db` explicitly to keep using the old file, or
   - rename it once inside the volume:
     `docker run --rm -v <vol>:/data alpine mv /data/bomberma.db /data/blastmates.db`
     (also move `bomberma.db-wal` / `bomberma.db-shm` if present).
2. **Deployed Docker artifacts**: any servers running an image/container/volume
   named `bomberma` (`docker rename`, retag images, recreate volumes as
   `blastmates-data` or keep the old names — they are opaque identifiers).
3. **Lemon Squeezy**: store name, product names, checkout redirect URLs and
   the webhook URL should be updated to the blastmates.app domain in the LS
   dashboard. Store/variant IDs themselves are numeric and unaffected.
4. **Domain**: register/point **blastmates.app** (DNS + TLS) at the server;
   the OG/meta tags already reference `https://blastmates.app/`.
5. **Project directory**: the local checkout still lives at `~/dev/bomberma`
   — rename at your convenience (`mv ~/dev/bomberma ~/dev/blastmates`) and
   reopen your editor/session there.
6. **IDE state**: `.idea/` contains machine-local references to the old
   project name. It is now in `.gitignore`; your IDE will regenerate it
   (or rename the project in IDE settings).
7. **Stale dev artifacts**: old `/tmp/bomberma-*` screenshot/smoke dirs on
   dev machines can be deleted; scripts now write to `/tmp/blastmates-*`.
