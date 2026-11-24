/**
 * 极简 IndexedDB 假实现，只覆盖本应用用到的 API：
 * - objectStore（keyPath）、put/getAll/delete
 * - readwrite/readonly 事务，oncomplete/onerror/onabort
 * - 配额按事务快照基线计算，事务内的删除会先让出空间
 * - 故障注入（事务异常关闭时整体回滚）
 * 仅供 Node 测试使用，不进入浏览器产物。
 */

class FakeRequest {
  onsuccess: ((event: { target: FakeRequest }) => void) | null = null
  onerror: ((event: { target: FakeRequest }) => void) | null = null
  result: unknown = undefined
  error: DOMException | null = null
}

type PendingChange =
  | { kind: 'put'; value: Record<string, unknown> }
  | { kind: 'delete'; key: string }

class FakeTransaction {
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  error: DOMException | null = null
  mode: IDBTransactionMode
  private stores = new Map<string, FakeObjectStore>()
  private pending = new Map<string, Map<string, PendingChange>>()
  private base: Record<string, Map<string, unknown>>
  private pendingCount = 0
  private finalized = false
  private aborted = false
  private db: FakeDb

  constructor(db: FakeDb, names: string[], mode: IDBTransactionMode) {
    this.db = db
    this.mode = mode
    this.base = db.currentSnapshot()
    for (const name of names) {
      this.stores.set(name, new FakeObjectStore(db, name, db.keyPaths[name], this))
      this.pending.set(name, new Map())
    }
  }

  objectStore(name: string) {
    let store = this.stores.get(name)
    if (!store) {
      store = new FakeObjectStore(this.db, name, this.db.keyPaths[name], this)
      this.stores.set(name, store)
      this.pending.set(name, new Map())
      if (!this.base[name]) this.base[name] = new Map()
    }
    return store
  }

  get isAborted() { return this.aborted }

  /** 事务视角下的某张表（叠加本事务暂存改动） */
  view(name: string): Map<string, unknown> {
    const base = this.base[name] ?? new Map()
    const changes = this.pending.get(name)!
    const view = new Map(base)
    for (const [key, change] of changes) {
      if (change.kind === 'delete') view.delete(key)
      else view.set(key, change.value)
    }
    return view
  }

  stage(name: string, change: PendingChange): { ok: true } | { ok: false; error: DOMException } {
    const key = change.kind === 'delete' ? change.key : String(change.value[this.db.keyPaths[name]])
    const current = this.view(name).get(key)
    // 先投影本次写入，再用投影后的总量做配额判断，保证同事务删除确实先让出空间
    this.pending.get(name)!.set(key, change)
    if (change.kind === 'put') {
      if (this.db.quotaBytes != null && this.projectedUsage() > this.db.quotaBytes) {
        this.pending.get(name)!.delete(key)
        return { ok: false, error: new DOMException('存储空间不足', 'QuotaExceededError') }
      }
      if (this.db.blockQuotaBytes != null && 'pcm' in change.value
        && this.projectedPcmUsage() > this.db.blockQuotaBytes) {
        this.pending.get(name)!.delete(key)
        return { ok: false, error: new DOMException('存储空间不足', 'QuotaExceededError') }
      }
    }
    return { ok: true }
  }

  private measureTable(table: Map<string, unknown>) {
    let total = 0
    for (const record of table.values()) total += this.db.measure(record)
    return total
  }

  private isPcm(record: unknown): record is { pcm: Float32Array } {
    return !!record && typeof record === 'object' && 'pcm' in record
  }

  /** 应用本事务全部暂存改动后的投影表 */
  private projectedTable(name: string) {
    const table = new Map(this.base[name] ?? [])
    for (const [key, change] of this.pending.get(name) ?? []) {
      if (change.kind === 'delete') table.delete(key)
      else table.set(key, change.value)
    }
    return table
  }

  private projectedUsage() {
    let total = 0
    for (const name of Object.keys(this.base)) total += this.measureTable(this.projectedTable(name))
    return total
  }

  private projectedPcmUsage() {
    let total = 0
    for (const name of Object.keys(this.base)) {
      for (const record of this.projectedTable(name).values()) {
        if (this.isPcm(record)) total += this.db.measure(record)
      }
    }
    return total
  }

  begin() {
    this.pendingCount++
    this.completionQueued = false
  }

  private completionQueued = false

  end(ok: boolean) {
    this.pendingCount--
    if (!ok) return
    if (this.pendingCount === 0 && !this.completionQueued) {
      this.completionQueued = true
      // 微任务尾复检：await 链上紧接着排队的下一个请求会先 begin() 并清除本标记，
      // 只有没有更多请求时才真正完成事务
      queueMicrotask(() => {
        if (this.completionQueued && !this.finalized && !this.aborted && this.pendingCount === 0) {
          this.complete()
        }
      })
    }
  }

  private complete() {
    if (this.finalized || this.aborted) return
    this.finalized = true
    if (this.mode === 'readwrite') this.db.apply(this.pending)
    queueMicrotask(() => this.oncomplete?.())
  }

