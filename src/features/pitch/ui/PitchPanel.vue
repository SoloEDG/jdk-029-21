<script setup lang="ts">
import { Activity } from '@lucide/vue'
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import type { GuideNote, PitchPoint, TimeRange } from '../../../shared/document'
import { drawPitch } from '../lib/plot'

interface GapRange { start: number; end: number }

const props = defineProps<{
  notes: GuideNote[]; position: number; range: TimeRange; latest: string | null
  live: PitchPoint[]; saved: PitchPoint[]; gaps: GapRange[]; pitchReady: boolean
}>()
const canvas = ref<HTMLCanvasElement | null>(null)
const size = ref({ width: 0, height: 0 })
let observer: ResizeObserver | undefined
onMounted(() => {
  if (!canvas.value) return
  observer = new ResizeObserver(([entry]) => {
    size.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  observer.observe(canvas.value)
})
onBeforeUnmount(() => observer?.disconnect())
watchEffect(() => {
  const { width, height } = size.value
  if (!canvas.value || width < 80 || height < 80) return
  drawPitch(canvas.value, width, height, {
    notes: props.notes, range: props.range, position: props.position, gaps: props.gaps,
    traces: [
      { points: props.saved, color: '#85cbd5', label: '已保住' },
      { points: props.live, color: '#b8dc9d', label: '我的声音' },
    ],
  })
})
</script>

<template>
  <section class="pitch-panel" aria-labelledby="pitch-title">
    <div class="pitch-heading">
      <h2 id="pitch-title" class="panel-heading"><Activity :size="17" /> 音高轨迹</h2>
      <div class="pitch-legends">
        <span><i class="legend reference"></i>参考音</span><span><i class="legend live"></i>我的声音</span>
        <span v-if="saved.length"><i class="legend a"></i>已保住</span>
        <span v-if="gaps.length"><i class="legend gap"></i>缺口</span>
        <span v-if="!pitchReady" class="pitch-pending">音高待重建，复听不受影响</span>
      </div>
    </div>
    <canvas ref="canvas" class="pitch-canvas" role="img"
      :aria-label="`参考音与草稿音高轨迹，缺口 ${gaps.length} 段，当前音高 ${latest ?? '未检测到'}`"></canvas>
    <div class="pitch-footer"><span>当前音高 <strong class="mono">{{ latest ?? '—' }}</strong></span><span>歌曲时间</span></div>
  </section>
</template>
