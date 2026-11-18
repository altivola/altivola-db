import { type Conn, Manager } from '@app/core'
import { describe, expect, it } from 'vitest'
import { Jobs } from '../src/jobs.ts'

const target: Conn = { id: 't1', name: 'local/app', kind: 'postgres', url: 'postgres://localhost/app', readOnly: false }

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe('jobs', () => {
  it('runs work in the background and keeps its log and warnings', async () => {
    const jobs = new Jobs(new Manager())
    let done = false
    const job = jobs.start(
      'dev/app',
      target,
      'all',
      async (log) => {
        log('one')
        log('two')
        return { warnings: ['error: extension "postgis" is not available'] }
      },
      () => {
        done = true
      },
    )
    expect(job.state).toBe('running')
    await until(() => jobs.get(job.id)?.state !== 'running')
    const end = jobs.get(job.id)
    expect(end).toMatchObject({ state: 'done', log: ['one', 'two'], source: 'dev/app', target: 'local/app' })
    expect(end?.warnings).toHaveLength(1)
    expect(end?.finished).toBeTruthy()
    expect(done).toBe(true)
  })

  it('allows one job per target and can cancel it', async () => {
    const jobs = new Jobs(new Manager())
    const job = jobs.start(
      'a',
      target,
      'data',
      (_log, signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    )
    let cleaned = false
    expect(() =>
      jobs.start(
        'b',
        target,
        'all',
        async () => ({ warnings: [] }),
        () => {
          cleaned = true
        },
      ),
    ).toThrow(/already running/)
    expect(cleaned).toBe(true)
    expect(jobs.cancel(job.id)).toBe(true)
    await until(() => jobs.get(job.id)?.state !== 'running')
    expect(jobs.get(job.id)?.state).toBe('cancelled')
    expect(jobs.cancel('nope')).toBe(false)
  })

  it('reports a failure', async () => {
    const jobs = new Jobs(new Manager())
    const job = jobs.start('a', target, 'all', async () => {
      throw new Error('pg_dump failed with exit code 1 (see the log)')
    })
    await until(() => jobs.get(job.id)?.state !== 'running')
    expect(jobs.get(job.id)).toMatchObject({ state: 'failed', error: 'pg_dump failed with exit code 1 (see the log)' })
  })

  it('keeps only the newest log lines', async () => {
    const jobs = new Jobs(new Manager())
    const job = jobs.start('a', target, 'all', async (log) => {
      for (let i = 0; i < 2500; i++) log(`line ${i}`)
      return { warnings: [] }
    })
    await until(() => jobs.get(job.id)?.state !== 'running')
    const end = jobs.get(job.id)
    expect(end?.log).toHaveLength(2000)
    expect(end?.dropped).toBe(500)
    expect(end?.log[0]).toBe('line 500')
  })
})