  abort() {
    if (this.finalized || this.aborted) return
    this.aborted = true
    this.error = this.error ?? new DOMException('事务被中止', 'AbortError')
    queueMicrotask(() => {
      this.onabort?.()
      this.onerror?.()
    })
  }
}

class FakeObjectStore {
  private db: FakeDb
  name: string
  keyPath: string
  private tx: FakeTransaction

  constructor(db: FakeDb, name: string, keyPath: string, tx: FakeTransaction) {
    this.db = db
    this.name = name
    this.keyPath = keyPath
    this.tx = tx
  }

  put(value: Record<string, unknown>) {
    const request = new FakeRequest()
    this.tx.begin()
    queueMicrotask(() => {
      if (this.tx.isAborted) { this.tx.end(false); return }
      const result = this.tx.stage(this.name, { kind: 'put', value })
      if (!result.ok) {
        request.error = result.error
        request.onerror?.({ target: request })
        this.tx.abort()
        this.tx.end(false)
        return
      }
      request.result = String(value[this.keyPath])
      request.onsuccess?.({ target: request })
      this.tx.end(true)
    })
    return request
  }

  getAll() {
    const request = new FakeRequest()
    this.tx.begin()
    queueMicrotask(() => {
      if (this.tx.isAborted) { this.tx.end(false); return }
      request.result = [...this.tx.view(this.name).values()]
      request.onsuccess?.({ target: request })
      this.tx.end(true)
    })
    return request
  }

  delete(key: string) {
    const request = new FakeRequest()
    this.tx.begin()
    queueMicrotask(() => {
      if (this.tx.isAborted) { this.tx.end(false); return }
      this.tx.stage(this.name, { kind: 'delete', key: String(key) })
      request.onsuccess?.({ target: request })
      this.tx.end(true)
    })
    return request
  }
}

export interface FakeDbOptions {
  /** 整体配额（含元数据） */
  quotaBytes?: number
  /** 仅针对声音块 PCM 的配额，用来模拟“空间只够保留最终选定的声音” */
  blockQuotaBytes?: number
  failNextReadWrite?: boolean
}

export class FakeDb {
  private committed: Record<string, Map<string, unknown>> = {}
  keyPaths: Record<string, string> = {}
  quotaBytes: number | undefined
  private blockQuotaBytes: number | undefined
  private failNext = false
  static readonly BLOCK_STORE = 'audio-blocks'

  constructor(names: Record<string, string>, options: FakeDbOptions = {}) {
    for (const [name, keyPath] of Object.entries(names)) {
      this.committed[name] = new Map()
      this.keyPaths[name] = keyPath
    }
    this.quotaBytes = options.quotaBytes
    this.blockQuotaBytes = options.blockQuotaBytes
    this.failNext = options.failNextReadWrite ?? false
  }

  get blockQuota() { return this.blockQuotaBytes }
  get tables() { return this.committed }

  currentSnapshot(): Record<string, Map<string, unknown>> {
    return Object.fromEntries(
      Object.entries(this.committed).map(([name, table]) => [name, new Map(table)]),
    )
  }

  measure(value: unknown) {
    if (value && typeof value === 'object' && 'pcm' in value) {
      return (value as { pcm: Float32Array }).pcm.byteLength
    }
    return 0
  }

  private measureTable(table: Map<string, unknown>) {
    let total = 0
    for (const record of table.values()) total += this.measure(record)
    return total
  }

  usage() {
    return Object.values(this.committed).reduce((sum, table) => sum + this.measureTable(table), 0)
  }

  blockUsage() {
    return this.measureTable(this.committed[FakeDb.BLOCK_STORE])
  }

  transaction(names: string[], mode: IDBTransactionMode) {
    const tx = new FakeTransaction(this, names, mode)
    if (mode === 'readwrite' && this.failNext) {
      this.failNext = false
      queueMicrotask(() => tx.abort())
    }
    return tx
  }

  apply(pending: Map<string, Map<string, PendingChange>>) {
    for (const [name, changes] of pending) {
      const table = new Map(this.committed[name])
      for (const [key, change] of changes) {
        if (change.kind === 'delete') table.delete(key)
        else table.set(key, change.value)
      }
      this.committed[name] = table
    }
  }
}

export function installFakeIndexedDb(options: FakeDbOptions = {}) {
  const names = {
    'audio-blocks': 'id',
    drafts: 'draftKey',
    candidates: 'id',
  }
  const db = new FakeDb(names, options)
  const indexedDb = {
    open() {
      const request = new FakeRequest()
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction: (storeNames: string[], mode: IDBTransactionMode) => db.transaction(storeNames, mode),
          objectStoreNames: { contains: (name: string) => name in names },
        }
        request.onsuccess?.({ target: request })
      })
      return request
    },
  }
  ;(globalThis as { indexedDB?: unknown }).indexedDB = indexedDb
  return db
}
