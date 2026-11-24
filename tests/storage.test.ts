import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installFakeIndexedDb, type FakeDb } from './helpers/fake-idb.ts'
import { IdbStorage } from '../src/features/draft/model/idb-storage.ts'
import { MemoryStorage } from '../src/features/draft/model/memory-storage.ts'
import { coveredTimeline, planCommit } from '../src/features/draft/model/engine.ts'
import type { AudioBlock, Candidate, Draft, DraftSegment, StoredBlock } from '../src/features/draft/model/types.ts'

const RATE = 100
let sequence = 0
const nextId = () => `id-${++sequence}`
const SONG = 'song'
const LINE = 'line'
const LINE_END = 10

function makeBlock(start: number, duration: number, fill: number): AudioBlock {
  const pcm = Float32Array.from({ length: duration * RATE }, (_, i) => fill + i / 100000)
  return { id: nextId(), start, sampleRate: RATE, pcm, bytes: pcm.byteLength }
}

function segOf(block: AudioBlock, start: number, end: number, locked = false): DraftSegment {
  return {
    start, end, blockId: block.id, locked,
    sampleOffset: Math.round((start - block.start) * RATE),
    sampleCount: Math.round((end - start) * RATE),
    pitchMissing: false, pitch: [],
  }
}

function voice(start: number, end: number, fill: number, persisted = true): Candidate {
  const pcm = Float32Array.from({ length: (end - start) * RATE }, () => fill)
  return {
    id: nextId(), songId: SONG, lineId: LINE, createdAt: 0, start, end,
    audio: new Blob(), pcm, sampleRate: RATE, pitch: [], persisted,
  }
}

function mapsFrom(loaded: { blocks: StoredBlock[]; drafts: Draft[] }) {
  return {
    blockMap: new Map(loaded.blocks.map(b => [b.id, b])),
    draftMap: new Map(loaded.drafts.map(d => [`${d.songId}::${d.lineId}`, d])),
  }
}

test('配额只够最终声音：放弃的旧块逐步让给新块，同块前尾不被一并释放', async () => {
  // 初始一块覆盖 0–10，共 1000 采样 * 4 字节 = 4000 字节
  const old = makeBlock(0, 10, 1)
  const initial: Draft = { songId: SONG, lineId: LINE, updatedAt: 0, segments: [segOf(old, 0, 10)] }
  const quota = old.bytes // 只够保留最终选定的声音总量
  const db = installFakeIndexedDb({ blockQuotaBytes: quota })
  const storage = new IdbStorage()

  // 先模拟旧草稿已落盘（直接通过一次空计划不便，改用底层 put 的等价路径：加载空，再确认一份初始计划）
  const seedPlan = {
    draftKey: `${SONG}::${LINE}`, nextDraft: initial, memoryOnly: false,
    blockPlan: { inserts: [old], trims: [], deletes: [] },
  }
  await storage.commit(seedPlan)
  assert.equal(db.blockUsage(), old.bytes)

  // 重唱中间 2–7：其中 2–3 放弃（制造最终缺口），3–7 用新声，锁定 7–8 这一小段
  const loaded1 = await storage.load()
  const { blockMap, draftMap } = mapsFrom(loaded1)
  const current = draftMap.get(`${SONG}::${LINE}`)!
  // 锁定 7–8
  current.segments = [
    segOf(old, 0, 7),
    { ...segOf(old, 7, 8, true) },
    segOf(old, 8, 10),
  ]
  const candidate = voice(2, 7, 0.5)
  const plan = planCommit(
    {
      songId: SONG, lineId: LINE, candidate,
      choices: [
        { start: 2, end: 3, choice: 'abandon' },
        { start: 3, end: 7, choice: 'use-candidate' },
      ],
    },
    current, blockMap, nextId,
  )

  // 计划层面：缺口、锁定段、前尾拆分都正确
  const timeline = coveredTimeline(plan.nextDraft.segments, 0, LINE_END)
  assert.deepEqual(timeline.gaps, [{ start: 2, end: 3 }])
  assert.ok(plan.nextDraft.segments.some(s => s.locked && s.start === 7 && s.end === 8))

  // 同一块里仍被保留的前尾必须拆成独立块，而不是随整块删除
  const keptFromOld = plan.blockPlan.trims.map(t => [t.keep.start, t.keep.pcm.length])
  assert.deepEqual(keptFromOld.sort(), [[0, 200], [7, 300]])

  await storage.commit(plan)
  // 最终占用不超过配额
  assert.ok(db.blockUsage() <= quota, `声音占用 ${db.blockUsage()} 超过配额 ${quota}`)

  // 重开：声音段与缺口都能被指出
  const reopened = await storage.load()
  const redraft = reopened.drafts.find(d => d.lineId === LINE)!
  const again = coveredTimeline(redraft.segments, 0, LINE_END)
  assert.deepEqual(again.gaps, [{ start: 2, end: 3 }])
  const retained = again.pieces.map(p => [p.start, p.end])
  assert.deepEqual(retained, [[0, 2], [3, 7], [7, 8], [8, 10]])
})

