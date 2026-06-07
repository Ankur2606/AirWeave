export async function startRecording(onChunk, onMediaData) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  
  // 1. AudioWorklet path (for offline Moonshine Float32 PCM samples)
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('/audio-processor.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'audio-processor');
  node.port.onmessage = e => onChunk(e.data);
  source.connect(node);

  // 2. MediaRecorder path (for Sarvam API audio/webm Blob)
  let mediaRecorder = null;
  const mediaChunks = [];
  try {
    // Use standard audio/webm or fallback to default
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) {
        mediaChunks.push(e.data);
        if (onMediaData) onMediaData(e.data);
      }
    };
    mediaRecorder.start();
  } catch (err) {
    console.warn("MediaRecorder initialization failed (falling back to local PCM only):", err);
  }

  return { ctx, stream, node, mediaRecorder, mediaChunks };
}

export function stopRecording({ ctx, stream, mediaRecorder, mediaChunks }) {
  return new Promise((resolve) => {
    // Turn off recording light immediately
    stream.getTracks().forEach(t => t.stop());
    ctx.close();

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(mediaChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        resolve(audioBlob);
      };
      mediaRecorder.stop();
    } else {
      resolve(null);
    }
  });
}

export function mergeChunks(chunks) {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
