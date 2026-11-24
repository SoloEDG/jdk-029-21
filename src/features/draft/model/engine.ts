import type {
  AudioBlock, BlockPlan, Candidate, CommitPlan, CommitRequest, Draft, DraftSegment, PitchPoint, SegmentChoice,
} from './types'

const EPS = 1e-6

export const draftKey = (songId: string, lineId: string) => `${songId}::${lineId}`

export interface TimelineGap { start: number; end: number }
export interface TimelinePiece { start: number; end: number; blockId: string; locked: boolean }

/** 按句范围计算最终保住的声音段与缺口（缺口处没有任何已确认片段） */
export function coveredTimeline(segments: readonly DraftSegment[], lineStart: number, lineEnd: number) {
  const ordered = [...segments].sort((a, b) => a.start - b.start)
  const pieces: TimelinePiece[] = ordered.map(segment => ({
    start: segment.start, end: segment.end, blockId: segment.blockId, locked: segment.locked,
  }))
  const gaps: TimelineGap[] = []
  let cursor = lineStart
  for (const piece of pieces) {
    if (piece.start > cursor + EPS) gaps.push({ start: cursor, end: Math.min(piece.start, lineEnd) })
    cursor = Math.max(cursor, piece.end)
  }
  if (cursor < lineEnd - EPS) gaps.push({ start: cursor, end: lineEnd })
  return { pieces, gaps: gaps.filter(gap => gap.end - gap.start > EPS) }
}

/** 复听顺序：声音段与缺口交替排列，缺口用于提示最终没保住的部分 */
export function replayTimeline(segments: readonly DraftSegment[], lineStart: number, lineEnd: number) {
  const { pieces, gaps } = coveredTimeline(segments, lineStart, lineEnd)
  const items: ({ type: 'audio'; piece: TimelinePiece } | { type: 'gap'; gap: TimelineGap })[] = []
  let gapIndex = 0
  let cursor = lineStart
  for (const piece of pieces) {
    const gap = gaps[gapIndex]
    if (gap && gap.start <= piece.start + EPS && gap.end <= piece.end + EPS) {
      items.push({ type: 'gap', gap })
      gapIndex++
      cursor = gap.end
    }
    if (piece.start > cursor + EPS) {
      const filler = { start: cursor, end: piece.start }
      items.push({ type: 'gap', gap: filler })
    }
    items.push({ type: 'audio', piece })
    cursor = piece.end
  }
  for (; gapIndex < gaps.length; gapIndex++) items.push({ type: 'gap', gap: gaps[gapIndex] })
  return items
}

interface Decision { start: number; end: number; choice: SegmentChoice }

function normalizeChoices(request: CommitRequest): Decision[] {
  const decisions: Decision[] = []
  for (const entry of request.choices) {
    const start = Math.max(entry.start, request.candidate.start)
    const end = Math.min(entry.end, request.candidate.end)
    if (end - start <= EPS) continue
    const last = decisions[decisions.length - 1]
    if (last && last.choice === entry.choice && Math.abs(last.end - start) <= EPS) last.end = end
    else decisions.push({ start, end, choice: entry.choice })
  }
  return decisions.sort((a, b) => a.start - b.start)
}

function clipPitch(pitch: PitchPoint[], target: { start: number; end: number }) {
  return pitch.filter(point => point.time >= target.start - EPS && point.time < target.end + EPS)
}

function clipSegment(segment: DraftSegment, t0: number, t1: number): DraftSegment | null {
  const start = Math.max(segment.start, t0)
  const end = Math.min(segment.end, t1)
  if (end - start <= EPS) return null
  const rate = segment.sampleCount / (segment.end - segment.start)
  const offsetDelta = Math.round((start - segment.start) * rate)
  const count = Math.max(1, Math.round((end - start) * rate))
  return {
    start, end, blockId: segment.blockId, locked: segment.locked,
    sampleOffset: segment.sampleOffset + offsetDelta,
    sampleCount: Math.min(count, segment.sampleCount - offsetDelta),
    pitchMissing: segment.pitchMissing,
    pitch: clipPitch(segment.pitch, { start, end }),
  }
}

type IdFactory = () => string
const defaultId: IdFactory = () => crypto.randomUUID()

/**
 * 计算一次逐段确认的完整计划（纯函数，不触碰任何存储）。
 * 规则：
 * - keep-old 保留旧段；use-candidate 用新声替换；abandon 显式放弃。
 * - 锁定段在任何情况下都不会被替换或释放。
 * - 旧块只有在完全不可达时才整段释放；仍被引用的前尾走裁剪/拆分，绝不一并释放。
 */
