import { ethers } from 'ethers';

const MONAD_RPC = 'https://testnet-rpc.monad.xyz';
const CHAIN_ID = 10143;

const VOUCHER_TYPES = {
  Voucher: [
    { name: 'from',      type: 'address' },
    { name: 'to',        type: 'address' },
    { name: 'amountINR', type: 'uint256' },
    { name: 'nonce',     type: 'uint256' },
    { name: 'expiry',    type: 'uint256' },
  ]
};

import { VAULT_ADDRESS } from './contracts.js';

const DOMAIN = {
  name: 'AirWeave',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: VAULT_ADDRESS,
};

export async function signVoucher({ wallet, vendorAddress, amountINR }) {
  const nonce = getNonce(wallet.address);
  const expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours expiry

  const voucher = {
    from: wallet.address,
    to: vendorAddress,
    amountINR: BigInt(Math.round(amountINR * 100)), // in paise (cents equivalent)
    nonce: BigInt(nonce),
    expiry: BigInt(expiry),
  };

  const signature = await wallet.signTypedData(DOMAIN, VOUCHER_TYPES, voucher);
  incrementNonce(wallet.address);

  return { voucher, signature };
}

export function getNonce(address) {
  return parseInt(localStorage.getItem(`nonce_${address}`) || '0');
}

export function setNonce(address, value) {
  localStorage.setItem(`nonce_${address}`, value.toString());
}

function incrementNonce(address) {
  const current = getNonce(address);
  localStorage.setItem(`nonce_${address}`, (current + 1).toString());
}

export async function sendToVendor({ voucher, signature, vendorIp = '192.168.43.1', itemName = '', recipient = '', fallbackUsed = false }) {
  // Try clean up vendorIp to strip http if present
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
  
  // If no port is specified in the ip address, default to :3000
  const host = ip.includes(':') ? ip : `${ip}:3000`;

  const url = `http://${host}/pay`;
  console.log(`Sending EIP-712 voucher to vendor at: ${url}`);
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      voucher: {
        ...voucher,
        amountINR: voucher.amountINR.toString(),
        nonce: voucher.nonce.toString(),
        expiry: voucher.expiry.toString(),
      },
      signature,
      itemName,
      recipient,
      fallbackUsed
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || `HTTP error ${res.status}`);
  }

  const result = await res.json();
  
  if (result && result.success) {
    // 1. Update local balance cache (optimistic — vendor confirmed receipt)
    const amountInr = Number(voucher.amountINR) / 100;
    const currentInr = parseFloat(localStorage.getItem('airweave_vault_inr') || '0');
    const newInr = Math.max(0, currentInr - amountInr);
    localStorage.setItem('airweave_vault_inr', newInr.toFixed(2));

    // 2. Store the pending voucher for settlement tracking
    const pending = JSON.parse(localStorage.getItem('airweave_pending') || '[]');
    pending.push({
      from: voucher.from,
      to: voucher.to,
      amountINR: voucher.amountINR.toString(), // Paise
      nonce: voucher.nonce.toString(),
      expiry: voucher.expiry.toString(),
      signature: signature,
      timestamp: Date.now(),
      status: 'pending'
    });
    localStorage.setItem('airweave_pending', JSON.stringify(pending));
  }

  return result;
}
