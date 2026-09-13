import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

const directory = new URL('../../db/migrations/', import.meta.url);
export class DatabaseSetupError extends Error {}

async function migrationFiles() {
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex') };
  }));
}

export async function migrate(pool: Pool) {
  const files = await migrationFiles();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(17321, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const applied = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const versions = new Map(applied.rows.map(row => [row.version, row.checksum]));
    const added: string[] = [];
    for (const file of files) {
      if (versions.has(file.name)) {
        if (versions.get(file.name) !== file.checksum) throw new DatabaseSetupError(`Applied migration ${file.name} changed. Restore it and add a new migration instead.`);
        continue;
      }
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
      added.push(file.name);
    }
    await client.query('COMMIT');
    return added;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function assertMigrationsCurrent(pool: Pool) {
  const files = await migrationFiles();
  try {
    const result = await pool.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(result.rows.map(row => [row.version, row.checksum]));
    for (const file of files) {
      if (applied.get(file.name) !== file.checksum) throw new DatabaseSetupError(`Database migration ${file.name} is missing or changed. Run npm run db:migrate.`);
    }
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') throw new DatabaseSetupError('Database schema is missing. Run npm run db:migrate.');
    throw error;
  }
}
