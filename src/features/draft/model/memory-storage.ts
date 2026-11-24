import type { AudioBlock, Candidate, CommitPlan, Draft, StoredBlock, StoragePort } from './types'

/**
 * 把确认计划应用到一块键值存储上。
 * 单事务语义：所有写入与删除同批提交，任何一步失败都由调用方整体回滚，
 * 保证“每次确认前旧已保存范围仍可恢复”。
 */
export function applyPlanToMaps(
  blocks: Map<string, StoredBlock>,
  drafts: Map<string, Draft>,
  plan: CommitPlan,
) {
  if (plan.memoryOnly) throw new Error('内存态计划不能落盘')
  for (const block of plan.blockPlan.inserts) {
    blocks.set(block.id, { ...block, pcm: block.pcm })
  }
  for (const trim of plan.blockPlan.trims) blocks.delete(trim.fromId)
  for (const id of plan.blockPlan.deletes) blocks.delete(id)
  drafts.set(plan.draftKey, plan.nextDraft)
}

/** 纯内存存储：只用来承载“来不及安全保存”的候选与内存态草稿，重开不恢复 */
export class MemoryStorage implements StoragePort {
  private blocks = new Map<string, StoredBlock>()
  private drafts = new Map<string, Draft>()
  private candidates = new Map<string, Candidate>()

  async load() {
    return { drafts: [...this.drafts.values()], blocks: [...this.blocks.values()] }
  }

  async commit(plan: CommitPlan): Promise<Draft> {
    if (plan.memoryOnly) {
      this.drafts.set(plan.draftKey, plan.nextDraft)
      return plan.nextDraft
    }
    applyPlanToMaps(this.blocks, this.drafts, plan)
    return plan.nextDraft
  }

  async persistCandidate(): Promise<boolean> {
    return false
  }

  async readCandidates(songId: string, lineId: string) {
    return [...this.candidates.values()].filter(item => item.songId === songId && item.lineId === lineId)
  }

  async removeCandidate(candidateId: string) {
    this.candidates.delete(candidateId)
  }

  keepCandidate(candidate: Candidate) {
    this.candidates.set(candidate.id, { ...candidate, persisted: false })
  }
}
