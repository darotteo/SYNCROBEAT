/**
 * Postgres connection for the paid side of SyncroBeat.
 *
 * The database is optional on purpose. Solo practice, the free duo and every musician who joins
 * with a room code work with no database at all, exactly as they did before any of this existed.
 * Without `DATABASE_URL` the server starts normally and simply has no accounts, so a local copy or
 * a broken connection string can never take the metronome down.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

let pool: pg.Pool | null = null;
let lastFailureAt = 0;

/** True when a database was configured for this process. */
export function isConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function getPool(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      // Left to the connection string's own sslmode, which verifies the server's certificate.
      // Encrypting without verifying protects nothing from someone who can intercept the
      // connection: they present their own certificate and read the password along with everything
      // else. Neon, Supabase and Render all use certificates that verify normally.
      // DATABASE_SSL=insecure is the escape hatch for a provider with a self-signed certificate,
      // and DATABASE_SSL=off is for a Postgres on the same machine with no TLS at all.
      // Stated here rather than left to the connection string's sslmode, which pg has announced it
      // will reinterpret more weakly in a future major version: an upgrade would then quietly stop
      // verifying anything.
      ssl:
        process.env.DATABASE_SSL === 'off'
          ? false
          : { rejectUnauthorized: process.env.DATABASE_SSL !== 'insecure' },
      max: 4,
      // A hosted free tier sleeps between rehearsals; the first query has to wait for the wake-up
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // Without this, a dropped idle connection reaches the process as an uncaught exception
    pool.on('error', (err) => {
      lastFailureAt = Date.now();
      console.error('Postgres pool error:', err.message);
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  try {
    const result = await getPool().query<T>(text, params);
    return result.rows;
  } catch (err) {
    lastFailureAt = Date.now();
    throw err;
  }
}

/** When the database last refused us, so diagnostics can show it without probing. */
export function lastFailure(): number {
  return lastFailureAt;
}

/**
 * Applies any migration file that has not run yet, in filename order. Running it on every boot is
 * safe: each file is recorded once and never replayed.
 */
export async function migrate(): Promise<void> {
  if (!isConfigured()) return;
  await query(`create table if not exists migrations (
    name       text primary key,
    applied_at timestamptz not null default now()
  )`);
  const applied = new Set((await query<{ name: string }>('select name from migrations')).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    const client = await getPool().connect();
    try {
      // One transaction per file: a migration that fails halfway leaves nothing behind
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into migrations (name) values ($1)', [name]);
      await client.query('commit');
      console.log(`Migration applied: ${name}`);
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

export async function close(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.end();
}
