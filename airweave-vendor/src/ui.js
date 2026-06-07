// Vendor Dashboard Frontend Controller
const balanceEl = document.getElementById('inr-balance');
const onchainBalanceEl = document.getElementById('onchain-balance');
const countEl = document.getElementById('voucher-count');
const tbodyEl = document.getElementById('vouchers-tbody');
const qrImgEl = document.getElementById('qr-image');
const ipEl = document.getElementById('vendor-ip');
const addressEl = document.getElementById('vendor-address');

const btnSettleEl = document.getElementById('btn-settle-vouchers');
const bannerEl = document.getElementById('connection-banner');
const bannerBtnEl = document.getElementById('banner-settle-btn');

let vouchersCache = [];

// Shorten Ethers address helper
function shortAddress(addr) {
  return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
}

// Shorten signature helper
function shortSig(sig) {
  return `${sig.substring(0, 8)}...${sig.substring(sig.length - 8)}`;
}

// Fetch on-chain settled balance from contract
async function updateOnChainBalance() {
  const addr = addressEl.textContent.trim();
  if (!addr || addr === '0x...' || addr.startsWith('Error') || addr === 'Loading...') {
    return;
  }
  try {
    const res = await fetch(`/vault-balance/${addr}`);
    if (!res.ok) throw new Error('Failed to fetch on-chain balance');
    const data = await res.json();
    if (onchainBalanceEl) {
      onchainBalanceEl.textContent = `₹${parseFloat(data.inr).toFixed(2)}`;
    }
  } catch (err) {
    console.warn('Failed to fetch on-chain balance:', err);
  }
}

// Fetch QR Code data on launch
async function loadConnectionDetails() {
  try {
    const res = await fetch('/qr');
    const data = await res.json();
    
    if (data.qr) {
      qrImgEl.src = data.qr;
    }
    ipEl.textContent = `${data.ip}:${data.port}`;
    addressEl.textContent = data.address;
    await updateOnChainBalance();
  } catch (err) {
    console.error('Failed to load connection QR:', err);
    ipEl.textContent = 'Error loading IP';
    addressEl.textContent = 'Error loading address';
  }
}

