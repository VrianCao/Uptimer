import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(import.meta.dirname, '../migrations/0018_status_page_logo_url.sql');

describe('0018 status page logo url migration', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  it('adds a nullable logo_url column to status_pages', () => {
    expect(sql).toMatch(/ALTER TABLE status_pages ADD COLUMN logo_url TEXT/);
  });

  it('does not backfill, delete, or insert rows', () => {
    expect(sql).not.toMatch(/UPDATE status_pages/);
    expect(sql).not.toMatch(/DELETE FROM/);
    expect(sql).not.toMatch(/INSERT INTO/);
  });
});
