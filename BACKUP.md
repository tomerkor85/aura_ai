# AURA — Database Backups & Restore

The customer database is a single SQLite file, `aura.db`, stored on the Railway
Volume at **`/data/aura.db`** (see `DEPLOY.md`). Backups protect against
accidental deletion or corruption.

## How backups work

- **Automatic:** the app takes a snapshot ~30 seconds after every boot and then
  every 24 hours (`src/backup.js`, wired up in `src/index.js`).
- **On-demand:** run `npm run backup` (locally, or in the Railway **Console**).
- **Method:** SQLite `VACUUM INTO` — a consistent, self-contained snapshot taken
  safely while the database is live (never a raw file copy of an active DB).
- **Location:** `/data/backups/` — on the persistent Volume, **outside** the
  ephemeral `/app` container filesystem, so backups survive deploys/restarts.
- **Naming:** `aura-<UTC-timestamp>.db`, e.g. `aura-2026-07-23_19-28-41-000.db`.
  Files are never overwritten.
- **Retention:** the newest `BACKUP_KEEP` snapshots are kept (default **30**).
  Pruning only ever removes copies *older* than the newest 30, so the most
  recent backup is never deleted.

> Note: backups live on the **same** Volume as the DB, which protects against
> app-level mistakes but not loss of the Volume itself. For off-site protection,
> also enable Railway's native **Volume Backups** (service → **Backups** tab) or
> periodically download a snapshot (see below).

## List available backups

In the Railway **Console** (service `aura_ai`):

```bash
ls -la /data/backups
```

## Restore a backup

Restoring replaces the live DB with a chosen snapshot. Do it deliberately.

1. **Pick the snapshot** you want from `ls -la /data/backups` (usually the most
   recent good one).
2. **Stop writes.** Easiest: in Railway, temporarily **stop/scale the service to
   0**, or redeploy after step 3. Restoring while the app is writing risks a
   torn state.
3. **Swap the file** (Railway Console):

   ```bash
   cp /data/backups/aura-<CHOSEN-TIMESTAMP>.db /data/aura.db
   rm -f /data/aura.db-wal /data/aura.db-shm   # drop stale WAL/SHM from the old DB
   ```

4. **Start the service** again (or redeploy). On boot the app opens the restored
   `/data/aura.db`; your customers are back.
5. **Verify:**

   ```bash
   cd /app && node -e "const D=require('better-sqlite3');const db=new D('/data/aura.db',{readonly:true});console.log('CUSTOMERS:',db.prepare('SELECT COUNT(*) c FROM clients').get().c);"
   ```

## Download a backup off Railway (optional, extra safety)

From your own machine with the Railway CLI linked to the project:

```bash
railway ssh   # then, inside the container:
cat /data/backups/aura-<TIMESTAMP>.db > /tmp/out   # or use the Backups tab to snapshot the Volume
```

Or enable **Railway → service → Backups** for managed, off-Volume snapshots.

## Config

| Env var | Default | Meaning |
|---|---|---|
| `BACKUP_KEEP` | `30` | How many timestamped snapshots to retain. |
| `DATA_DIR` | `/data` (prod) | Base dir; backups go in `<DATA_DIR>/backups`. |
