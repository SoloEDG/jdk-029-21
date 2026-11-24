import type { PitchPoint, TimeRange } from '../../../shared/document'

export type { PitchPoint }

/** 一段原始 PCM 声音块，是空间回收的最小载体 */
export interface AudioBlock {
  id: string
  /** 该块在歌曲时间线上对应的起点（秒） */
  start: number
  sampleRate: number
  /** 单声道 PCM，sampleOffset/sampleCount 都以采样点为单位 */
  pcm: Float32Array
  /** 块占用的字节数（用于配额计算与逐步释放） */
  bytes: number
}

/** 草稿中的一个片段，引用某个声音块的一个区间 */
export interface DraftSegment extends TimeRange {
  blockId: string
  /** 在块内的采样偏移与采样数，保证块被裁剪后引用仍然精确 */
  sampleOffset: number
  sampleCount: number
  /** 锁定的片段不参与新旧替换，也不会被空间回收释放 */
  locked: boolean
  /** 该段是否还没有可用音高（不影响复听，只影响曲线） */
  pitchMissing: boolean
  /** 已重建的音高点；为空且 pitchMissing=true 表示曲线暂缺 */
  pitch: PitchPoint[]
}

/** 每句歌词对应一份可跨重开恢复的草稿 */
export interface Draft {
  songId: string
  lineId: string
  updatedAt: number
  /** 按 start 排序、互不重叠 */
  segments: DraftSegment[]
}

/** 一条新录音候选；persisted=false 表示只留在内存，可试听但重开不恢复 */
export interface Candidate extends TimeRange {
  id: string
  songId: string
  lineId: string
  createdAt: number
  audio: Blob
  pcm: Float32Array
  sampleRate: number
  pitch: PitchPoint[]
  persisted: boolean
}

/** 每个子区间的逐段取舍决定 */
export type SegmentChoice = 'keep-old' | 'use-candidate' | 'abandon'

export interface CommitRequest {
  songId: string
  lineId: string
  candidate: Candidate
  /** 与候选区间求交后的每个子区间如何处理 */
  choices: { start: number; end: number; choice: SegmentChoice }[]
}

/** 提交后对声音块的处置计划 */
export interface BlockPlan {
  /** 全新写入的块 */
  inserts: AudioBlock[]
  /** 旧块 id -> 裁剪后保留的新块（仍被引用的前尾） */
  trims: { fromId: string; keep: AudioBlock }[]
  /** 提交后完全不可达、可整段释放的块 id */
  deletes: string[]
}

export interface CommitPlan {
  draftKey: string
  nextDraft: Draft
  blockPlan: BlockPlan
  /** 是否仅在内存确认（候选无法安全落盘时使用） */
  memoryOnly: boolean
}

export interface StoredBlock extends Omit<AudioBlock, 'pcm'> {
  pcm: Float32Array
}

export interface StoragePort {
  /** 读取全部已确认草稿与声音块（重开恢复） */
  load(): Promise<{ drafts: Draft[]; blocks: StoredBlock[] }>
  /**
   * 原子确认一个计划：写新块/裁剪块、更新草稿、释放不可达块。
   * 空间不足时按可达性逐步释放后重试；中途任何失败整体回滚。
   * 返回确认后的草稿。memoryOnly 的计划只在调用方内存生效，不落盘。
   */
  commit(plan: CommitPlan): Promise<Draft>
  /** 尝试持久化候选；失败（如配额不足）返回 false，由调用方保留为内存态 */
  persistCandidate(candidate: Candidate): Promise<boolean>
  /** 读取已持久化的候选（重开后仍可试听/再取舍） */
  readCandidates(songId: string, lineId: string): Promise<Candidate[]>
  /** 确认或放弃后删除候选 */
  removeCandidate(candidateId: string): Promise<void>
}
