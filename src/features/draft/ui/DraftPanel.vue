<script setup lang="ts">
import { Headphones, Lock, LockOpen, MemoryStick, Play, RefreshCcw, RotateCcw, Square, Trash2 } from '@lucide/vue'
import type { LyricLine, SegmentChoice } from '../../../shared/document'
import { clockLabel } from '../../../shared/time'
import type { Candidate, ReplayItem } from '../model/useDraft'

const props = defineProps<{
  line: LyricLine | null
  candidates: Candidate[]
  memoryOnlyIds: string[]
  replayItems: ReplayItem[]
  replayState: { item: ReplayItem; index: number; total: number } | null
  choices: Record<string, { start: number; end: number; choice: SegmentChoice }[]>
  issue: string
  notice: string
}>()
const emit = defineEmits<{
  preview: [Candidate]
  discard: [string]
  confirm: [Candidate]
  replay: []
  stopReplay: []
  lock: [{ start: number; end: number }]
  rebuild: [string | undefined]
  choice: [string, { start: number; end: number; choice: SegmentChoice }]
}>()

const label = (start: number, end: number) => `${clockLabel(start, true)}–${clockLabel(end, true)}`
const audioItems = () => props.replayItems.filter(item => item.type === 'audio')
function isLockedRange(entry: { start: number; end: number }) {
  return props.replayItems.some(item =>
    item.type === 'audio' && item.locked && item.end > entry.start && item.start < entry.end)
}
</script>

<template>
  <section class="draft-panel" aria-labelledby="draft-title">
    <h2 class="rail-title" id="draft-title"><Headphones :size="17" /> 分段草稿 <span class="mono">{{ audioItems().length }}</span></h2>
    <div class="review-line">{{ line?.text ?? '未选择练习句' }}</div>

    <div class="timeline-strip" role="img"
      :aria-label="`本句保留 ${audioItems().length} 段，缺口 ${replayItems.filter(i => i.type === 'gap').length} 段`">
      <template v-for="(item, index) in replayItems" :key="index">
        <span v-if="item.type === 'audio'" class="timeline-seg" :class="{ locked: item.locked }"
          :title="`已保住的声音 ${label(item.start, item.end)}${item.locked ? '（锁定）' : ''}`"></span>
        <span v-else class="timeline-gap" :title="`缺口 ${label(item.start, item.end)}`"></span>
      </template>
      <span v-if="!replayItems.length" class="timeline-empty">本句还没有已确认的声音</span>
    </div>

    <div class="replay-row">
      <button class="loop-button" :disabled="!audioItems().length" @click="replayState ? emit('stopReplay') : emit('replay')">
        <Square v-if="replayState" :size="13" fill="currentColor" /><Play v-else :size="13" fill="currentColor" />
        {{ replayState ? '停止复听' : '复听整条草稿' }}
      </button>
      <button class="loop-button" @click="emit('rebuild', undefined)">
        <RefreshCcw :size="13" /> 重建音高
      </button>
    </div>
    <p v-if="replayState" class="replay-hint" role="status">
      复听 {{ replayState.index + 1 }}/{{ replayState.total }}：
      <template v-if="replayState.item.type === 'gap'">缺口 {{ label(replayState.item.start, replayState.item.end) }}（无声音）</template>
      <template v-else>{{ label(replayState.item.start, replayState.item.end) }}{{ replayState.item.locked ? ' · 锁定段' : '' }}</template>
    </p>

    <div v-if="line" class="lock-row">
      <small class="subdued">点选一段已保住的声音进行锁定，锁定后不会被新声替换或释放。</small>
      <div class="lock-segments">
        <button v-for="(item, index) in audioItems()" :key="index"
          class="lock-chip" :class="{ on: item.locked }" @click="emit('lock', { start: item.start, end: item.end })">
          <Lock v-if="item.locked" :size="11" /><LockOpen v-else :size="11" /> {{ label(item.start, item.end) }}
        </button>
      </div>
    </div>

    <div v-if="!candidates.length" class="empty-takes">
      <Headphones :size="23" /><span>暂无待确认的新声，先录一段</span>
    </div>
    <ol v-else class="take-list candidate-list">
      <li v-for="candidate in candidates" :key="candidate.id" class="candidate-card">
        <header>
          <button class="icon-button listen-button" aria-label="试听新声" @click="emit('preview', candidate)">
            <Play :size="13" fill="currentColor" />
          </button>
          <div class="take-info">
            <strong>新声 {{ clockLabel(candidate.start, true) }}–{{ clockLabel(candidate.end, true) }}</strong>
            <small class="mono">{{ candidate.pitch.length ? `音高 ${candidate.pitch.length} 点` : '音高未重建，仍可试听' }}</small>
          </div>
          <span v-if="memoryOnlyIds.includes(candidate.id)" class="memory-badge" title="只在内存，重开不恢复">
            <MemoryStick :size="12" /> 仅内存
          </span>
        </header>
        <div class="choice-list">
          <p v-for="(entry, index) in choices[candidate.id] ?? []" :key="index" class="choice-row">
            <span class="mono choice-time">{{ clockLabel(entry.start, true) }}–{{ clockLabel(entry.end, true) }}</span>
            <span class="choice-buttons">
              <button v-for="option in (['use-candidate', 'keep-old', 'abandon'] as SegmentChoice[])" :key="option"
                class="choice-chip" :class="{ active: entry.choice === option }"
                :disabled="isLockedRange(entry) && option !== 'keep-old'"
                @click="emit('choice', candidate.id, { ...entry, choice: option })">
                {{ option === 'use-candidate' ? '用新声' : option === 'keep-old' ? '留旧声' : '放弃' }}
              </button>
            </span>
          </p>
        </div>
        <footer>
          <button class="loop-button confirm-button" @click="emit('confirm', candidate)">
            <RotateCcw :size="13" /> 确认逐段取舍
          </button>
          <button class="icon-button" aria-label="放弃这条新声" @click="emit('discard', candidate.id)">
            <Trash2 :size="14" />
          </button>
        </footer>
      </li>
    </ol>
    <p v-if="notice" class="inline-notice" role="status">{{ notice }}</p>
    <p v-if="issue" class="inline-error" role="alert">{{ issue }}</p>
  </section>
</template>
