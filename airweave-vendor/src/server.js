import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import os from 'os';
import QRCode from 'qrcode';
import { verifyVoucher } from './verify.js';
import {
  getPendingVouchers,
  getAllVouchers,
  checkDuplicateNonce,
  insertVoucher
} from './db.js';

const app = express();
const port = 3000;

// Enable CORS so client PWA on a different IP/Port can connect
app.use(cors());
app.use(express.json());

// Serve static frontend assets from the root and src directories
app.use(express.static('.'));
app.use('/src', express.static('./src'));

const VENDOR_ADDRESS = process.env.VENDOR_ADDRESS || '0x264f3D6883F932f273558ab0cF078d473941F2A4';

// Helper to get local IPv4 address
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Look for IPv4 and non-internal network addresses
      const family = typeof net.family === 'string' ? net.family : `IPv${net.family}`;
      if (family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// Active SSE client connections
let sseClients = [];

function broadcastUpdate(audioB64 = null) {
  const pending = getAllVouchers(); // Show all vouchers received
  const total = pending
    .filter(v => v.status === 'pending')
    .reduce((sum, v) => sum + v.amount_inr, 0);

  const payload = JSON.stringify({
    pending,
    totalINR: total / 100, // convert paise back to INR
    vendorAddress: VENDOR_ADDRESS,
    ip: getLocalIp(),
    audioB64
  });

  sseClients.forEach(client => {
    client.write(`data: ${payload}\n\n`);
  });
}

// Generate Hindi text-to-speech audio via Sarvam TTS API (bulbul:v3)
async function generatePaymentAudio(amountInr, itemName) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    console.warn("SARVAM_API_KEY not found in environment, skipping TTS audio generation.");
    return null;
  }

  // Construct descriptive payment message in Hindi
  const text = `${itemName ? `${itemName} के लिए ` : ''}${amountInr} रुपये प्राप्त हुए।`;
  console.log(`Generating Hindi payment confirmation audio for text: "${text}"`);

  try {
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': apiKey
      },
      body: JSON.stringify({
        inputs: [text],
        target_language_code: 'hi-IN',
        speaker: 'shubh',
        speech_sample_rate: 24000,
        enable_preprocessing: true,
        model: 'bulbul:v3'
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Sarvam TTS request failed: ${res.status} ${errText}`);
      return null;
    }

    const data = await res.json();
    if (data.audios && data.audios[0]) {
      return data.audios[0]; // base64 string
    }
    console.error("Sarvam TTS response did not return base64 audio.");
    return null;
  } catch (err) {
    console.error("Failed to generate payment audio via Sarvam TTS:", err);
    return null;
  }
}

// REST: Submit EIP-712 Payment Voucher
app.post('/pay', async (req, res) => {
  const { voucher, signature, itemName, recipient, fallbackUsed } = req.body;
  console.log('Received voucher submission:', voucher);

  if (!voucher || !signature) {
    return res.status(400).json({ error: 'Missing voucher or signature' });
  }

  if (fallbackUsed) {
    console.warn("[FALLBACK] Payment processed using local regex fallback parser!");
  }

  // 1. Recover signature locally
  let recoveredSigner;
  try {
    recoveredSigner = verifyVoucher(voucher, signature);
    console.log('Signature verified. Recovered Signer:', recoveredSigner);
  } catch (err) {
    console.error('Signature verification failed:', err);
    return res.status(400).json({ error: 'Invalid EIP-712 signature verification failed' });
  }

  // 2. Validate signer matches the stated sender
  if (recoveredSigner.toLowerCase() !== voucher.from.toLowerCase()) {
    console.warn('Signer mismatch:', recoveredSigner, 'vs', voucher.from);
    return res.status(400).json({ error: 'Signature recovered address does not match from address' });
  }

  // 3. Verify expiry
  const nowSecs = Math.floor(Date.now() / 1000);
  if (nowSecs > parseInt(voucher.expiry)) {
    console.warn('Voucher expired. Expiry:', voucher.expiry, 'Current:', nowSecs);
    return res.status(400).json({ error: 'Voucher has expired' });
  }

  // 4. Verify nonce is not replayed
  const nonce = parseInt(voucher.nonce);
  if (checkDuplicateNonce(voucher.from, nonce)) {
    console.warn('Replay attack detected: Nonce already used for address', voucher.from, 'nonce:', nonce);
    return res.status(409).json({ error: 'Voucher replay: Nonce already used' });
  }

  // 5. Save voucher to Database
  try {
    const amountINR = parseInt(voucher.amountINR);
    const expiry = parseInt(voucher.expiry);

    insertVoucher({
      from: voucher.from,
      to: voucher.to,
      amountINR,
      nonce,
      expiry,
      signature,
      itemName: itemName || '',
      recipient: recipient || ''
    });

    const amountDecimal = amountINR / 100;
    console.log(`Successfully stored voucher: ₹${amountDecimal} from ${voucher.from} to ${voucher.to}`);

    // Generate Hindi speech confirmation
    const audioB64 = await generatePaymentAudio(amountDecimal, itemName);

    // Broadcast update to dashboard UI (include the audio so the browser dashboard can play it)
    broadcastUpdate(audioB64);

    res.json({ success: true, amountINR: amountDecimal, audioB64 });
  } catch (dbErr) {
    console.error('Database insertion error:', dbErr);
    res.status(500).json({ error: 'Failed to write voucher to local storage' });
  }
});

// SSE: Stream updates to Vendor Dashboard
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  sseClients.push(res);
  console.log(`Vendor Dashboard client connected (Total: ${sseClients.length})`);

  // Send initial data immediately
  const pending = getAllVouchers();
  const total = pending
    .filter(v => v.status === 'pending')
    .reduce((sum, v) => sum + v.amount_inr, 0);

  res.write(`data: ${JSON.stringify({
    pending,
    totalINR: total / 100,
    vendorAddress: VENDOR_ADDRESS,
    ip: getLocalIp()
  })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
    console.log(`Vendor Dashboard client disconnected (Remaining: ${sseClients.length})`);
  });
});

// REST: Get QR Code and Connection Details
app.get('/qr', async (req, res) => {
  try {
    const ip = getLocalIp();
    const payload = JSON.stringify({
      vendorAddress: VENDOR_ADDRESS,
      vendorIp: ip,
      vendorPort: port
    });
    
    const qrDataUrl = await QRCode.toDataURL(payload);
    res.json({
      qr: qrDataUrl,
      address: VENDOR_ADDRESS,
      ip: ip,
      port: port
    });
  } catch (err) {
    console.error('Failed to generate QR:', err);
    res.status(500).json({ error: 'QR Code generation failed' });
  }
});

app.listen(port, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log(`=======================================================`);
  console.log(` AirWeave Vendor Server is running!`);
  console.log(` - Local dashboard: http://localhost:${port}`);
  console.log(` - LAN Access:      http://${localIp}:${port}`);
  console.log(` - Vendor address:  ${VENDOR_ADDRESS}`);
  console.log(`=======================================================`);
});
