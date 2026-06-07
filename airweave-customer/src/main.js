import { initUI } from './ui.js';
import { getAddress } from './wallet.js';
import { getVaultBalance, isNonceSettled } from './vault.js';

async function syncWithChain() {
  const address = getAddress();
  if (!address) return;

  console.log('[Connectivity] Online. Re-syncing local vault state with Monad Testnet...');

  // 1. Re-sync balance
  try {
    const balance = await getVaultBalance(address);
    localStorage.setItem('airweave_vault_inr', balance.inr);
    const balanceEl = document.getElementById('wallet-balance-val');
    if (balanceEl) {
      balanceEl.textContent = `₹${parseFloat(balance.inr).toFixed(2)}`;
    }
    console.log('[Connectivity] On-chain vault balance synced:', balance.inr);
  } catch (err) {
    console.warn('[Connectivity] Failed to sync balance from chain:', err);
  }

  // 2. Re-sync pending vouchers
  try {
    const pending = JSON.parse(localStorage.getItem('airweave_pending') || '[]');
    if (pending.length === 0) return;

    let updated = false;
    for (const voucher of pending) {
      if (voucher.status === 'pending') {
        const settled = await isNonceSettled(voucher.from, parseInt(voucher.nonce));
        if (settled) {
          voucher.status = 'settled';
          updated = true;
          console.log(`[Connectivity] Offline voucher nonce ${voucher.nonce} confirmed settled on-chain.`);
        }
      }
    }

    if (updated) {
      localStorage.setItem('airweave_pending', JSON.stringify(pending));
    }
  } catch (err) {
    console.warn('[Connectivity] Failed to sync pending vouchers with chain:', err);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('AirWeave Customer PWA Loaded. Initializing UI states.');
  initUI();
  
  if (navigator.onLine) {
    syncWithChain();
  }
});

window.addEventListener('online', () => {
  syncWithChain();
});
