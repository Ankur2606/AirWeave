# AirWeave 

> **Pay without signal.** Voice-activated offline P2P payments for India's connectivity-dead zones cryptographically guaranteed, settled on Monad.

[![Live Demo](https://img.shields.io/badge/LIVE_DEMO-airweaveproject.netlify.app-00e5c0?style=for-the-badge&logoColor=black)](https://airweaveproject.netlify.app)
[![Monad Testnet](https://img.shields.io/badge/Monad_Testnet-Chain_ID_10143-7c3aed?style=for-the-badge)](https://testnet.monadscan.com)
[![Built At](https://img.shields.io/badge/Monad_Blitz-Bangalore_V4_2026-ff4f1f?style=for-the-badge)](https://luma.com/0k7yvinp)

---

## The Problem — The Kodaikanal Paradigm

It is monsoon season in Kodaikanal. Dense cloud canopy, steep ghats, and a tourist influx that overwhelms every cell tower within 40 kilometers. UPI India's digital payment miracle goes silent.

A chai vendor stares at his QR code. A tourist stares at a payment timeout. Both have loaded accounts and willing intent. Zero bars of signal means ₹35 that cannot move.

**This is India's digital payment paradox.** UPI reaches 450 million users but fails exactly where the physical world demands it most  high-altitude tourist zones, dense forest markets, monsoon-flooded rural corridors. NPCI's UPI Lite attempted offline micro-transactions with NFC, but it requires bank backend servers and periodic centralized connectivity.

AirWeave solves this at the **cryptographic layer**. No bank server. No NFC chip. No central authority. Pure mathematics, running locally on the device in your pocket.

---

## How It Works

```
[User speaks: "bhaiya ko do 35 rupaye"]
         │
         ▼  [Moonshine ONNX — on-device, offline]
[Transcription: "pay 35 rupees to vendor"]
         │
         ▼  [Sarvam 105B / regex intent parser]
[Intent: { amount: 35, currency: "INR" }]
         │
         ▼  [WebAuthn passkey — biometric, offline]
[Authentication: secure enclave verified ✓]
         │
         ▼  [EIP-712 typed signing — pure math, offline]
[Voucher: { from, to, amountINR: 3500, nonce: 7, expiry } + signature]
         │
         ▼  [WiFi hotspot — local network, no internet]
[Vendor receives → ecrecover verifies → SQLite stores]
         │
         ▼  [On connectivity — Monad parallel EVM]
[MonadAirVault settles batch → vendor: ₹35.00 CONFIRMED ✓]
```

### Layer 1 — Local AI Intelligence (Offline)

The customer speaks a payment instruction in any combination of Hindi, Tamil, Kannada, or English. The [Moonshine ONNX](https://huggingface.co/onnx-community/moonshine-base-ONNX) model runs entirely inside the browser via WebGPU through `@huggingface/transformers`. The model downloads once (~130MB) on first launch and is cached in the browser's Cache Storage API. Every subsequent inference runs from local hardware with no network dependency.

The transcription feeds into a Sarvam 105B intent extraction call (online) or a pure regex parser (offline fallback) which returns a structured JSON payload:

```json
{ "amount": 35, "currency": "INR", "raw": "bhaiya ko do 35 rupaye" }
```

### Layer 2 — Cryptographic Signing Engine (Offline)

Payment authorization uses [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed structured data signing — the same standard that secures MetaMask transaction confirmations.

**The Domain Separator** locks every voucher to this specific protocol and chain, preventing replay attacks across networks:

```js
const DOMAIN = {
  name: 'AirWeave',
  version: '1',
  chainId: 10143,  // Monad Testnet — hardlocked
};
```

**The Voucher Structure** encodes the complete payment promise:

```solidity
Voucher: [
  { name: 'from',      type: 'address' },  // Customer EOA
  { name: 'to',        type: 'address' },  // Vendor address
  { name: 'amountINR', type: 'uint256' },  // Amount in Paise (₹35 = 3500)
  { name: 'nonce',     type: 'uint256' },  // Anti-replay counter
  { name: 'expiry',    type: 'uint256' },  // Unix timestamp
]
```

Authentication uses **WebAuthn passkeys** — the customer's private key is generated once and stored in the device secure enclave, protected by biometric (Face ID / fingerprint / Windows Hello). The passkey assertion verifies identity before every payment. No PIN to type in the rain. No password to forget on a mountain.

### Layer 3 — Local P2P Transport (LAN Only)

The signed voucher JSON (under 500 bytes) is sent via HTTP POST to the vendor's local Express server running on the same WiFi hotspot. No internet. The vendor device runs `ethers.verifyTypedData()` — pure offline elliptic curve math:

```
ecrecover(Hash_EIP712, v, r, s) → recoveredAddress
if recoveredAddress ≠ voucher.from → REJECT
```

Successful vouchers are committed to an append-only SQLite database (`airweave.db`). The vendor screen updates in real time via Server-Sent Events. The vendor sees: **₹35.00 PENDING.**

### Layer 4 — Monad Parallel Settlement (On Connectivity)

When the vendor's device detects internet, `MonadAirVault.sol` receives the pending voucher batch. The contract queries a live USD/INR price oracle, calculates the exact USDX required to honor each INR promise, and executes atomic settlement.

Because each voucher touches independent state (different customer vault balances and nonces), Monad's parallel EVM processes the entire regional backlog simultaneously — no sequencing, no state contention, no gas spikes. The full batch settles inside a single **0.4-second block**.

---

## The Stablecoin Design — Why Not MON

Receiving payment in MON exposes the vendor to crypto volatility. If MON price drops while they're trekking down the mountain, they absorb the loss. AirWeave solves this with a **deferred INR promise** architecture:

1. The offline voucher denominates value in **Paise** (₹35 = `amountINR: 3500`) — no crypto amount at signing time
2. On settlement, `MonadAirVault` queries the live USD/INR rate from an on-chain oracle
3. USDX (USD-pegged stablecoin) is calculated and transferred at that exact rate
4. Vendor always receives **exactly the promised INR value** regardless of market movement between signing and settlement

```solidity
uint256 usdxAmount = (voucher.amountINR * 1e18) / currentUsdInrRate;
vaultBalances[customer] -= usdxAmount;
vendorBalances[voucher.to] += usdxAmount;
```

---

## Security Model

**Signature forgery is impossible.** An EIP-712 voucher can only be created by the holder of the customer's private key, which never leaves the device secure enclave. Intercepting the WiFi payload gives you a signed blob you cannot modify or reuse for a different amount.

**Nonces prevent replay.** Each voucher carries a strictly incrementing nonce. `MonadAirVault` tracks every processed nonce per address. Submitting the same voucher twice reverts: `"nonce already used"`.

**Over-collateralized vault prevents overdrafts.** Users pre-deposit USDX before going offline. The customer app caps total offline spending at 60% of vault balance — a permanent buffer against rate fluctuation. Even if MON-adjacent rates move between signing and settlement, the contract remains fully collateralized.

**Expiry prevents stale vouchers.** Every voucher carries a Unix expiry timestamp (default: 24 hours). The smart contract rejects any voucher past its expiry, protecting vendors from holding indefinitely deferred obligations.

---

## Deployed Contracts — Monad Testnet

| Contract | Address | Purpose |
|----------|---------|---------|
| USDX Token | [`0x94C647a5d232769705707925d551E99618E2688c`](https://testnet.monadscan.com/token/0x94C647a5d232769705707925d551E99618E2688c) | USD-pegged stablecoin for settlement |
| INRX Token (v1) | [`0xc6D7Fe74d0e034470478CE024F232D729042D4B3`](https://testnet.monadscan.com/token/0xc6D7Fe74d0e034470478CE024F232D729042D4B3) | Indian Rupee X — original peg token |
| MonadAirVault | `TBD — Phase 2` | Voucher settlement and vault management |

**Network:**
```
Name:     Monad Testnet
Chain ID: 10143
RPC:      https://testnet-rpc.monad.xyz
Explorer: https://testnet.monadscan.com
Faucet:   https://faucet.monad.xyz
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| STT Model | [Moonshine ONNX](https://huggingface.co/onnx-community/moonshine-base-ONNX) | Offline multilingual speech recognition |
| ML Runtime | [@huggingface/transformers](https://www.npmjs.com/package/@huggingface/transformers) v3 | WebGPU/WASM ONNX inference in browser |
| NLU | Sarvam 105B / regex fallback | Hindi-English intent extraction |
| Auth | WebAuthn Passkeys | Offline biometric — device secure enclave |
| Signing | [ethers.js](https://docs.ethers.org/v6/) v6 | EIP-712 typed data signing + verification |
| Transport | Express.js + WiFi hotspot | Local P2P voucher relay |
| Local DB | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Vendor append-only voucher ledger |
| Blockchain | Monad Testnet (Chain ID 10143) | Parallel EVM batch settlement |
| PWA | Vite + Service Worker | Installable offline-first web app |
| Frontend | Vanilla JS / HTML | Zero framework overhead |

---

## Project Structure

```
airweave/
├── airweave-customer/          # Customer PWA (phone)
│   ├── index.html
│   ├── manifest.json           # PWA installable manifest
│   ├── sw.js                   # Service worker for offline + model cache
│   └── src/
│       ├── main.js             # App entry + state machine
│       ├── audio.js            # AudioWorklet mic capture (16kHz mono)
│       ├── transcriber.js      # Moonshine ONNX via Transformers.js
│       ├── intent.js           # Voice → { amount, currency } parser
│       ├── auth.js             # WebAuthn passkey registration + assertion
│       ├── wallet.js           # ethers.js wallet generation + vault top-up
│       ├── payment.js          # EIP-712 voucher signing + vendor POST
│       └── ui.js               # Screen state machine + swipe gesture
│
├── airweave-vendor/            # Vendor web app (laptop/merchant device)
│   ├── index.html              # Live payment dashboard
│   └── src/
│       ├── server.js           # Express HTTP server (port 3000)
│       ├── verify.js           # ethers verifyTypedData — offline ecrecover
│       ├── db.js               # SQLite voucher ledger
│       └── ui.js               # Real-time SSE balance display
│
└── contracts/
    ├── USDX.sol                # USD-pegged ERC-20 stablecoin
    ├── INRX.sol                # INR-pegged ERC-20 (v1)
    └── MonadAirVault.sol       # Voucher escrow + batch settlement
```

---

## Running Locally

### Prerequisites

```bash
node >= 18
npm >= 9
MetaMask with Monad Testnet (Chain ID 10143)
```

### Customer PWA

```bash
cd airweave-customer
npm install
npm run dev
# Opens at https://localhost:5173
# HTTPS required for WebAuthn — vite-plugin-mkcert handles this
```

On first load, the app downloads the Moonshine ONNX model (~130MB). This takes 1–2 minutes on a good connection. After that, the app runs fully offline.

### Vendor Server

```bash
cd airweave-vendor
VENDOR_ADDRESS=0xYOUR_VENDOR_WALLET npm start
# Server runs at http://0.0.0.0:3000
# Open http://localhost:3000 for the vendor dashboard
```

### Demo Setup

1. Start the vendor server on your laptop. Note your laptop's hotspot IP (usually `192.168.43.1` on Android hotspot, `172.20.10.1` on iOS).
2. Enable hotspot on the vendor device (laptop). Customer phone connects to it.
3. Open the customer PWA. Scan the QR code shown on the vendor dashboard.
4. Speak: **"pay thirty five rupees"**
5. Complete biometric (Face ID / fingerprint).
6. Swipe up to confirm.
7. Vendor screen updates: **₹35.00 PENDING** — no internet touched.
8. Click "Settle to Blockchain" on vendor dashboard — transaction confirms on Monad in ~0.4 seconds.

### For Phone Testing Over LAN

```bash
cd airweave-customer
npm run dev -- --host
# Vite will print your LAN IP e.g. https://192.168.43.1:5173
# WebAuthn requires HTTPS — vite-plugin-mkcert generates a local cert
```

---

## Getting USDX for Testing

The USDX contract has a public mint function — anyone can mint up to 10,000 USDX per call:

```js
// In browser console or via Remix IDE
// Contract: 0x94C647a5d232769705707925d551E99618E2688c
// Function: mintPublic(address to, uint256 amount)
// Amount: parseUnits("500", 18) → 500 USDX = ₹47,500 spending power

// Via ethers.js
const usdx = new ethers.Contract(USDX_ADDRESS, ABI, signer);
await usdx.mintPublic(yourAddress, ethers.parseUnits("500", 18));
```

Or use the top-up flow inside the customer PWA (online mode required for minting).

---

## Amount Encoding — Paise Format

All on-chain amounts use Paise (smallest INR denomination) to avoid floating-point math over local P2P connections:

```
₹1   = amountINR: 100
₹35  = amountINR: 3500
₹100 = amountINR: 10000

// In ethers.js:
const paise = Math.round(inrAmount * 100);  // 35 → 3500
// NOT parseUnits — amountINR is already an integer
```

---

## Why Monad

Standard sequential blockchains cannot process a regional batch of offline vouchers concurrently — each voucher from different users touches different state, but sequential execution means they queue anyway, causing gas spikes and confirmation delays.

Monad's parallel execution engine reads and processes independent state trees (different user nonces, different vault balances) simultaneously. A full village's worth of vouchers — collected over hours without signal — settles in a **single 0.4-second block** the moment any device reconnects.

This is the concrete use case Monad's architecture was built for: not theoretical TPS benchmarks, but real-world batch clearing of independent state updates under time pressure.

---

## Hackathon Context

Built at **Monad Blitz Bangalore V4 — The Agent Economy** (June 2026) at Scaler School of Technology, Bangalore.

**Theme alignment:** The hackathon theme asks where AI agents fail when they need to operate as real actors in the world — owning identity, proving actions, coordinating without human guardrails. AirWeave demonstrates the cryptographic primitive that solves this at the payment layer: a signed EIP-712 voucher is a provable, unforgeable, self-verifying record of intent that requires no central authority to validate. Whether the payer is a human speaking Hindi or an autonomous agent coordinating a microgrid payment, the trust mechanism is identical.

---

## Roadmap

- [x] USDX ERC-20 deployed on Monad Testnet
- [x] INRX ERC-20 deployed on Monad Testnet  
- [x] EIP-712 offline signing pipeline
- [x] WebAuthn passkey authentication
- [x] Vendor SQLite escrow + ecrecover verification
- [x] Customer PWA with Moonshine ONNX STT
- [x] Swipe-to-pay UI with voice flow
- [ ] MonadAirVault.sol batch settlement contract
- [ ] Live USD/INR oracle integration
- [ ] Gossip relay — any device with signal can submit pending batches
- [ ] BLE fallback transport for no-hotspot environments
- [ ] Sarvam Edge SDK integration when SDK releases publicly
- [ ] UPI off-ramp for vendor USDX → bank account withdrawal

---

## License

MIT — built for Monad Blitz Bangalore V4, June 2026.

---

<div align="center">

**AirWeave** — because the chai vendor in Kodaikanal<br/>
shouldn't lose a sale to a monsoon cloud.

[Live Demo](https://airweaveproject.netlify.app) · [Monad Testnet Explorer](https://testnet.monadscan.com) · [Monad Blitz](https://monad.xyz/events)

</div>