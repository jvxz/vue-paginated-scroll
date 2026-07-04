// A fake "server" timeline with variable-height messages, to exercise the
// library the way a real Matrix room would: unpredictable heights (one-liners,
// paragraphs, images, giant rules blocks), page-by-page loading, a live edge
// that can advance, and true start/end-of-history boundaries.

export type MessageKind = 'text' | 'image' | 'rules'

export interface Message {
  id: number
  author: string
  kind: MessageKind
  text: string
  /** Extra rendered block height in px, for image/rules kinds. */
  blockHeight: number
}

const AUTHORS = ['ada', 'linus', 'grace', 'dennis', 'margaret', 'alan']
const WORDS =
  'the quick brown fox jumps over a lazy dog while matrix events stream past in a stable window of bounded dom nodes'.split(
    ' ',
  )

// Deterministic PRNG so a given id always renders the same height.
function seeded(id: number): () => number {
  let s = (id * 2654435761) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export function makeMessage(id: number): Message {
  const rnd = seeded(id)
  const author = AUTHORS[Math.floor(rnd() * AUTHORS.length)]!
  const roll = rnd()
  let kind: MessageKind = 'text'
  let blockHeight = 0
  if (roll > 0.94) {
    kind = 'rules'
    blockHeight = 260 + Math.floor(rnd() * 260) // giant, taller than viewport chunk
  } else if (roll > 0.82) {
    kind = 'image'
    blockHeight = 120 + Math.floor(rnd() * 140)
  }
  const wordCount = kind === 'text' ? 2 + Math.floor(rnd() * 40) : 3 + Math.floor(rnd() * 8)
  const text = Array.from({ length: wordCount }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(
    ' ',
  )
  return { id, author, kind, text, blockHeight }
}

/**
 * The fake server. Holds a movable live-edge id so we can simulate new messages
 * arriving. History runs from id 0 (oldest) up to `liveEdgeId` (newest).
 */
export class FakeTimeline {
  private latency: number
  // Pages this "server" has already served once, keyed by exact range —
  // a repeat request for the same range mimics a warm cache, so the
  // playground can demo instant pagination without the artificial delay.
  private servedRanges = new Set<string>()
  liveEdgeId: number
  readonly oldestId = 0

  constructor(liveEdgeId = 5000, latency = 180) {
    this.liveEdgeId = liveEdgeId
    this.latency = latency
  }

  private delay(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.latency))
  }

  private async fetchRange(start: number, end: number): Promise<Message[]> {
    const key = `${start}:${end}`
    if (!this.servedRanges.has(key)) {
      await this.delay()
      this.servedRanges.add(key)
    }
    return this.range(start, end)
  }

  /** Newest `count` messages — the initial page. */
  async initial(count = 40): Promise<Message[]> {
    const start = Math.max(this.oldestId, this.liveEdgeId - count + 1)
    return this.fetchRange(start, this.liveEdgeId)
  }

  /** Older messages before `beforeId` (backward pagination). */
  async older(beforeId: number, count = 30): Promise<Message[]> {
    const end = beforeId - 1
    const start = Math.max(this.oldestId, end - count + 1)
    if (end < this.oldestId) return []
    return this.fetchRange(start, end)
  }

  /** Newer messages after `afterId` (forward pagination). */
  async newer(afterId: number, count = 30): Promise<Message[]> {
    const start = afterId + 1
    const end = Math.min(this.liveEdgeId, start + count - 1)
    if (start > this.liveEdgeId) return []
    return this.fetchRange(start, end)
  }

  /** Simulate a brand-new live message. */
  emitLive(): Message {
    this.liveEdgeId += 1
    return makeMessage(this.liveEdgeId)
  }

  canGoOlder(firstId: number): boolean {
    return firstId > this.oldestId
  }

  canGoNewer(lastId: number): boolean {
    return lastId < this.liveEdgeId
  }

  private range(start: number, end: number): Message[] {
    const out: Message[] = []
    for (let id = start; id <= end; id++) out.push(makeMessage(id))
    return out
  }
}
