#!/usr/bin/env tsx
/**
 * Initialize a v2 central DB with the latest schema.
 *
 * Runs initDb + runMigrations against the path passed as argv[2] (or
 * ./data/v2.db). Used by migration tooling to bootstrap an empty
 * consolidated DB before importing data from older installs via
 * `ATTACH DATABASE`.
 */
import path from 'path';

import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

const dbPath = path.resolve(process.argv[2] || './data/v2.db');
const db = initDb(dbPath);
runMigrations(db);
const versions = db.prepare('SELECT name FROM schema_version ORDER BY version').all();
db.close();
console.log(`Migrations applied to ${dbPath}. Total: ${versions.length}`);
