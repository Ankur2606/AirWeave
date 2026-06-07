import { pipeline, env } from '@huggingface/transformers';

// Keep models in cache, never re-download
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;

export async function loadModel(onProgress) {
  if (transcriber) return transcriber;

  try {
    console.log("Attempting to load model with webgpu...");
    transcriber = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/moonshine-base-ONNX',
      {
        dtype: 'q4',        // 4-bit quantized — smallest, fast enough
        device: 'webgpu',   // GPU acceleration if available
        progress_callback: onProgress,
      }
    );
    console.log("Successfully loaded Moonshine model on WebGPU");
  } catch (error) {
    console.warn("WebGPU initialization failed. Falling back to WASM/CPU:", error);
    try {
      transcriber = await pipeline(
        'automatic-speech-recognition',
        'onnx-community/moonshine-base-ONNX',
        {
          dtype: 'q4',
          device: 'wasm',
          progress_callback: onProgress,
        }
      );
      console.log("Successfully loaded Moonshine model on WASM");
    } catch (wasmError) {
      console.error("WASM fallback failed:", wasmError);
      throw wasmError;
    }
  }
  return transcriber;
}

export async function transcribe(audioFloat32Array, onProgress) {
  const model = await loadModel(onProgress);
  const result = await model(audioFloat32Array, { language: 'english' });
  return result.text.trim();
}

export async function transcribeWithSarvam(audioBlob, vendorIp = 'localhost') {
  let ip = vendorIp.trim();
  if (ip.startsWith('http://')) {
    ip = ip.substring(7);
  }
  if (ip.startsWith('https://')) {
    ip = ip.substring(8);
  }
  if (ip.endsWith('/')) {
    ip = ip.substring(0, ip.length - 1);
  }
  const host = ip.includes(':') ? ip : `${ip}:3000`;
  const url = `http://${host}/api/transcribe`;

  console.log(`Forwarding speech transcription request to local vendor server proxy: ${url}`);

  const formData = new FormData();
  formData.append('file', audioBlob, 'recording.wav');

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Vendor transcribe proxy failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.transcript || "";
}

