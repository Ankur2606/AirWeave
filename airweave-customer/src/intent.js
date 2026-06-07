import { parseIntentRegex } from './intent-regex.js';

export async function extractIntent(transcript) {
  const sttMode = sessionStorage.getItem('stt_mode');
  
  // If user selected API mode, attempt LLM extraction first.
  // Otherwise, if in local mode, we can try LLM but fallback is expected.
  try {
    console.log("Attempting intent extraction via Sarvam 105B LLM...");
    const result = await extractIntentWithLLM(transcript);
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

async function extractIntentWithLLM(transcript) {
  const apiKey = import.meta.env.VITE_SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error("Missing VITE_SARVAM_API_KEY environment variable.");
  }

  const systemPrompt = `You are a payment intent extractor for an Indian offline payment PWA.
Extract payment details from voice transcriptions (Hindi, English, or code-mixed).
Return ONLY valid JSON with this exact schema:
{
  "amount": <number in rupees, e.g. 80>,
  "item": "<what is being paid for, in English, e.g. 'Maggie'>",
  "recipient": "<who is being paid, if mentioned, e.g. 'Bhaiya', else null>",
  "raw": "<original transcript>"
}
Rules:
- amount must be a positive number (float or int)
- item: extract product/service name, translate to English if in Hindi (e.g. 'chai' -> 'Tea')
- recipient: extract name/relation if mentioned (bhaiya, didi, chacha, etc.)
- If no amount found, return { "error": "no_amount" }
- Return ONLY the JSON object, no explanation, no markdown wrap (\`\`\`json ... \`\`\`)`;

  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-subscription-key': apiKey,
    },
    body: JSON.stringify({
      model: 'sarvam-105b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript }
      ],
      temperature: 0.1,
      max_tokens: 200,
    }),
  });

  if (!res.ok) {
    throw new Error(`Sarvam LLM API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  let content = data.choices[0].message.content.trim();
  
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