// Trigger batch settlement transaction
async function triggerSettlement() {
  const pendingCount = vouchersCache.filter(v => v.status === 'pending').length;
  if (pendingCount === 0) return;
  
  if (btnSettleEl) {
    btnSettleEl.disabled = true;
    const span = btnSettleEl.querySelector('span');
    if (span) span.textContent = 'Settling on Monad Testnet...';
  }
  if (bannerBtnEl) {
    bannerBtnEl.disabled = true;
  }
  
  try {
    const res = await fetch('/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    
    if (data.error) {
      throw new Error(data.error);
    }
    console.log('Settlement successful:', data);
  } catch (err) {
    console.error('Settlement request failed:', err);
    alert('Settlement failed: ' + err.message);
  } finally {
    if (btnSettleEl) {
      btnSettleEl.disabled = false;
      const span = btnSettleEl.querySelector('span');
      if (span) span.textContent = 'Settle Vouchers On-Chain';
    }
    if (bannerBtnEl) {
      bannerBtnEl.disabled = false;
    }
    updateConnectivityUI();
  }
}

// Update connectivity suggestion banner
function updateConnectivityUI() {
  if (!bannerEl) return;
  const isOnline = navigator.onLine;
  const pendingCount = vouchersCache.filter(v => v.status === 'pending').length;
  
  if (isOnline && pendingCount > 0) {
    bannerEl.classList.remove('d-none');
  } else {
    bannerEl.classList.add('d-none');
  }
}

window.addEventListener('online', updateConnectivityUI);
window.addEventListener('offline', updateConnectivityUI);

if (btnSettleEl) btnSettleEl.addEventListener('click', triggerSettlement);
if (bannerBtnEl) bannerBtnEl.addEventListener('click', triggerSettlement);

// Establish Server-Sent Events (SSE) connection for real-time updates
function initSSE() {
  console.log('Connecting to SSE events...');
  const eventSource = new EventSource('/events');

  eventSource.onopen = () => {
    console.log('SSE connection successfully established.');
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Handle settlement event specifically
      if (data.type === 'settlement') {
        console.log('SSE Settlement Confirmation received:', data);
        alert(`Settlement Batch Confirmed!\nTx Hash: ${data.txHash}\nSettled ${data.count} vouchers successfully on Monad Testnet.`);
        updateOnChainBalance();
        return;
      }

      console.log('SSE payload received:', data);

      // Update balances & counters
      balanceEl.textContent = `₹${data.totalINR.toFixed(2)}`;
      
      const vouchers = data.pending || [];
      vouchersCache = vouchers;
      countEl.textContent = vouchers.length;

      // Enable/Disable Settle button & update count
      const pendingCount = vouchers.filter(v => v.status === 'pending').length;
      if (btnSettleEl) {
        const span = btnSettleEl.querySelector('span');
        if (pendingCount > 0) {
          btnSettleEl.disabled = false;
          if (span) span.textContent = `Settle ${pendingCount} Vouchers On-Chain`;
        } else {
          btnSettleEl.disabled = true;
          if (span) span.textContent = 'Settle Vouchers On-Chain';
        }
      }

      updateConnectivityUI();
      updateOnChainBalance();

      // Update Connection details
      if (data.ip) {
        ipEl.textContent = `${data.ip}:3000`;
      }
      if (data.vendorAddress) {
        addressEl.textContent = data.vendorAddress;
      }

      // Play audio notification if base64 speech audio is sent
      if (data.audioB64) {
        console.log("Playing base64 payment voice confirmation...");
        try {
          const audio = new Audio('data:audio/wav;base64,' + data.audioB64);
          audio.play();
        } catch (audioErr) {
          console.warn("Auto playback of voice confirmation was prevented:", audioErr);
        }
      } else if (data.lastAmountINR) {
        // Fallback to Web Speech API speechSynthesis for demo when Sarvam API is down
        try {
          const itemName = data.lastItemName || 'भुगतान';
          const text = `${itemName} के लिए ${data.lastAmountINR} रुपये प्राप्त हुए।`;
          console.log(`Fallback Speech Synthesis: "${text}"`);
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = 'hi-IN';
          
          const voices = window.speechSynthesis.getVoices();
          const hiVoice = voices.find(v => v.lang.startsWith('hi'));
          if (hiVoice) {
            utterance.voice = hiVoice;
          }
          window.speechSynthesis.speak(utterance);
        } catch (synthErr) {
          console.warn("Web Speech API Synthesis failed:", synthErr);
        }
      }

      // Render vouchers table
      if (vouchers.length === 0) {
        tbodyEl.innerHTML = `
          <tr>
            <td colspan="7" class="empty-state">Waiting for offline payments...</td>
          </tr>
        `;
        return;
      }

      tbodyEl.innerHTML = '';
      vouchers.forEach(v => {
        const tr = document.createElement('tr');
        
        // Formatted amount (Rupees)
        const amtINR = (v.amount_inr / 100).toFixed(2);
        
        // Status class badge
        const badgeClass = v.status === 'pending' ? 'badge-pending' : 'badge-settled';
        
        let statusHtml = `<span class="badge ${badgeClass}">${v.status}</span>`;
        if (v.status === 'settled' && v.tx_hash) {
          statusHtml = `<a href="https://testnet.monadscan.com/tx/${v.tx_hash}" target="_blank" class="badge badge-settled" style="text-decoration: none;" title="View Tx on Monadscan">settled ✓</a>`;
        }

        tr.innerHTML = `
          <td class="address-cell" title="Click to copy full address: ${v.from_addr}" onclick="navigator.clipboard.writeText('${v.from_addr}'); alert('Copied address!')">
            ${shortAddress(v.from_addr)}
          </td>
          <td style="font-weight: 600; color: #10b981;">₹${amtINR}</td>
          <td>${v.item_name || 'Payment'}</td>
          <td>${v.recipient || 'N/A'}</td>
          <td>${v.nonce}</td>
          <td class="sig-cell" title="Full signature: ${v.signature}">
            ${shortSig(v.signature)}
          </td>
          <td>
            ${statusHtml}
          </td>
        `;
        tbodyEl.appendChild(tr);
      });

    } catch (err) {
      console.error('Failed to parse SSE payload:', err);
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE connection failed. Reconnecting in 5s...', err);
    eventSource.close();
    setTimeout(initSSE, 5000);
  };
}

// Start
loadConnectionDetails();
initSSE();
