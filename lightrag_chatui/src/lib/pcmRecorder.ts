type PCMRecorderHandle = {
  stop: () => Promise<void>
}

const getAudioContextCtor = () =>
  typeof window === 'undefined'
    ? null
    : window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext

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

  const AudioContextCtor = getAudioContextCtor()

  if (!AudioContextCtor) {
    return '当前浏览器不支持 AudioContext。'
  }

  return null
}

export const getAudioProcessingSupportError = () => {
  if (typeof window === 'undefined') {
    return '当前环境不支持音频处理。'
  }

  if (!getAudioContextCtor()) {
    return '当前浏览器不支持音频解码，请使用最新版 Chrome、Edge 或 Safari。'
  }

  return null
}

const mixToMono = (audioBuffer: AudioBuffer) => {
  const { numberOfChannels, length } = audioBuffer

  if (numberOfChannels <= 1) {
    return new Float32Array(audioBuffer.getChannelData(0))
  }

  const mono = new Float32Array(length)

  for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex)
    for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
      mono[sampleIndex] += channelData[sampleIndex]
    }
  }

  for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
    mono[sampleIndex] /= numberOfChannels
  }

  return mono
}

export const convertAudioFileToPCMChunks = async (
  file: File,
  targetSampleRate = 16000,
  chunkByteLength = 6400
) => {
  const supportError = getAudioProcessingSupportError()
  if (supportError) {
    throw new Error(supportError)
  }

  const AudioContextCtor = getAudioContextCtor()
  if (!AudioContextCtor) {
    throw new Error('当前浏览器不支持音频解码。')
  }

  const fileBuffer = await file.arrayBuffer()
  const audioContext = new AudioContextCtor()

  try {
    const decoded = await audioContext.decodeAudioData(fileBuffer.slice(0))
    const mono = mixToMono(decoded)
    const downsampled = downsampleBuffer(mono, decoded.sampleRate, targetSampleRate)
    const pcm = floatTo16BitPCM(downsampled)
    const bytes = new Uint8Array(pcm.buffer)
    const chunks: ArrayBuffer[] = []

    for (let offset = 0; offset < bytes.byteLength; offset += chunkByteLength) {
      chunks.push(bytes.slice(offset, offset + chunkByteLength).buffer)
    }

    return chunks
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `音频解码失败：${error.message}`
        : '音频解码失败，请尝试上传 mp3、wav 或 m4a 文件。'
    )
  } finally {
    await audioContext.close()
  }
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
    getAudioContextCtor()

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
