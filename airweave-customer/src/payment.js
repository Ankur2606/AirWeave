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

const DOMAIN = {
  name: 'AirWeave',
  version: '1',
  chainId: CHAIN_ID,
  // verifyingContract will be added after MonadAirVault is deployed in Phase 2
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

  return res.json();
}