export function planCommit(
  request: CommitRequest,
  current: Draft | undefined,
  blocks: ReadonlyMap<string, AudioBlock>,
  idFactory: IdFactory = defaultId,
): CommitPlan {
  const decisions = normalizeChoices(request)
  const candidate = request.candidate
  const kept: DraftSegment[] = []

  for (const segment of current?.segments ?? []) {
    let cursor = segment.start
    for (const decision of decisions) {
      if (decision.end <= segment.start || decision.start >= segment.end) continue
      if (decision.start > cursor + EPS) {
        const head = clipSegment(segment, cursor, Math.min(decision.start, segment.end))
        if (head) kept.push(head)
      }
      const overlap = clipSegment(segment, Math.max(decision.start, segment.start), Math.min(decision.end, segment.end))
      if (overlap) {
        // 锁定段是硬约束：即使选择了新声或放弃，也强制保留旧声音
        if (segment.locked || decision.choice === 'keep-old') kept.push(overlap)
      }
      cursor = Math.max(cursor, Math.min(decision.end, segment.end))
    }
    if (cursor < segment.end - EPS) {
      const tail = clipSegment(segment, cursor, segment.end)
      if (tail) kept.push(tail)
    }
  }

  const candidateBlockId = idFactory()
  const added: DraftSegment[] = []
  for (const decision of decisions) {
    if (decision.choice !== 'use-candidate') continue
    const count = Math.round((decision.end - decision.start) * candidate.sampleRate)
    if (count < 1) continue
    added.push({
      start: decision.start,
      end: decision.end,
      blockId: candidateBlockId,
      sampleOffset: Math.round((decision.start - candidate.start) * candidate.sampleRate),
      sampleCount: count,
      locked: false,
      pitchMissing: candidate.pitch.length === 0,
      pitch: candidate.pitch.filter(point => point.time >= decision.start - EPS && point.time < decision.end + EPS),
    })
  }

  const merged = mergeSegments([...kept, ...added])
  const { segments, blockPlan } = rewriteBlocks(merged, blocks, idFactory, candidateBlockId, candidate)
  const nextDraft: Draft = {
    songId: request.songId,
    lineId: request.lineId,
    updatedAt: Date.now(),
    segments,
  }
  return {
    draftKey: draftKey(request.songId, request.lineId),
    nextDraft,
    blockPlan,
    memoryOnly: !candidate.persisted,
  }
}

function mergeSegments(segments: DraftSegment[]) {
  const ordered = [...segments].sort((a, b) => a.start - b.start)
  const result: DraftSegment[] = []
  for (const segment of ordered) {
    const previous = result[result.length - 1]
    const adjacent = previous
      && previous.blockId === segment.blockId
      && previous.locked === segment.locked
      && Math.abs(previous.end - segment.start) <= EPS
      && previous.sampleOffset + previous.sampleCount === segment.sampleOffset
    if (adjacent) {
      previous.end = segment.end
      previous.sampleCount += segment.sampleCount
      previous.pitchMissing = previous.pitchMissing || segment.pitchMissing
      previous.pitch = [...previous.pitch, ...segment.pitch].sort((a, b) => a.time - b.time)
    } else {
      result.push({ ...segment, pitch: [...segment.pitch] })
    }
  }
  return result
}

function rewriteBlocks(
  segments: DraftSegment[],
  oldBlocks: ReadonlyMap<string, AudioBlock>,
  idFactory: IdFactory,
  candidateBlockId: string,
  candidate: Candidate,
): { segments: DraftSegment[]; blockPlan: BlockPlan } {
  const blockPlan: BlockPlan = { inserts: [], trims: [], deletes: [] }
  const inserts: AudioBlock[] = []
  if (segments.some(segment => segment.blockId === candidateBlockId)) {
    inserts.push({
      id: candidateBlockId,
      start: candidate.start,
      sampleRate: candidate.sampleRate,
      pcm: candidate.pcm,
      bytes: candidate.pcm.byteLength,
    })
  }

  const byBlock = new Map<string, DraftSegment[]>()
  for (const segment of segments) {
    if (segment.blockId === candidateBlockId) continue
    const list = byBlock.get(segment.blockId) ?? []
    list.push(segment)
    byBlock.set(segment.blockId, list)
  }

  const rewrite = new Map<string, { id: string; delta: number }[]>()
  for (const [blockId, refs] of byBlock) {
    const block = oldBlocks.get(blockId)
    if (!block) continue
    const intervals = refs
      .map(ref => [ref.sampleOffset, ref.sampleOffset + ref.sampleCount] as const)
      .sort((a, b) => a[0] - b[0])
      .reduce<number[][]>((acc, [from, to]) => {
        const last = acc[acc.length - 1]
        if (last && to <= last[1]) return acc
        if (last && from <= last[1]) last[1] = to
        else acc.push([from, to])
        return acc
      }, [])
    const fullSpan = intervals.length === 1 && intervals[0][0] === 0 && intervals[0][1] === block.pcm.length
    if (fullSpan) continue
    const maps: { id: string; delta: number }[] = []
    for (const [from, to] of intervals) {
      const keep: AudioBlock = {
        id: idFactory(),
        start: block.start + from / block.sampleRate,
        sampleRate: block.sampleRate,
        pcm: block.pcm.slice(from, to),
        bytes: (to - from) * Float32Array.BYTES_PER_ELEMENT,
      }
      inserts.push(keep)
      blockPlan.trims.push({ fromId: blockId, keep })
      maps.push({ id: keep.id, delta: from })
    }
    rewrite.set(blockId, maps)
  }

  for (const blockId of oldBlocks.keys()) {
    if (!byBlock.has(blockId)) blockPlan.deletes.push(blockId)
  }

  const rewritten = segments.map(segment => {
    const maps = rewrite.get(segment.blockId)
    if (!maps) return segment
    const map = maps.find(entry => {
      const keep = blockPlan.trims.find(trim => trim.keep.id === entry.id)!.keep
      const localOffset = segment.sampleOffset - entry.delta
      return localOffset >= 0 && localOffset + segment.sampleCount <= keep.pcm.length
    })!
    return {
      ...segment,
      blockId: map.id,
      sampleOffset: segment.sampleOffset - map.delta,
    }
  })
  blockPlan.inserts = inserts
  return { segments: mergeSegments(rewritten), blockPlan }
}
