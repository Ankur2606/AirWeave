// Vendor Dashboard Frontend Controller
const balanceEl = document.getElementById('inr-balance');
const countEl = document.getElementById('voucher-count');
const tbodyEl = document.getElementById('vouchers-tbody');
const qrImgEl = document.getElementById('qr-image');
const ipEl = document.getElementById('vendor-ip');
const addressEl = document.getElementById('vendor-address');

// Shorten Ethers address helper
function shortAddress(addr) {
  return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
}

// Shorten signature helper
function shortSig(sig) {
  return `${sig.substring(0, 8)}...${sig.substring(sig.length - 8)}`;
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
  } catch (err) {
    console.error('Failed to load connection QR:', err);
    ipEl.textContent = 'Error loading IP';
    addressEl.textContent = 'Error loading address';
  }
}

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
      console.log('SSE payload received:', data);

      // Update balances & counters
      balanceEl.textContent = `₹${data.totalINR.toFixed(2)}`;
      
      const vouchers = data.pending || [];
      countEl.textContent = vouchers.length;

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
            <span class="badge ${badgeClass}">${v.status}</span>
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
