// A copy or import can take minutes, so it runs as a job the page polls.

import type { Conn, CopyReport, Log, Manager } from '@app/core'
import { errorMessage } from '@app/core'

const maxLog = 2000

export type JobState = 'running' | 'done' | 'failed' | 'cancelled'

export type JobView = {
  id: string
  source: string
  target: string
  mode: string
  state: JobState
  error?: string
  warnings: string[]
  log: string[]
  /** Log lines cut from the front. */
  dropped: number
  started: string
  finished?: string
}

type Job = JobView & { abort: AbortController }

export type Work = (log: Log, signal: AbortSignal) => Promise<CopyReport>

export class Jobs {
  private jobs = new Map<string, Job>()
  private seq = 0

  constructor(private dbs: Manager) {}

  /**
   * Runs work in the background. Only one job may write into a target at a
   * time. done runs after the job finishes (or right away when it cannot start).
   */
  start(source: string, target: Conn, mode: string, work: Work, done?: () => void): JobView {
    for (const j of this.jobs.values()) {
      if (j.state === 'running' && j.target === target.name) {
        done?.()
        throw new Error(`a copy or import into ${JSON.stringify(target.name)} is already running`)
      }
    }
    const job: Job = {
      id: `job-${++this.seq}`,
      source,
      target: target.name,
      mode,
      state: 'running',
      warnings: [],
      log: [],
      dropped: 0,
      started: new Date().toISOString(),
      abort: new AbortController(),
    }
    this.jobs.set(job.id, job)
    const log: Log = (line) => {
      job.log.push(line)
      const over = job.log.length - maxLog
      if (over > 0) {
        job.log.splice(0, over)
        job.dropped += over
      }
    }
    work(log, job.abort.signal)
      .then((report) => {
        job.warnings = report.warnings
        job.state = 'done'
      })
      .catch((e) => {
        if (job.abort.signal.aborted) job.state = 'cancelled'
        else {
          job.state = 'failed'
          job.error = errorMessage(e)
        }
      })
      .finally(() => {
        job.finished = new Date().toISOString()
        // Open drivers may hold schema the job just replaced.
        this.dbs.forget(target.id)
        done?.()
      })
    return this.view(job)
  }

  get(id: string): JobView | undefined {
    const j = this.jobs.get(id)
    return j && this.view(j)
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id)
    j?.abort.abort()
    return !!j
  }

  private view(j: Job): JobView {
    const { abort: _, ...rest } = j
    return { ...rest, warnings: [...j.warnings], log: [...j.log] }
  }
}
