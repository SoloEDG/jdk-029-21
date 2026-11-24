import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { songs, useTransport } from '../features/playback'
import { useLyrics } from '../features/lyrics'
import { useCapture } from '../features/capture'
import { usePitch } from '../features/pitch'
import { useDraft } from '../features/draft'
import { framesToPcm, pcmToWave } from '../features/draft'
import type { SegmentChoice, Song } from '../shared/document'
import type { Candidate } from '../features/draft'

export function useWorkspace() {
  const transport = useTransport(songs[0], {
    beforeSeek: finishCapture, onPause: finishCapture, onLoop: finishCapture,
  })
  const lyrics = useLyrics(transport.song, transport.position)
  const pitch = usePitch()
  const draft = useDraft(transport.song, lyrics.selected, () => {
    capture.cancelRequest()
    transport.pause()
  })
  const choices = reactive<Record<string, { start: number; end: number; choice: SegmentChoice }[]>>({})
  const pendingChoiceFor = ref<string | null>(null)
  const capture = useCapture({
    onFrame: pitch.receive,
    position: transport.read,
    onComplete: async result => {
      const duration = result.end - result.start
      const pcm = framesToPcm(result.frames, result.inputStart, duration, result.sampleRate)
      const candidate: Omit<Candidate, 'persisted'> = {
        id: crypto.randomUUID(),
        songId: result.songId,
        lineId: result.lineId,
        start: result.start,
        end: result.end,
        createdAt: Date.now(),
        pcm,
        audio: pcmToWave(pcm, result.sampleRate),
        sampleRate: result.sampleRate,
        pitch: pitch.slice({ start: result.start, end: result.end }),
      }
      const full = await draft.addCandidate(candidate)
      choices[full.id] = draft.defaultChoices(full)
      pendingChoiceFor.value = full.id
    },
  })

  const graphRange = computed(() => {
    if (draft.replayState.value !== null || !transport.isPlaying.value || capture.status.value === 'recording') {
      return lyrics.selected.value ?? { start: 0, end: transport.song.value.duration }
    }
    return lyrics.active.value ?? lyrics.upcoming.value ?? lyrics.selected.value!
  })
  const graphPosition = computed(() => {
    const state = draft.replayState.value
    if (state) return state.item.start
    return transport.position.value
  })
  const graphGaps = computed(() => draft.timeline.value.gaps)
  const pitchReady = computed(() =>
    (draft.draft.value?.segments ?? []).every(segment => !segment.pitchMissing))

  function finishCapture(position: number): void { void capture.stop(position) }

  function selectLine(id: string) {
    const line = lyrics.select(id)
    if (!line) return
    capture.cancelRequest()
    draft.stopReplay()
    if (transport.loop.value) transport.loop.value = line
    transport.seek(line.start)
  }

  function adjacent(direction: -1 | 1) {
    const line = lyrics.adjacent(direction)
    if (line) selectLine(line.id)
  }

  function selectSong(next: Song) {
    if (next.id === transport.song.value.id) return
    capture.cancelRequest()
    draft.stopReplay()
    transport.setSong(next)
    lyrics.reset()
  }

  function seek(position: number) {
    capture.cancelRequest()
    draft.stopReplay()
    const loop = transport.loop.value
    if (loop && (position < loop.start || position >= loop.end)) transport.loop.value = null
    transport.seek(position)
  }

  function toggleLoop() {
    if (transport.loop.value) {
      transport.loop.value = null
      return
    }
    const line = lyrics.selected.value
    if (!line) return
    transport.loop.value = line
    selectLine(line.id)
  }

  function togglePlay() {
    capture.cancelRequest()
    draft.stopReplay()
    if (transport.isPlaying.value) transport.pause()
    else void transport.play()
  }

  function toggleRecording() {
    if (capture.status.value === 'recording') {
      finishCapture(transport.read())
      return
    }
    if (capture.status.value === 'requesting') {
      capture.cancelRequest()
      return
    }
    const line = lyrics.selected.value
    if (!line || capture.status.value !== 'idle') return
    draft.stopReplay()
    transport.pause()
    pitch.clear()
    // 从已保存的一字之前重唱：起点取当前播放位置（可在任意已确认段之前），范围仍是本句
    void capture.start({ songId: transport.song.value.id, lineId: line.id, range: line }, async () => {
      const start = Math.max(line.start, Math.min(transport.read(), line.end - 0.2))
      transport.seek(start)
      return transport.play()
    })
  }

  function setChoice(candidateId: string, entry: { start: number; end: number; choice: SegmentChoice }) {
    const list = choices[candidateId]
    if (!list) return
    const index = list.findIndex(item => item.start === entry.start && item.end === entry.end)
    if (index >= 0) list[index] = { ...entry }
  }

  async function confirmCandidate(candidate: Candidate) {
    const list = choices[candidate.id]
    if (!list) return
    const ok = await draft.confirm(candidate, list)
    if (ok) {
      delete choices[candidate.id]
      pendingChoiceFor.value = null
    }
  }

  function lockSegment(range: { start: number; end: number }) {
    draft.toggleLock(range)
  }

  function rebuildPitch(candidateId?: string) {
    void draft.rebuildPitch(candidateId)
    void draft.rebuildDraftPitch()
  }

  watch(transport.position, position => {
    const line = lyrics.selected.value
    if (line && position >= line.end) finishCapture(line.end)
  })

  function handleVisibility() {
    if (!document.hidden) return
    capture.cancelRequest()
    transport.pause()
  }
  onMounted(() => document.addEventListener('visibilitychange', handleVisibility))
  onBeforeUnmount(() => document.removeEventListener('visibilitychange', handleVisibility))

  return {
    transport, lyrics, pitch, draft, capture, choices, graphRange, graphPosition, graphGaps, pitchReady,
    selectLine, adjacent, selectSong, seek, toggleLoop, togglePlay, toggleRecording,
    setChoice, confirmCandidate, lockSegment, rebuildPitch,
  }
}
