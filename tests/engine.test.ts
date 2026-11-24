import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coveredTimeline, planCommit, replayTimeline } from '../src/features/draft/model/engine.ts'
import type { AudioBlock, Candidate, Draft, DraftSegment } from '../src/features/draft/model/types.ts'

const RATE = 100
let sequence = 0
const nextId = () => `id-${++sequence}`

function block(start: number, duration: number, fill: number): AudioBlock {
  const pcm = Float32Array.from({ length: duration * RATE }, (_, index) => fill + index / 10000)
  return { id: nextId(), start, sampleRate: RATE, pcm, bytes: pcm.byteLength }
}

function segment(block: AudioBlock, start: number, end: number, locked = false): DraftSegment {
  return {
    start, end, blockId: block.id, locked,
    sampleOffset: Math.round((start - block.start) * RATE),
    sampleCount: Math.round((end - start) * RATE),
    pitchMissing: false, pitch: [],
  }
}

function candidate(start: number, end: number, fill: number, persisted = true): Candidate {
  const pcm = Float32Array.from({ length: (end - start) * RATE }, () => fill)
  return {
    id: nextId(), songId: 'song', lineId: 'line', createdAt: 0,
    start, end, audio: new Blob(), pcm, sampleRate: RATE, pitch: [], persisted,
  }
}

test('旧片段中间被替换：前尾保留并拆分，整块只在不可达时释放', () => {
  const old = block(0, 10, 1)
  const initial: Draft = {
    songId: 'song', lineId: 'line', updatedAt: 0,
    segments: [segment(old, 0, 10)],
  }
  const blocks = new Map([[old.id, old]])
  const voice = candidate(3, 7, 0.5)
  const plan = planCommit(
    { songId: 'song', lineId: 'line', candidate: voice, choices: [{ start: 3, end: 7, choice: 'use-candidate' }] },
    initial, blocks, nextId,
  )
  const next = plan.nextDraft
  assert.deepEqual(next.segments.map(s => [s.start, s.end]), [[0, 3], [3, 7], [7, 10]])
  // 旧块被拆成两块（前尾），原始整块进入删除清单
  assert.equal(plan.blockPlan.trims.length, 2)
  assert.deepEqual(plan.blockPlan.deletes, [])
  assert.ok(plan.blockPlan.trims.every(t => t.fromId === old.id))
  const head = plan.blockPlan.trims.find(t => t.keep.start === 0)!.keep
  const tail = plan.blockPlan.trims.find(t => t.keep.start === 7)!.keep
  assert.equal(head.pcm.length, 3 * RATE)
  assert.equal(tail.pcm.length, 3 * RATE)
  // 新块只有候选真正被采用的区间
  const inserted = plan.blockPlan.inserts.find(b => b.id !== head.id && b.id !== tail.id)!
  assert.equal(inserted.pcm.length, 4 * RATE)
  // 时间线没有缺口
  const timeline = coveredTimeline(next.segments, 0, 10)
  assert.deepEqual(timeline.gaps, [])
})

test('显式放弃会制造缺口，并只释放对应引用、保留同块前尾', () => {
  const old = block(0, 10, 1)
  const initial: Draft = { songId: 'song', lineId: 'line', updatedAt: 0, segments: [segment(old, 0, 10)] }
  const blocks = new Map([[old.id, old]])
  const voice = candidate(2, 5, 0.4)
  const plan = planCommit(
    {
      songId: 'song', lineId: 'line', candidate: voice,
      choices: [{ start: 2, end: 5, choice: 'abandon' }],
    },
    initial, blocks, nextId,
  )
  assert.deepEqual(plan.nextDraft.segments.map(s => [s.start, s.end]), [[0, 2], [5, 10]])
  const timeline = coveredTimeline(plan.nextDraft.segments, 0, 10)
  assert.deepEqual(timeline.gaps, [{ start: 2, end: 5 }])
  // 仍然引用旧块的两个前尾，所以旧块走拆分而不是直接删除
  assert.equal(plan.blockPlan.trims.length, 2)
  assert.deepEqual(plan.blockPlan.deletes, [])
})

