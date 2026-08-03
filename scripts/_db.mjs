/**
 * Shared plumbing for the test suites: env loading, a Management-API SQL
 * runner, a PostgREST helper, and the pass/fail harness.
 *
 * The SQL runner exists because the suites exercise SECURITY DEFINER functions
 * that are deliberately NOT callable through PostgREST (that revocation is
 * itself under test in test-rls.mjs). The Management API runs as `postgres`,
 * standing in for the service role the Edge Functions use.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* shell env */
  }
  return process.env
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function sql(query) {
  const { SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF } = process.env

  // The suites fire dozens of rapid queries; the Management API occasionally
  // rate-limits (429) or hiccups (5xx / network reset). Those retry — a SQL
  // error (400) does NOT: retrying "insufficient_credits" would only make the
  // suites slower at reporting real failures.
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt)

    let res
    try {
      res = await fetch(
        `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query }),
        },
      )
    } catch (netErr) {
      lastErr = netErr
      continue
    }

    const text = await res.text()
    if (res.ok) return text ? JSON.parse(text) : []

    let msg = text
    try {
      msg = JSON.parse(text).message ?? text
    } catch {
      /* raw */
    }
    const err = new Error(msg)
    err.sql = query
    err.status = res.status

    if (res.status === 429 || res.status >= 500) {
      lastErr = err
      continue
    }
    throw err
  }
  throw lastErr
}

/** Like sql() but returns the error message instead of throwing. */
export async function sqlExpectError(query) {
  try {
    await sql(query)
    return null
  } catch (err) {
    return err.message
  }
}

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const OFF = '\x1b[0m'

export function makeHarness() {
  let passed = 0
  const failures = []

  return {
    check(name, ok, detail = '') {
      if (ok) {
        passed++
        console.log(`  ${GREEN}PASS${OFF}  ${name}`)
      } else {
        failures.push(`${name}${detail ? ` - ${detail}` : ''}`)
        console.log(`  ${RED}FAIL${OFF}  ${name}${detail ? `\n        ${detail}` : ''}`)
      }
    },
    section(title) {
      console.log(`\n${title}:`)
    },
    finish(suiteName) {
      console.log(`\n${passed} passed, ${failures.length} failed\n`)
      if (failures.length) {
        console.log('Failures:')
        for (const f of failures) console.log(`  - ${f}`)
        console.log(`\n${suiteName}: NOT PASSED.\n`)
        process.exit(1)
      }
      console.log(`${suiteName}: PASSED.\n`)
    },
  }
}
