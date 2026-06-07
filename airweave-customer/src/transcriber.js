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

export async function transcribeWithSarvam(audioBlob) {
  const apiKey = import.meta.env.VITE_SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error("Missing VITE_SARVAM_API_KEY environment variable.");
  }

  const formData = new FormData();
  // We append it as audio/wav since Saaras v3 handles common wav/webm formats
  formData.append('file', audioBlob, 'recording.wav');
  formData.append('model', 'saaras:v3');
  formData.append('mode', 'transcribe');

  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: {
      'api-subscription-key': apiKey
    },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Sarvam STT API failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.transcript || "";
}

