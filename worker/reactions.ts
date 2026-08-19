import type { WAMessageKey } from "baileys"

/** What a claim earns at capture time. From the spec; do not invent others. */
export const CAPTURE_REACTIONS = {
  recorded: "📝",
  needsDetail: "❔",
  unreadable: "😢",
} as const

/** What it earns once the owner has been to the shop. */
export const OUTCOME_REACTIONS = {
  secured: "✅",
  missed: "❌",
} as const

export interface QueuedReaction {
  jid: string
  key: WAMessageKey
  emoji: string
}

/** Milliseconds between reactions, before jitter. */
const BASE_DELAY_MS = 1500
/** Extra random delay, so the gaps are not identical. */
const JITTER_MS = 2500

/**
 * Send reactions one at a time, slowly.
 *
 * Recording a purchase flips every claim behind it at once — forty items is
 * forty reactions. Firing those as fast as the socket allows is precisely the
 * automated signature this number must not exhibit, so they are serialised and
 * spaced with jitter. Nothing here is time-critical: a customer learning their
 * outcome a minute later than possible costs nothing.
 *
 * A failure never stops the queue. The most common one is a message too old to
 * react to, and letting that strand the forty behind it would be worse than
 * losing one acknowledgement.
 */
export class ReactionQueue {
  private queue: QueuedReaction[] = []
  private running = false
  private idle: Promise<void> = Promise.resolve()
  private resolveIdle: (() => void) | null = null

  constructor(
    private readonly send: (reaction: QueuedReaction) => Promise<void>,
    private readonly delay: () => number = () => BASE_DELAY_MS + Math.random() * JITTER_MS,
  ) {}

  push(reaction: QueuedReaction): void {
    this.queue.push(reaction)
    if (!this.running) {
      this.idle = new Promise((resolve) => {
        this.resolveIdle = resolve
      })
      this.running = true
      void this.run()
    }
  }

  /** Resolves when everything queued so far has been attempted. */
  drain(): Promise<void> {
    return this.idle
  }

  private async run(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift() as QueuedReaction
      try {
        await this.send(next)
      } catch (err) {
        console.error("failed to send a reaction:", err)
      }
      const wait = this.delay()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
    this.running = false
    this.resolveIdle?.()
    this.resolveIdle = null
  }
}
