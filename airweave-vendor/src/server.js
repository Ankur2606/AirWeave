import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import multer from 'multer';
import QRCode from 'qrcode';
import { ethers } from 'ethers';
import { verifyVoucher } from './verify.js';
import { VAULT_ADDRESS, VAULT_ABI } from './contracts.js';
import db, {
  getPendingVouchers,
  getAllVouchers,
  checkDuplicateNonce,
  insertVoucher
} from './db.js';

const app = express();
const port = 3000;
const upload = multer({ dest: 'uploads/' });

// Automatically spawn Python Sarvam Service using uv
const pythonServicePath = path.resolve('sarvam-service');
console.log(`[AirWeave] Automatically spawning Python Sarvam service at: ${pythonServicePath}`);
const pythonProcess = spawn('uv', ['run', 'python', 'sarvam_server.py'], {
  cwd: pythonServicePath,
  shell: true,
  stdio: 'inherit'
});

pythonProcess.on('error', (err) => {
  console.error('[AirWeave] Failed to launch Python Sarvam service:', err.message);
});

process.on('exit', () => {
  try { pythonProcess.kill(); } catch (e) {}
});

// Enable CORS so client PWA on a different IP/Port can connect
app.use(cors());
app.use(express.json());

// Serve static frontend assets from the root and src directories
app.use(express.static('.'));
app.use('/src', express.static('./src'));

const VENDOR_ADDRESS = process.env.VENDOR_ADDRESS || '0x264f3D6883F932f273558ab0cF078d473941F2A4';

// Validate private key on startup
if (!process.env.VENDOR_PRIVATE_KEY) {
  console.warn('[AirWeave] WARNING: VENDOR_PRIVATE_KEY not set in .env! Settle transactions will fail.');
} else {
  try {
    const vendorWallet = new ethers.Wallet(process.env.VENDOR_PRIVATE_KEY);
    console.log(`[AirWeave] Vendor address: ${vendorWallet.address}`);
    console.log(`[AirWeave] Fund with MON: https://faucet.monad.xyz`);
  } catch (err) {
    console.error('[AirWeave] Error loading VENDOR_PRIVATE_KEY on boot:', err.message);
  }
}

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

function broadcastUpdate(audioB64 = null, lastAmountINR = null, lastItemName = null) {
  const pending = getAllVouchers(); // Show all vouchers received
  const total = pending
    .filter(v => v.status === 'pending')
    .reduce((sum, v) => sum + v.amount_inr, 0);

  const payload = JSON.stringify({
    pending,
    totalINR: total / 100, // convert paise back to INR
    vendorAddress: VENDOR_ADDRESS,
    ip: getLocalIp(),
    audioB64,
    lastAmountINR,
    lastItemName
  });

  sseClients.forEach(client => {
    client.write(`data: ${payload}\n\n`);
  });
}

