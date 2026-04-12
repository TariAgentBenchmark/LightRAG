type PCMRecorderHandle = {
  stop: () => Promise<void>
}

const isLocalhostHostname = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'

export const getPCMRecorderSupportError = () => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return '当前环境不支持语音输入。'
  }

  if (!window.isSecureContext && !isLocalhostHostname(window.location.hostname)) {
    return '语音输入需要在 HTTPS 或 localhost 环境下使用。'
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return '当前浏览器不支持麦克风采集，请使用最新版 Chrome、Edge 或 Safari。'
  }

  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (!AudioContextCtor) {
    return '当前浏览器不支持 AudioContext。'
  }

  return null
}

const downsampleBuffer = (
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
) => {
  if (outputSampleRate >= inputSampleRate) {
    return input
  }

  const ratio = inputSampleRate / outputSampleRate
  const outputLength = Math.round(input.length / ratio)
  const output = new Float32Array(outputLength)

  let outputOffset = 0
  let inputOffset = 0

  while (outputOffset < output.length) {
    const nextInputOffset = Math.round((outputOffset + 1) * ratio)
    let accumulated = 0
    let count = 0

    for (let index = inputOffset; index < nextInputOffset && index < input.length; index += 1) {
      accumulated += input[index]
      count += 1
    }

    output[outputOffset] = count > 0 ? accumulated / count : 0
    outputOffset += 1
    inputOffset = nextInputOffset
  }

  return output
}

const floatTo16BitPCM = (input: Float32Array) => {
  const output = new Int16Array(input.length)

  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }

  return output
}

export const startPCMRecorder = async (
  onChunk: (chunk: ArrayBuffer) => void,
  targetSampleRate = 16000
): Promise<PCMRecorderHandle> => {
  const supportError = getPCMRecorderSupportError()
  if (supportError) {
    throw new Error(supportError)
  }

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    }
  })

  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (!AudioContextCtor) {
    throw new Error('当前浏览器不支持 AudioContext。')
  }

  const audioContext = new AudioContextCtor()
  const source = audioContext.createMediaStreamSource(mediaStream)
  const processor = audioContext.createScriptProcessor(4096, 1, 1)

  processor.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0)
    const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, targetSampleRate)
    const pcm = floatTo16BitPCM(downsampled)
    onChunk(pcm.buffer.slice(0))
  }

  source.connect(processor)
  processor.connect(audioContext.destination)

  return {
    stop: async () => {
      processor.disconnect()
      source.disconnect()
      mediaStream.getTracks().forEach((track) => track.stop())
      await audioContext.close()
    }
  }
}
