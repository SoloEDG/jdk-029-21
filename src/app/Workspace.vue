<script setup lang="ts">
import { AudioLines } from '@lucide/vue'
import { songs, SongCatalog, SongHeading, TransportBar } from '../features/playback'
import { LyricStage, PhraseList } from '../features/lyrics'
import { RecordControls } from '../features/capture'
import { PitchPanel } from '../features/pitch'
import { DraftPanel } from '../features/draft'
import { useWorkspace } from './useWorkspace'

const {
  transport, lyrics, pitch, draft, capture, choices, graphRange, graphPosition, graphGaps, pitchReady,
  selectLine, adjacent, selectSong, seek, toggleLoop, togglePlay, toggleRecording,
  setChoice, confirmCandidate, lockSegment, rebuildPitch,
} = useWorkspace()
</script>

<template>
  <header class="app-header">
    <div class="app-header-inner">
      <span class="brand-mark"><AudioLines :size="22" :stroke-width="2.1" /></span>
      <div class="brand-name"><strong>夜航练习室</strong><span>NIGHT SESSION</span></div>
    </div>
  </header>
  <main class="workspace">
    <aside class="left-rail">
      <SongCatalog :songs="songs" :current="transport.song.value" @select="selectSong" />
      <PhraseList :lines="transport.song.value.lines" :selected="lyrics.selected.value" :active="lyrics.active.value" @select="selectLine" />
    </aside>
    <div class="workbench">
      <SongHeading :song="transport.song.value" />
      <LyricStage :selected="lyrics.selected.value" :active="lyrics.active.value" :upcoming="lyrics.upcoming.value"
        :playing="transport.isPlaying.value" :progress="lyrics.lineProgress.value" />
      <PitchPanel :notes="transport.song.value.notes" :position="graphPosition" :range="graphRange"
        :latest="capture.status.value === 'recording' ? pitch.latest.value : null"
        :live="capture.status.value === 'recording' ? pitch.points.value : []"
        :saved="draft.storedPitch.value" :gaps="graphGaps" :pitch-ready="pitchReady" />
      <TransportBar :song="transport.song.value" :position="transport.position.value" :playing="transport.isPlaying.value"
        :loop="transport.loop.value" :volume="transport.volume.value" :issue="transport.issue.value"
        @toggle="togglePlay" @previous="adjacent(-1)" @next="adjacent(1)" @loop="toggleLoop"
        @seek="seek" @volume="transport.setVolume" />
      <RecordControls :status="capture.status.value" :issue="capture.issue.value" :level="capture.level.value"
        :selected="lyrics.selected.value" :has-draft="!!draft.draft.value?.segments.length" @toggle="toggleRecording" />
    </div>
    <aside class="right-rail">
      <DraftPanel :line="lyrics.selected.value" :candidates="draft.visibleCandidates.value"
        :memory-only-ids="draft.memoryOnlyCandidates.value.map(item => item.id)"
        :replay-items="draft.replayItems.value" :replay-state="draft.replayState.value"
        :choices="choices" :issue="draft.issue.value" :notice="draft.notice.value"
        @preview="draft.previewCandidate" @discard="draft.discardCandidate"
        @confirm="confirmCandidate" @replay="draft.replay" @stop-replay="draft.stopReplay"
        @lock="lockSegment" @rebuild="rebuildPitch" @choice="setChoice" />
    </aside>
  </main>
</template>
