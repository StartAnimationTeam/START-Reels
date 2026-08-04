#!/usr/bin/env node
/**
 * Apply migrations through the Supabase Management API.
 *
 * `supabase db push` needs the database password; this needs only the personal
 * access token, which is the credential we have. Same endpoint the dashboard
 * SQL editor uses, and it runs as `postgres`.
 *
 * Deliberately NOT a replacement for `supabase db push` in normal operation —
 * it does not write to the CLI's `schema_migrations` bookkeeping. It keeps its
 * own `applied_migrations` table so a re-run is a no-op, and so the CLI can be
 * adopted later without replaying everything.
 *
 * Usage:
 *   node scripts/db-apply.mjs           # apply anything not yet applied
 *   node scripts/db-apply.mjs --status  # show what is and isn't applied
 *   node scripts/db-apply.mjs --force 0003_rls_core.sql   # re-run one file
 */

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const REF = process.env.SUPABASE_PROJECT_REF

if (!TOKEN || !REF) {
  console.error('Need SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF in .env')
  process.exit(2)
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try {
      msg = JSON.parse(text).message ?? text
    } catch {
      /* keep raw */
    }
    throw new Error(msg)
  }
  return text ? JSON.parse(text) : null
}

async function ensureBookkeeping() {
  await sql(`
    create table if not exists public.applied_migrations (
      filename    text primary key,
      sha256      text not null,
      applied_at  timestamptz not null default now()
    );
    comment on table public.applied_migrations is
      'Service-role only, no policies. Written by scripts/db-apply.mjs.
       Separate from supabase_migrations.schema_migrations.';

    -- Every table in the public schema is reachable through PostgREST. This one
    -- holds only filenames and hashes, but an unprotected table still leaks the
    -- shape of the schema to anyone with the publishable key. RLS on, no
    -- policies: service-role only, same rule as every other table here.
    alter table public.applied_migrations enable row level security;
  `)
}

const args = process.argv.slice(2)
const statusOnly = args.includes('--status')
const forceIdx = args.indexOf('--force')
const forceFile = forceIdx >= 0 ? args[forceIdx + 1] : null

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()

await ensureBookkeeping()
const applied = new Map(
  ((await sql('select filename, sha256 from public.applied_migrations')) ?? []).map((r) => [
    r.filename,
    r.sha256,
  ]),
)

let ran = 0
for (const file of files) {
  // readFileSync with an explicit utf8 encoding — reading these through
  // PowerShell's Get-Content mangles every non-ASCII character in a comment,
  // and a corrupted comment inside a $$-quoted function body is a syntax error
  // a long way from its cause.
  const body = readFileSync(join(MIGRATIONS, file), 'utf8')
  // Hash on normalized line endings. git's autocrlf hands Windows checkouts
  // CRLF for the very bytes a Linux checkout reads as LF — without this, a
  // machine move flags every applied migration as "CHANGED SINCE" (which is
  // exactly what happened on 2026-08-04).
  const hash = createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
  const prev = applied.get(file)

  if (statusOnly) {
    const state = !prev ? 'PENDING' : prev === hash ? 'applied' : 'APPLIED BUT CHANGED SINCE'
    console.log(`  ${state.padEnd(26)} ${file}`)
    continue
  }

  if (prev && prev !== hash && file !== forceFile) {
    console.error(`\n  ${file} was already applied but has changed since.`)
    console.error('  Never edit an applied migration — add a new one.')
    console.error(`  To override anyway: node scripts/db-apply.mjs --force ${file}\n`)
    process.exit(1)
  }

  if (prev === hash && file !== forceFile) {
    console.log(`  skip   ${file}`)
    continue
  }

  process.stdout.write(`  apply  ${file} … `)
  try {
    await sql(body)
    await sql(`
      insert into public.applied_migrations (filename, sha256)
      values ('${file}', '${hash}')
      on conflict (filename) do update set sha256 = excluded.sha256, applied_at = now();
    `)
    console.log('ok')
    ran++
  } catch (err) {
    console.log('FAILED')
    console.error(`\n${err.message}\n`)
    process.exit(1)
  }
}

if (!statusOnly) console.log(`\n${ran} migration(s) applied.`)
