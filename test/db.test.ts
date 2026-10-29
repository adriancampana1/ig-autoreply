import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/database.js';

describe('database', () => {
  it('aplica as migrações e é idempotente', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(['users', 'ig_accounts', 'automations', 'webhook_events', 'interactions', 'jobs', 'deletion_requests']),
    );
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(versions.n).toBe(1);
  });

  it('liga as chaves estrangeiras', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