test('旁边一小段始终锁定：新声与放弃都不能覆盖锁定区间', () => {
  const old = block(0, 10, 1)
  const locked: DraftSegment = { ...segment(old, 4, 5), locked: true }
  const initial: Draft = {
    songId: 'song', lineId: 'line', updatedAt: 0,
    segments: [segment(old, 0, 4), locked, segment(old, 5, 10)],
  }
  const blocks = new Map([[old.id, old]])
  const voice = candidate(3, 6, 0.2)
  const plan = planCommit(
    {
      songId: 'song', lineId: 'line', candidate: voice,
      choices: [
        { start: 3, end: 4, choice: 'use-candidate' },
        { start: 4, end: 5, choice: 'abandon' },
        { start: 5, end: 6, choice: 'use-candidate' },
      ],
    },
    initial, blocks, nextId,
  )
  const spans = plan.nextDraft.segments.map(s => [s.start, s.end, s.locked])
  assert.deepEqual(spans, [[0, 3, false], [3, 4, false], [4, 5, true], [5, 6, false], [6, 10, false]])
  const lockSeg = plan.nextDraft.segments.find(s => s.locked)!
  // 锁定段的声音内容必须原样保留（块即使改名，采样仍是旧块对应区间）
  const lockSource = plan.blockPlan.trims.find(t => t.keep.id === lockSeg.blockId)?.keep
    ?? blocks.get(lockSeg.blockId)
  assert.ok(lockSource)
  const expectedOffset = Math.round((4 - lockSource!.start) * RATE)
  assert.deepEqual(
    lockSource!.pcm.subarray(lockSeg.sampleOffset, lockSeg.sampleOffset + lockSeg.sampleCount),
    old.pcm.subarray(Math.round((4 - old.start) * RATE), Math.round((5 - old.start) * RATE)),
  )
  assert.equal(expectedOffset, lockSeg.sampleOffset)
  // 锁定段引用保留，旧块不能整块释放
  assert.ok(plan.blockPlan.trims.some(t => t.fromId === old.id))
})

test('未持久化候选确认后计划标记 memoryOnly，仍产出可试听的完整时间线', () => {
  const old = block(0, 10, 1)
  const initial: Draft = { songId: 'song', lineId: 'line', updatedAt: 0, segments: [segment(old, 0, 10)] }
  const voice = candidate(1, 3, 0.7, false)
  const plan = planCommit(
    { songId: 'song', lineId: 'line', candidate: voice, choices: [{ start: 1, end: 3, choice: 'use-candidate' }] },
    initial, new Map([[old.id, old]]), nextId,
  )
  assert.equal(plan.memoryOnly, true)
  const items = replayTimeline(plan.nextDraft.segments, 0, 10)
  assert.equal(items.every(item => item.type === 'audio'), true)
})

test('复听顺序能指出保住的段和缺口', () => {
  const old = block(0, 10, 1)
  const initial: Draft = { songId: 'song', lineId: 'line', updatedAt: 0, segments: [segment(old, 0, 10)] }
  const voice = candidate(2, 4, 0.9)
  const plan = planCommit(
    { songId: 'song', lineId: 'line', candidate: voice, choices: [{ start: 2, end: 4, choice: 'abandon' }] },
    initial, new Map([[old.id, old]]), nextId,
  )
  const items = replayTimeline(plan.nextDraft.segments, 0, 10)
  assert.deepEqual(items.map(item => item.type), ['audio', 'gap', 'audio'])
  assert.deepEqual(items[1], { type: 'gap', gap: { start: 2, end: 4 } })
})

test('裁剪保留的前尾在采样级与原块对应区间完全一致（前尾不被一并释放）', () => {
  const old = block(0, 10, 1)
  const initial: Draft = { songId: 'song', lineId: 'line', updatedAt: 0, segments: [segment(old, 0, 10)] }
  const voice = candidate(4, 6, 0.2)
  const plan = planCommit(
    { songId: 'song', lineId: 'line', candidate: voice, choices: [{ start: 4, end: 6, choice: 'use-candidate' }] },
    initial, new Map([[old.id, old]]), nextId,
  )
  const head = plan.blockPlan.trims.find(t => t.keep.start === 0)!.keep
  const tail = plan.blockPlan.trims.find(t => t.keep.start === 6)!.keep
  assert.deepEqual([...head.pcm], [...old.pcm.subarray(0, 4 * RATE)])
  assert.deepEqual([...tail.pcm], [...old.pcm.subarray(6 * RATE, 10 * RATE)])
  // 被替换的中间区间（4–6）不再有任何旧块引用
  assert.ok(plan.blockPlan.trims.every(t => !(t.keep.start < 6 && t.keep.start + t.keep.pcm.length / RATE > 4)))
})

test('新声音高未重建时片段标记 pitchMissing，时间线仍完整可复听', () => {
  const old = block(0, 10, 1)
  const initial: Draft = { songId: 'song', lineId: 'line', updatedAt: 0, segments: [segment(old, 0, 10)] }
  const voice = candidate(3, 5, 0.6)
  voice.pitch = []
  const plan = planCommit(
    { songId: 'song', lineId: 'line', candidate: voice, choices: [{ start: 3, end: 5, choice: 'use-candidate' }] },
    initial, new Map([[old.id, old]]), nextId,
  )
  const replaced = plan.nextDraft.segments.find(s => s.start === 3 && s.end === 5)!
  assert.equal(replaced.pitchMissing, true)
  assert.deepEqual(replaced.pitch, [])
  // 曲线虽缺，但三段声音都在，没有缺口，复听顺序全是 audio
  const items = replayTimeline(plan.nextDraft.segments, 0, 10)
  assert.equal(items.every(item => item.type === 'audio'), true)
  assert.equal(coveredTimeline(plan.nextDraft.segments, 0, 10).gaps.length, 0)
})
