import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations';

/** Open (or create) a history database and migrate it to the latest schema. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  let version = row?.user_version ?? 0;
  while (version < migrations.length) {
    const migrateStep = migrations[version];
    db.exec('BEGIN');
    try {
      migrateStep(db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${version} → ${version + 1} failed`, {
        cause: err,
      });
    }
    version += 1;
  }
}
