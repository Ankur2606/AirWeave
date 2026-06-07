import { parseIntentRegex } from './intent-regex.js';

export async function extractIntent(transcript, vendorIp = 'localhost') {
  const sttMode = sessionStorage.getItem('stt_mode');
  
  // If user selected API mode, attempt LLM extraction first.
  try {
    console.log("Attempting intent extraction via Sarvam 105B LLM...");
    const result = await extractIntentWithLLM(transcript, vendorIp);
    if (result) {
      console.log("Sarvam 105B extracted payment details successfully:", result);
      return { ...result, fallbackUsed: false };
    }
  } catch (err) {
    console.warn("Sarvam LLM intent extraction failed. Falling back to local Regex parser. Error:", err);
  }

  // Stage 2: local regex fallback
  console.log("Running local regex fallback parser...");
  const regexResult = parseIntentRegex(transcript);
  if (regexResult) {
    console.log("Regex fallback successfully parsed amount:", regexResult.amount);
    return regexResult; // contains fallbackUsed: true
  }

  return null;
}

async function extractIntentWithLLM(transcript, vendorIp = 'localhost') {
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
  const url = `http://${host}/api/intent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ transcript }),
  });

  if (!res.ok) {
    throw new Error(`Sarvam LLM Proxy error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  let content = data.content.trim();
  
  // Clean up potential markdown formatting block wrapper
  if (content.startsWith('```')) {
    content = content.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  }

  try {
    const parsed = JSON.parse(content);
    if (parsed.error) {
      console.warn("LLM parsed error response:", parsed.error);
      return null;
    }
    return {
      amount: parsed.amount,
      item: parsed.item || 'Payment',
      recipient: parsed.recipient || null,
      raw: transcript,
    };
  } catch (parseErr) {
    console.error("Failed to parse JSON content from LLM response:", content, parseErr);
    return null;
  }
}
