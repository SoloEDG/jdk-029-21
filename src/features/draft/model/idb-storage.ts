import type { Candidate, CommitPlan, Draft, StoredBlock, StoragePort } from './types'
import { applyPlanToMaps } from './memory-storage'

const DB_NAME = 'night-session'
const DB_VERSION = 2
const BLOCK_STORE = 'audio-blocks'
const DRAFT_STORE = 'drafts'
const CANDIDATE_STORE = 'candidates'

export interface FaultInjection {
  /** 强制下一次确认事务在落盘瞬间异常关闭（事务 abort，全部改动回滚） */
  failNextCommit?: boolean
}

interface BlockRecord extends StoredBlock {}
interface DraftRecord extends Draft { draftKey: string }

function connect() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(BLOCK_STORE)) db.createObjectStore(BLOCK_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: 'draftKey' })
      if (!db.objectStoreNames.contains(CANDIDATE_STORE)) db.createObjectStore(CANDIDATE_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function run<T>(mode: IDBTransactionMode, stores: string[], work: (tx: IDBTransaction) => Promise<T> | T) {
  return new Promise<T>(async (resolve, reject) => {
    const db = await connect()
    const tx = db.transaction(stores, mode)
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      db.close()
      callback()
    }
    tx.oncomplete = () => finish(() => resolve(undefined as T))
    tx.onerror = () => finish(() => reject(tx.error ?? new Error('IndexedDB 事务失败')))
    tx.onabort = () => finish(() => reject(tx.error ?? new Error('IndexedDB 事务被中止')))
    try {
      const result = await work(tx)
      tx.oncomplete = () => finish(() => resolve(result))
    } catch (error) {
      try { tx.abort() } catch { /* 已中止 */ }
      finish(() => reject(error))
    }
  })
}

function requestOf<T>(store: IDBObjectStore, operation: () => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const request = operation()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** IndexedDB 持久化：单事务原子确认，删除（逐步让空间）与写入同批提交 */
export class IdbStorage implements StoragePort {
  private faults: FaultInjection

  constructor(faults: FaultInjection = {}) {
    this.faults = faults
  }

  async load() {
    return run('readonly', [BLOCK_STORE, DRAFT_STORE], async tx => {
      const blocks = await requestOf<BlockRecord[]>(tx.objectStore(BLOCK_STORE), () => tx.objectStore(BLOCK_STORE).getAll())
      const records = await requestOf<DraftRecord[]>(tx.objectStore(DRAFT_STORE), () => tx.objectStore(DRAFT_STORE).getAll())
      return {
        blocks: blocks.map(({ id, start, sampleRate, pcm, bytes }) => ({ id, start, sampleRate, pcm, bytes })),
        drafts: records.map(({ draftKey: _key, ...draft }) => draft),
      }
    })
  }

  async commit(plan: CommitPlan): Promise<Draft> {
    if (plan.memoryOnly) throw new Error('内存态计划不能落盘')
    if (this.faults.failNextCommit) {
      this.faults.failNextCommit = false
      throw new DOMException('模拟确认时异常关闭', 'AbortError')
    }
    return run('readwrite', [BLOCK_STORE, DRAFT_STORE], async tx => {
      const blockStore = tx.objectStore(BLOCK_STORE)
      const draftStore = tx.objectStore(DRAFT_STORE)
      // 先释放确认放弃的旧块（含被裁剪块的原始版本），再写新块。
      // 同一事务内删除与写入原子提交：异常关闭时全部回滚，旧已保存范围仍可恢复。
      for (const id of plan.blockPlan.deletes) await requestOf(blockStore, () => blockStore.delete(id))
      for (const trim of plan.blockPlan.trims) await requestOf(blockStore, () => blockStore.delete(trim.fromId))
      for (const block of plan.blockPlan.inserts) await requestOf(blockStore, () => blockStore.put(block))
      await requestOf(draftStore, () => draftStore.put({ ...plan.nextDraft, draftKey: plan.draftKey }))
      return plan.nextDraft
    })
  }

  async persistCandidate(candidate: Candidate): Promise<boolean> {
    try {
      await run('readwrite', [CANDIDATE_STORE], tx =>
        requestOf(tx.objectStore(CANDIDATE_STORE), () => tx.objectStore(CANDIDATE_STORE).put(candidate)))
      return true
    } catch (error) {
      if (error instanceof DOMException
        && (error.name === 'QuotaExceededError' || error.name === 'WritableBufferFullError')) return false
      throw error
    }
  }

  async readCandidates(songId: string, lineId: string): Promise<Candidate[]> {
    const all = await run('readonly', [CANDIDATE_STORE], tx =>
      requestOf<Candidate[]>(tx.objectStore(CANDIDATE_STORE), () => tx.objectStore(CANDIDATE_STORE).getAll()))
    return all.filter(item => item.songId === songId && item.lineId === lineId)
  }

  async removeCandidate(candidateId: string): Promise<void> {
    await run('readwrite', [CANDIDATE_STORE], tx =>
      requestOf(tx.objectStore(CANDIDATE_STORE), () => tx.objectStore(CANDIDATE_STORE).delete(candidateId)))
  }

  /** 测试辅助：用一份内存快照重放计划，验证逐步释放后的最终占用 */
  static replay(blocks: Map<string, StoredBlock>, drafts: Map<string, Draft>, plan: CommitPlan) {
    applyPlanToMaps(blocks, drafts, plan)
    return blocks
  }
}