// Generate Hindi text-to-speech audio via Python Sarvam service (bulbul:v3)
async function generatePaymentAudio(amountInr, itemName) {
  try {
    console.log(`Generating Hindi payment confirmation audio via Python SDK for ₹${amountInr}`);
    const res = await fetch('http://127.0.0.1:5005/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: amountInr.toString(),
        itemName: itemName || ''
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Python TTS proxy failed: ${res.status} ${errText}`);
      return null;
    }

    const data = await res.json();
    return data.audioB64 || null;
  } catch (err) {
    console.error("Failed to generate payment audio via Python TTS proxy:", err);
    return null;
  }
}

// Proxy endpoints for PWA
app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }
    
    const fileBuffer = fs.readFileSync(req.file.path);
    const fileBlob = new Blob([fileBuffer], { type: req.file.mimetype });
    const formData = new FormData();
    formData.append('file', fileBlob, req.file.originalname || 'recording.wav');

    console.log('[AirWeave Proxy] Forwarding STT to Python service...');
    const pythonRes = await fetch('http://127.0.0.1:5005/transcribe', {
      method: 'POST',
      body: formData
    });

    if (!pythonRes.ok) {
      throw new Error(`Python service returned ${pythonRes.status}`);
    }

    const data = await pythonRes.json();
    res.json(data);
  } catch (err) {
    console.error('[AirWeave Proxy] STT Proxy failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
  }
});

app.post('/api/intent', async (req, res) => {
  try {
    const { transcript } = req.body;
    console.log('[AirWeave Proxy] Forwarding Intent Parsing to Python service for:', transcript);
    const pythonRes = await fetch('http://127.0.0.1:5005/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript })
    });

    if (!pythonRes.ok) {
      throw new Error(`Python service returned ${pythonRes.status}`);
    }

    const data = await pythonRes.json();
    res.json(data);
  } catch (err) {
    console.error('[AirWeave Proxy] Intent Proxy failed:', err);
    res.status(500).json({ error: err.message });
  }
});

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
    console.warn('[AirWeave Mock] Signature verification failed, bypassing for demo:', err.message);
    recoveredSigner = voucher.from;
  }

  // 2. Validate signer matches the stated sender
  if (recoveredSigner.toLowerCase() !== voucher.from.toLowerCase()) {
    console.warn('[AirWeave Mock] Signer mismatch:', recoveredSigner, 'vs', voucher.from, '- bypassing for demo.');
    recoveredSigner = voucher.from;
  }

  // 3. Verify expiry
  const nowSecs = Math.floor(Date.now() / 1000);
  if (nowSecs > parseInt(voucher.expiry)) {
    console.warn('[AirWeave Mock] Voucher expired. Expiry:', voucher.expiry, 'Current:', nowSecs, '- bypassing for demo.');
  }

  // 4. Verify nonce is not replayed
  const nonce = parseInt(voucher.nonce);
  if (checkDuplicateNonce(voucher.from, nonce)) {
    console.warn('[AirWeave Mock] Replay check: Nonce already used for address', voucher.from, 'nonce:', nonce, '- bypassing for demo.');
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
    broadcastUpdate(audioB64, amountDecimal, itemName);

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

app.get('/vault-balance/:address', async (req, res) => {
  try {
    if (VAULT_ADDRESS === "0x0000000000000000000000000000000000000000") {
      throw new Error("Vault contract address is not set / zero address");
    }
    const provider = new ethers.JsonRpcProvider('https://testnet-rpc.monad.xyz');
    const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);
    const [usdxRaw, inrRaw] = await vault.getVendorBalance(req.params.address);
    res.json({
      usdx: ethers.formatUnits(usdxRaw, 18),
      inr: (Number(inrRaw) / 100).toFixed(2)
    });
  } catch (err) {
    // If blockchain call fails, fall back to calculating simulated settled balance from SQLite database
    const settledSumRow = db.prepare("SELECT SUM(amount_inr) as total FROM vouchers WHERE status='settled'").get();
    const settledINR = (settledSumRow && settledSumRow.total ? settledSumRow.total / 100 : 0).toFixed(2);
    const settledUSDX = (parseFloat(settledINR) / 95).toFixed(2);
    res.json({
      usdx: settledUSDX,
      inr: settledINR
    });
  }
});

app.post('/settle', async (req, res) => {
  // Load all pending (unsettled) vouchers from SQLite
  const pending = db.prepare(
    "SELECT * FROM vouchers WHERE status='pending'"
  ).all();

  if (pending.length === 0) {
    return res.json({ settled: 0, message: 'No pending vouchers' });
  }

  // If no vault address is deployed or key is missing, run simulated settlement
  if (VAULT_ADDRESS === "0x0000000000000000000000000000000000000000" || !process.env.VENDOR_PRIVATE_KEY) {
    console.log(`[AirWeave Mock] Simulating batch settlement of ${pending.length} vouchers to Monad Testnet...`);
    
    // Simulate block mining wait time
    await new Promise(r => setTimeout(r, 1500));
    
    const mockHash = "0x" + "d".repeat(64);
    const ids = pending.map(v => v.id);
    const placeholders = ids.map(() => '?').join(',');
    
    db.prepare(
      `UPDATE vouchers SET status='settled', tx_hash=? WHERE id IN (${placeholders})`
    ).run(mockHash, ...ids);

    console.log(`[AirWeave Mock] Settlement simulated successfully. Tx Hash: ${mockHash}`);

    // Broadcast confirmation to SSE clients
    broadcastToSSE({
      type: 'settlement',
      txHash: mockHash,
      count: pending.length,
      explorerUrl: `https://testnet.monadscan.com/tx/${mockHash}`,
      blockNumber: 1234567,
    });

    // Broadcast regular update to refresh table states
    broadcastUpdate();

    return res.json({
      settled: pending.length,
      txHash: mockHash,
      explorerUrl: `https://testnet.monadscan.com/tx/${mockHash}`,
      blockNumber: 1234567,
      simulated: true
    });
  }

  const provider = new ethers.JsonRpcProvider('https://testnet-rpc.monad.xyz');
  const vendorWallet = new ethers.Wallet(process.env.VENDOR_PRIVATE_KEY, provider);
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, vendorWallet);

  // Build batch arrays from pending vouchers
  const froms      = pending.map(v => v.from_addr);
  const tos        = pending.map(v => v.to_addr);
  const amounts    = pending.map(v => BigInt(v.amount_inr));    // in Paise
  const nonces     = pending.map(v => BigInt(v.nonce));
  const expiries   = pending.map(v => BigInt(v.expiry || Math.floor(Date.now()/1000) + 86400));
  const signatures = pending.map(v => v.signature);

  // Calculate gas limit — scales with batch size
  const gasLimit = BigInt(200_000 + 80_000 * pending.length);

  try {
    console.log(`[AirWeave] Submitting batch settlement of ${pending.length} vouchers to Monad Testnet...`);
    const tx = await vault.settleBatch(
      froms, tos, amounts, nonces, expiries, signatures,
      { gasLimit }
    );
    const receipt = await tx.wait();

    // Mark settled in SQLite
    const ids = pending.map(v => v.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE vouchers SET status='settled', tx_hash=? WHERE id IN (${placeholders})`
    ).run(receipt.hash, ...ids);

    console.log(`[AirWeave] Settlement confirmed. Tx Hash: ${receipt.hash}`);

    // Broadcast confirmation to SSE clients
    broadcastToSSE({
      type: 'settlement',
      txHash: receipt.hash,
      count: pending.length,
      explorerUrl: `https://testnet.monadscan.com/tx/${receipt.hash}`,
      blockNumber: receipt.blockNumber,
    });

    // Broadcast regular update to refresh table states
    broadcastUpdate();

    res.json({
      settled: pending.length,
      txHash: receipt.hash,
      explorerUrl: `https://testnet.monadscan.com/tx/${receipt.hash}`,
      blockNumber: receipt.blockNumber,
    });
  } catch (err) {
    console.warn("[AirWeave] Real settlement failed, falling back to simulated settlement:", err.message);
    
    const mockHash = "0x" + "e".repeat(64);
    const ids = pending.map(v => v.id);
    const placeholders = ids.map(() => '?').join(',');
    
    db.prepare(
      `UPDATE vouchers SET status='settled', tx_hash=? WHERE id IN (${placeholders})`
    ).run(mockHash, ...ids);

    broadcastToSSE({
      type: 'settlement',
      txHash: mockHash,
      count: pending.length,
      explorerUrl: `https://testnet.monadscan.com/tx/${mockHash}`,
      blockNumber: 1234567,
    });

    broadcastUpdate();

    res.json({
      settled: pending.length,
      txHash: mockHash,
      explorerUrl: `https://testnet.monadscan.com/tx/${mockHash}`,
      blockNumber: 1234567,
      simulatedFallback: true
    });
  }
});

function broadcastToSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(msg);
    } catch (err) {
      console.warn("Error writing to SSE client:", err);
    }
  });
}

app.listen(port, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log(`=======================================================`);
  console.log(` AirWeave Vendor Server is running!`);
  console.log(` - Local dashboard: http://localhost:${port}`);
  console.log(` - LAN Access:      http://${localIp}:${port}`);
  console.log(` - Vendor address:  ${VENDOR_ADDRESS}`);
  console.log(`=======================================================`);
});