test('第二次确认时异常关闭：事务整体回滚，重开仍是第一次确认的结果与缺口', async () => {
  const old = makeBlock(0, 10, 1)
  const initial: Draft = { songId: SONG, lineId: LINE, updatedAt: 0, segments: [segOf(old, 0, 10)] }
  installFakeIndexedDb({ blockQuotaBytes: old.bytes * 2 })
  const storage = new IdbStorage()
  await storage.commit({
    draftKey: `${SONG}::${LINE}`, nextDraft: initial, memoryOnly: false,
    blockPlan: { inserts: [old], trims: [], deletes: [] },
  })

  // 第一次确认：放弃 2–3，替换 3–6，锁定 7–8
  let loaded = await storage.load()
  let maps = mapsFrom(loaded)
  const first = maps.draftMap.get(`${SONG}::${LINE}`)!
  first.segments = [segOf(old, 0, 7), { ...segOf(old, 7, 8, true) }, segOf(old, 8, 10)]
  const c1 = voice(2, 6, 0.3)
  const plan1 = planCommit(
    {
      songId: SONG, lineId: LINE, candidate: c1,
      choices: [
        { start: 2, end: 3, choice: 'abandon' },
        { start: 3, end: 6, choice: 'use-candidate' },
      ],
    },
    first, maps.blockMap, nextId,
  )
  await storage.commit(plan1)
  const afterFirst = await storage.load()
  const draftAfterFirst = afterFirst.drafts.find(d => d.lineId === LINE)!
  assert.deepEqual(coveredTimeline(draftAfterFirst.segments, 0, LINE_END).gaps, [{ start: 2, end: 3 }])

  // 第二次确认：再录一段，提交瞬间异常关闭
  loaded = await storage.load()
  maps = mapsFrom(loaded)
  const c2 = voice(0, 2, 0.8)
  const plan2 = planCommit(
    { songId: SONG, lineId: LINE, candidate: c2, choices: [{ start: 0, end: 2, choice: 'use-candidate' }] },
    maps.draftMap.get(`${SONG}::${LINE}`)!, maps.blockMap, nextId,
  )
  const faultStorage = new IdbStorage({ failNextCommit: true })
  await assert.rejects(() => faultStorage.commit(plan2), /异常关闭|中止/)

  // 重开恢复：必须仍是第一次确认的段与缺口，第二次的块与草稿都不存在
  const recovered = await storage.load()
  const redraft = recovered.drafts.find(d => d.lineId === LINE)!
  assert.deepEqual(redraft.segments.map(s => [s.start, s.end]),
    draftAfterFirst.segments.map(s => [s.start, s.end]))
  assert.deepEqual(coveredTimeline(redraft.segments, 0, LINE_END).gaps, [{ start: 2, end: 3 }])
  const recoveredBlockIds = new Set(recovered.blocks.map(b => b.id))
  for (const inserted of plan2.blockPlan.inserts) assert.ok(!recoveredBlockIds.has(inserted.id))
})

test('来不及安全保存的新声只留在内存：可试听标记明确，重开不恢复', async () => {
  const old = makeBlock(0, 10, 1)
  const db = installFakeIndexedDb({ blockQuotaBytes: old.bytes })
  const storage = new IdbStorage()
  await storage.commit({
    draftKey: `${SONG}::${LINE}`, nextDraft: {
      songId: SONG, lineId: LINE, updatedAt: 0, segments: [segOf(old, 0, 10)],
    }, memoryOnly: false,
    blockPlan: { inserts: [old], trims: [], deletes: [] },
  })

  // 配额已满，候选无法落盘
  const candidate = voice(4, 6, 0.6)
  const persisted = await storage.persistCandidate(candidate)
  assert.equal(persisted, false)
  assert.equal(db.tables.candidates.size, 0)

  // 内存态确认只影响 MemoryStorage，IDB 不变
  const memory = new MemoryStorage()
  const loaded = await storage.load()
  const maps = mapsFrom(loaded)
  const memoryCandidate: Candidate = { ...candidate, persisted: false }
  const plan = planCommit(
    { songId: SONG, lineId: LINE, candidate: memoryCandidate, choices: [{ start: 4, end: 6, choice: 'use-candidate' }] },
    maps.draftMap.get(`${SONG}::${LINE}`)!, maps.blockMap, nextId,
  )
  assert.equal(plan.memoryOnly, true)
  await memory.commit(plan)
  assert.equal((await memory.load()).drafts.length, 1)

  // 重新打开持久层：旧草稿原样，内存新声不存在
  const reopened = await storage.load()
  assert.equal(reopened.drafts.find(d => d.lineId === LINE)!.segments.length, 1)
  assert.deepEqual(await storage.readCandidates(SONG, LINE), [])
})
