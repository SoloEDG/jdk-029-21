import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { LyricLine, PitchPoint, Song } from '../../../shared/document'
import { samplePitch } from '../../pitch/lib/detect'
import { pcmToWave, segmentPcm } from '../lib/audio'
import { coveredTimeline, draftKey, planCommit, replayTimeline } from './engine'
import { MemoryStorage } from './memory-storage'
import { IdbStorage, type FaultInjection } from './idb-storage'
import type {
  AudioBlock, Candidate, CommitRequest, Draft, DraftSegment, SegmentChoice, StoredBlock, StoragePort,
} from './types'

export interface ReplayItem {
  type: 'audio' | 'gap'
  start: number
  end: number
  blockId?: string
  locked?: boolean
}

export function useDraft(
  song: Ref<Song>,
  line: Ref<LyricLine | null>,
  beforeListen: () => void,
  faults: FaultInjection = {},
) {
  const idb: StoragePort = new IdbStorage(faults)
  const memory = new MemoryStorage()
  const drafts = shallowRef(new Map<string, Draft>())
  const blocks = shallowRef(new Map<string, StoredBlock>())
  const candidates = shallowRef<Candidate[]>([])
  const issue = ref('')
  const notice = ref('')
  const replayState = ref<{ item: ReplayItem; index: number; total: number } | null>(null)
  const player = new Audio()
  let objectUrl: string | null = null
  let queue: ReplayItem[] = []
  let queueIndex = 0

  const key = computed(() => line.value ? draftKey(song.value.id, line.value.id) : '')
  const draft = computed<Draft | undefined>(() => key.value ? drafts.value.get(key.value) : undefined)
  const visibleCandidates = computed(() =>
    candidates.value.filter(item => item.songId === song.value.id && item.lineId === line.value?.id))
  const memoryOnlyCandidates = computed(() => visibleCandidates.value.filter(item => !item.persisted))

  const timeline = computed(() => {
    if (!line.value) return { pieces: [], gaps: [] }
    return coveredTimeline(draft.value?.segments ?? [], line.value.start, line.value.end)
  })

  const replayItems = computed<ReplayItem[]>(() => {
    if (!line.value) return []
    return replayTimeline(draft.value?.segments ?? [], line.value.start, line.value.end).map(item =>
      item.type === 'gap'
        ? { type: 'gap' as const, start: item.gap.start, end: item.gap.end }
        : { type: 'audio' as const, start: item.piece.start, end: item.piece.end,
            blockId: item.piece.blockId, locked: item.piece.locked })
  })

  const storedPitch = computed<PitchPoint[]>(() => {
    const points: PitchPoint[] = []
    for (const segment of draft.value?.segments ?? []) {
      // 缺口与尚未重建音高的段都没有曲线，但不影响复听
      if (segment.pitchMissing) continue
      points.push(...segment.pitch)
    }
    return points.sort((a, b) => a.time - b.time)
  })

  function mutate(mutator: (nextDrafts: Map<string, Draft>, nextBlocks: Map<string, StoredBlock>) => void) {
    const nextDrafts = new Map(drafts.value)
    const nextBlocks = new Map(blocks.value)
    mutator(nextDrafts, nextBlocks)
    drafts.value = nextDrafts
    blocks.value = nextBlocks
  }

  onMounted(async () => {
    try {
      const stored = await idb.load()
      const nextDrafts = new Map<string, Draft>()
      const nextBlocks = new Map<string, StoredBlock>()
      for (const block of stored.blocks) nextBlocks.set(block.id, block)
      for (const item of stored.drafts) nextDrafts.set(draftKey(item.songId, item.lineId), item)
      drafts.value = nextDrafts
      blocks.value = nextBlocks
    } catch {
      issue.value = '无法读取本机草稿，已切到仅内存模式。'
    }
  })

  watch([() => song.value.id, () => line.value?.id], async () => {
    stopReplay()
    if (!line.value) { candidates.value = []; return }
    try {
      candidates.value = await idb.readCandidates(song.value.id, line.value.id)
    } catch {
      candidates.value = []
    }
  }, { immediate: true })

  /** 一条新录音：尽量安全落盘；落不了盘就明确只留在内存，可试听但重开不恢复 */
  async function addCandidate(candidate: Omit<Candidate, 'persisted'>): Promise<Candidate> {
    const persisted = await idb.persistCandidate(candidate as Candidate).catch(() => false)
    const full: Candidate = { ...candidate, persisted }
    candidates.value = [full, ...candidates.value.filter(item => item.id !== full.id)]
    if (!persisted) {
      memory.keepCandidate(full)
      notice.value = '存储空间不足，这条新声只留在内存，可试听但重开后不会恢复。'
    } else {
      notice.value = ''
    }
    return full
  }

  /** 默认逐段取舍：候选覆盖范围内用新声，锁定段强制保留旧声，其余保持旧声 */
  function defaultChoices(candidate: Candidate): CommitRequest['choices'] {
    const segments = draft.value?.segments ?? []
    const boundaries = new Set<number>([candidate.start, candidate.end])
    for (const segment of segments) {
      if (segment.end <= candidate.start || segment.start >= candidate.end) continue
      if (segment.start > candidate.start) boundaries.add(segment.start)
      if (segment.end < candidate.end) boundaries.add(segment.end)
    }
    const sorted = [...boundaries].sort((a, b) => a - b)
    const choices: CommitRequest['choices'] = []
    for (let index = 0; index < sorted.length - 1; index++) {
      const start = sorted[index]
      const end = sorted[index + 1]
      const locked = segments.some(segment =>
        segment.locked && segment.end > start && segment.start < end)
      choices.push({ start, end, choice: locked ? 'keep-old' : 'use-candidate' })
    }
    return choices
  }

  /** 逐段确认；返回是否成功落盘（false 表示只在内存生效）。锁定段由引擎强制保留。 */
  async function confirm(
    candidate: Candidate,
    choices: { start: number; end: number; choice: SegmentChoice }[],
  ): Promise<boolean> {
    if (!line.value) return false
    const request: CommitRequest = { songId: song.value.id, lineId: line.value.id, candidate, choices }
    const plan = planCommit(request, draft.value, blocks.value)
    try {
      if (plan.memoryOnly) {
        await memory.commit(plan)
      } else {
        await idb.commit(plan)
      }
      mutate((nextDrafts, nextBlocks) => {
        for (const block of plan.blockPlan.inserts) nextBlocks.set(block.id, block)
        for (const trim of plan.blockPlan.trims) nextBlocks.delete(trim.fromId)
        for (const id of plan.blockPlan.deletes) nextBlocks.delete(id)
        nextDrafts.set(plan.draftKey, plan.nextDraft)
      })
      await idb.removeCandidate(candidate.id).catch(() => undefined)
      memory.removeCandidate(candidate.id)
      candidates.value = candidates.value.filter(item => item.id !== candidate.id)
      notice.value = plan.memoryOnly ? '已在内存确认，重开后不会保留这次替换。' : '已确认，重开可继续练这条草稿。'
      return !plan.memoryOnly
    } catch (error) {
      // 事务异常关闭：落盘整体回滚，内存中的旧草稿与旧块保持不动，仍可恢复
      issue.value = error instanceof DOMException && error.name === 'AbortError'
        ? '确认时异常关闭，已回滚到上一次确认的范围。'
        : '确认失败，已保留确认前的声音。'
      return false
    }
  }

  /** 放弃候选（不改动草稿） */
  async function discardCandidate(candidateId: string) {
    const target = candidates.value.find(item => item.id === candidateId)
    await idb.removeCandidate(candidateId).catch(() => undefined)
    memory.removeCandidate(candidateId)
    candidates.value = candidates.value.filter(item => item.id !== candidateId)
    if (target && !target.persisted) notice.value = '已放弃仅留在内存的新声。'
  }

  /** 锁定/解锁一段当前已保住的声音；锁定后任何替换都会强制保留它 */
  function toggleLock(range: { start: number; end: number }) {
    if (!line.value) return
    const current = draft.value
    if (!current) return
    const segments = current.segments.flatMap(segment => {
      if (segment.end <= range.start || segment.start >= range.end) return [segment]
      const splits: DraftSegment[] = []
      if (range.start > segment.start) splits.push(clone(segment, segment.start, range.start))
      const middle = clone(segment, Math.max(segment.start, range.start), Math.min(segment.end, range.end))
      middle.locked = !middle.locked
      splits.push(middle)
      if (range.end < segment.end) splits.push(clone(segment, range.end, segment.end))
      return splits
    })
    const next: Draft = { ...current, updatedAt: Date.now(), segments: mergeAdjacent(segments) }
    persistLock(next)
  }

  function clone(segment: DraftSegment, start: number, end: number): DraftSegment {
    const rate = segment.sampleCount / (segment.end - segment.start)
    const delta = Math.round((start - segment.start) * rate)
    return {
      ...segment,
      start,
      end,
      sampleOffset: segment.sampleOffset + delta,
      sampleCount: Math.max(1, Math.round((end - start) * rate)),
      pitch: segment.pitch.filter(point => point.time >= start - 1e-6 && point.time < end + 1e-6),
    }
  }

  function mergeAdjacent(segments: DraftSegment[]) {
    const ordered = [...segments].sort((a, b) => a.start - b.start)
    const result: DraftSegment[] = []
    for (const segment of ordered) {
      const previous = result[result.length - 1]
      if (previous && previous.blockId === segment.blockId && previous.locked === segment.locked
        && Math.abs(previous.end - segment.start) < 1e-6
        && previous.sampleOffset + previous.sampleCount === segment.sampleOffset) {
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

  function persistLock(next: Draft) {
    const k = key.value
    mutate(nextDrafts => { nextDrafts.set(k, next) })
    idb.commit({
      draftKey: k, nextDraft: next, memoryOnly: false,
      blockPlan: { inserts: [], trims: [], deletes: [] },
    }).catch(() => { issue.value = '锁定状态暂时只在内存生效。' })
  }

  /** 音高可以事后重建：即使音高还没重建，草稿也能复听 */
  async function rebuildPitch(candidateId?: string) {
    const targets = candidateId
      ? candidates.value.filter(item => item.id === candidateId)
      : visibleCandidates.value
    const updated = new Map(candidates.value.map(item => [item.id, { ...item }]))
    for (const candidate of targets) {
      const points: PitchPoint[] = []
      const frameSize = 2048
      for (let offset = 0; offset + frameSize <= candidate.pcm.length; offset += frameSize) {
        const frame = candidate.pcm.subarray(offset, offset + frameSize)
        points.push({
          time: candidate.start + offset / candidate.sampleRate,
          midi: samplePitch(frame, candidate.sampleRate),
        })
      }
      updated.set(candidate.id, { ...candidate, pitch: points })
    }
    candidates.value = [...updated.values()]
  }

  /** 重建当前草稿已确认段的音高（曲线可晚于声音恢复），并持久化回草稿 */
  async function rebuildDraftPitch() {
    const current = draft.value
    if (!current) return
    const nextSegments = current.segments.map(segment => {
      if (!segment.pitchMissing) return segment
      const block = blocks.value.get(segment.blockId)
      if (!block) return segment
      const pcm = segmentPcm(block, segment)
      const points: PitchPoint[] = []
      const frameSize = 2048
      for (let offset = 0; offset + frameSize <= pcm.length; offset += frameSize) {
        points.push({
          time: segment.start + offset / block.sampleRate,
          midi: samplePitch(pcm.subarray(offset, offset + frameSize), block.sampleRate),
        })
      }
      return { ...segment, pitchMissing: points.length === 0, pitch: points }
    })
    const next: Draft = { ...current, updatedAt: Date.now(), segments: nextSegments }
    const k = key.value
    mutate(nextDrafts => { nextDrafts.set(k, next) })
    try {
      await idb.commit({
        draftKey: k, nextDraft: next, memoryOnly: false,
        blockPlan: { inserts: [], trims: [], deletes: [] },
      })
      notice.value = '音高已重建并保存。'
    } catch {
      issue.value = '音高已在内存重建，但未能保存。'
    }
  }

  function stopReplay() {
    player.pause()
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null }
    replayState.value = null
    queue = []
    queueIndex = 0
  }

  /** 复听整条草稿：声音段顺序播放，缺口处明确停顿并标注 */
  async function replay() {
    if (!line.value || !replayItems.value.some(item => item.type === 'audio')) return
    beforeListen()
    stopReplay()
    queue = replayItems.value
    queueIndex = 0
    await playNext()
  }

  async function playNext(): Promise<void> {
    while (queueIndex < queue.length && queue[queueIndex].type === 'gap') {
      const gap = queue[queueIndex]
      replayState.value = { item: gap, index: queueIndex, total: queue.length }
      await new Promise(resolve => setTimeout(resolve, Math.min(900, (gap.end - gap.start) * 1000)))
      queueIndex++
    }
    if (queueIndex >= queue.length) { stopReplay(); return }
    const item = queue[queueIndex]
    const block = blocks.value.get(item.blockId!)
    if (!block) { queueIndex++; return playNext() }
    const segment: DraftSegment = {
      start: item.start, end: item.end, blockId: block.id, locked: item.locked ?? false,
      sampleOffset: Math.round((item.start - block.start) * block.sampleRate),
      sampleCount: Math.round((item.end - item.start) * block.sampleRate),
      pitchMissing: false, pitch: [],
    }
    const pcm = segmentPcm(block, segment)
    objectUrl = URL.createObjectURL(pcmToWave(pcm, block.sampleRate))
    replayState.value = { item, index: queueIndex, total: queue.length }
    player.src = objectUrl
    try {
      await player.play()
    } catch {
      issue.value = '无法复听这一段。'
      stopReplay()
    }
  }

  player.addEventListener('ended', () => {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null }
    queueIndex++
    void playNext()
  })

  async function previewCandidate(candidate: Candidate) {
    beforeListen()
    stopReplay()
    objectUrl = URL.createObjectURL(candidate.audio)
    player.src = objectUrl
    try {
      await player.play()
    } catch {
      issue.value = '无法试听这条录音。'
    }
  }

  onBeforeUnmount(() => { stopReplay() })

  return {
    draft, timeline, replayItems, replayState, visibleCandidates, memoryOnlyCandidates,
    storedPitch, issue, notice, blocks,
    addCandidate, defaultChoices, confirm, discardCandidate, toggleLock,
    rebuildPitch, rebuildDraftPitch, replay, stopReplay, previewCandidate,
  }
}

export type { AudioBlock, Candidate, Draft, DraftSegment, SegmentChoice }
