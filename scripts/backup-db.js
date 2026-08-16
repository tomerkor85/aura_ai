// On-demand backup: `npm run backup`.
// Writes ONE timestamped snapshot to <DATA_DIR>/backups and prunes to the
// retention limit. Safe to run while the app is live (VACUUM INTO snapshot).
// It never deletes or modifies the live database.
import { runBackup } from '../src/backup.js';

try {
  const p = runBackup();
  console.log(`[backup] created ${p}`);
  process.exit(0);
} catch (err) {
  console.error('[backup] failed:', err.message);
  process.exit(1);
}
