import type { AudioBlock, DraftSegment } from '../model/types'

/** 单声道 32bit PCM 转 16bit WAV，用于复听与试听 */
export function pcmToWave(pcm: Float32Array, sampleRate: number) {
  const length = pcm.length
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const mark = (offset: number, tag: string) => {
    for (const [index, value] of Array.from(tag).entries()) view.setUint8(offset + index, value.charCodeAt(0))
  }
  mark(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  mark(8, 'WAVE')
  mark(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  mark(36, 'data')
  view.setUint32(40, length * 2, true)
  for (let index = 0; index < length; index++) {
    view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, pcm[index])) * 32767), true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** 把录音帧按歌曲时间拼成连续 PCM（起点前的空隙补静音） */
export function framesToPcm(
  frames: readonly { inputTime: number; samples: Float32Array }[],
  inputStart: number,
  duration: number,
  rate: number,
) {
  const pcm = new Float32Array(Math.max(0, Math.round(duration * rate)))
  for (const frame of frames) {
    const offset = Math.round((frame.inputTime - inputStart) * rate)
    const first = Math.max(0, -offset)
    const last = Math.min(frame.samples.length, pcm.length - offset)
    if (last > first) pcm.set(frame.samples.subarray(first, last), offset + first)
  }
  return pcm
}

/** 从声音块中取出某个片段对应的 PCM */
export function segmentPcm(block: AudioBlock, segment: DraftSegment) {
  return block.pcm.subarray(segment.sampleOffset, segment.sampleOffset + segment.sampleCount)
}
