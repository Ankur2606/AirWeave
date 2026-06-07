class AudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Send raw channel-0 float samples back to main thread
      this.port.postMessage(input[0]);
    }
    return true;
  }
}
registerProcessor('audio-processor', AudioProcessor);
