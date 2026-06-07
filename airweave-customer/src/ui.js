import { ethers } from 'ethers';
import { startRecording, stopRecording, mergeChunks } from './audio.js';
import { loadModel, transcribe, transcribeWithSarvam } from './transcriber.js';
import { extractIntent } from './intent.js';
import { hasPasskey, registerPasskey, verifyPasskey } from './auth.js';
import { hasWallet, generateWallet, getAddress, loadWallet, getLocalBalance, topUpLocalVault, connectMetaMask } from './wallet.js';
import { signVoucher, sendToVendor } from './payment.js';
import { startQRScanner, stopQRScanner } from './scanner.js';

// Screens
const screens = {
  LOGO: document.getElementById('view-logo'),
  CAMERA: document.getElementById('view-camera'),
  STT_CHOICE: document.getElementById('view-stt-choice'),
  LOADING: document.getElementById('view-loading'),
  SETUP: document.getElementById('view-setup'),
  IDLE: document.getElementById('view-idle'),
  RECORDING: document.getElementById('view-recording'),
  CONFIRM: document.getElementById('view-confirm')
};

// UI Elements
const globalHeader = document.getElementById('global-header');
const loadingStatusText = document.getElementById('loading-status-text');
const loadingProgressBar = document.getElementById('loading-progress-bar');
const btnRegisterBiometrics = document.getElementById('btn-register-biometrics');
const walletAddressBadge = document.getElementById('wallet-address-badge');
const walletBalanceVal = document.getElementById('wallet-balance-val');
const vendorIpInput = document.getElementById('vendor-ip');
const vendorAddressInput = document.getElementById('vendor-address');
const btnMic = document.getElementById('btn-mic');
const micPromptText = document.getElementById('mic-prompt-text');
const waveformPath = document.getElementById('waveform-path');
const confirmAmount = document.getElementById('confirm-amount');
const confirmVendorLabel = document.getElementById('confirm-vendor-label');
const confirmVendorAddress = document.getElementById('confirm-vendor-address');
const confirmTranscription = document.getElementById('confirm-transcription');
const btnConfirmCancel = document.getElementById('btn-confirm-cancel');
const overlaySuccess = document.getElementById('overlay-success');
const btnSuccessClose = document.getElementById('btn-success-close');
const swipeTrack = document.getElementById('swipe-track');
const swipeHandle = document.getElementById('swipe-handle');
const successTitle = document.getElementById('success-title');
const successMessage = document.getElementById('success-message');

// MetaMask Elements
const btnMetaMask = document.getElementById('btn-metamask');
const metamaskStatusText = document.getElementById('metamask-status-text');
const metamaskInfoBadge = document.getElementById('metamask-info-badge');
const metamaskAddressText = document.getElementById('metamask-address-text');
const btnVaultTopup = document.getElementById('btn-vault-topup');
const walletAddressShort = document.getElementById('wallet-address-short');

let currentView = 'LOGO';
let recordingState = null; // { ctx, stream, node, mediaRecorder, mediaChunks }
let recordedChunks = [];
let waveAnimationFrame = null;

// Extracted entities
let parsedAmount = null;
let parsedItemName = '';
let parsedRecipient = '';
let parsedFallbackUsed = false;

// Progress Tracking for Model Loading
const fileProgressMap = new Map();

function updateProgressUI(percent, text) {
  loadingProgressBar.style.width = `${percent}%`;
  loadingStatusText.textContent = text;
}

export function switchScreen(targetScreen) {
  // Hide all screens
  Object.values(screens).forEach(screen => {
    if (screen) screen.classList.add('d-none');
  });
  
  // Show target screen
  if (screens[targetScreen]) {
    screens[targetScreen].classList.remove('d-none');
  }
  currentView = targetScreen;

  // Show header only on idle, confirm
  if (targetScreen === 'IDLE' || targetScreen === 'CONFIRM') {
    globalHeader.classList.remove('d-none');
  } else {
    globalHeader.classList.add('d-none');
  }
}

// Waveform Animation
function startWaveform() {
  let t = 0;
  function draw() {
    t += 0.2;
    let points = [];
    for (let x = 0; x <= 400; x += 10) {
      const envelope = Math.sin((x / 400) * Math.PI);
      const y = 40 + Math.sin(x * 0.06 - t) * 25 * envelope * (0.4 + Math.random() * 0.6);
      points.push(`${x} ${y}`);
    }
    if (waveformPath) {
      waveformPath.setAttribute('d', `M 0 40 L ` + points.join(' L '));
    }
    waveAnimationFrame = requestAnimationFrame(draw);
  }
  draw();
}

function stopWaveform() {
  if (waveAnimationFrame) {
    cancelAnimationFrame(waveAnimationFrame);
    waveAnimationFrame = null;
  }
  if (waveformPath) {
    waveformPath.setAttribute('d', 'M 0 40 Q 20 40 40 40 T 80 40 T 120 40 T 160 40 T 200 40 T 240 40 T 280 40 T 320 40 T 360 40 T 400 40');
  }
}

// 8-Second Circular Timer countdown
let recordingTimerInterval = null;
let recordingSecondsLeft = 8;
const timerCircle = document.getElementById('timer-circle');
const timerText = document.getElementById('timer-countdown-text');

function startRecordingTimer() {
  recordingSecondsLeft = 8;
  if (timerText) timerText.textContent = '8s';
  if (timerCircle) timerCircle.style.strokeDashoffset = '0';
  
  const startTime = Date.now();
  const duration = 8000; // 8 seconds

  recordingTimerInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Update circle progress (dashoffset moves from 0 to 251.2)
    if (timerCircle) {
      timerCircle.style.strokeDashoffset = (progress * 251.2).toString();
    }
    
    const secondsLeft = Math.ceil((duration - elapsed) / 1000);
    if (timerText) {
      timerText.textContent = `${Math.max(0, secondsLeft)}s`;
    }

    if (elapsed >= duration) {
      stopRecordingTimer();
      triggerRecordingStop();
    }
  }, 100);
}

function stopRecordingTimer() {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
}

// Update Local balance in UI
function updateBalanceUI() {
  const bal = getLocalBalance();
  if (walletBalanceVal) {
    walletBalanceVal.textContent = `₹${bal.toFixed(2)}`;
  }
}

// Update Connected MetaMask Account details in UI
async function updateMetaMaskUI() {
  if (!window.ethereum) {
    if (btnMetaMask) btnMetaMask.style.display = 'none';
    return;
  }
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await provider.send('eth_accounts', []);
    if (accounts.length > 0) {
      const addr = accounts[0];
      if (metamaskStatusText) {
        metamaskStatusText.textContent = `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
      }
      if (metamaskInfoBadge) {
        metamaskInfoBadge.classList.remove('d-none');
      }
      if (metamaskAddressText) {
        metamaskAddressText.textContent = addr;
      }
    } else {
      if (metamaskStatusText) {
        metamaskStatusText.textContent = 'Connect MetaMask';
      }
      if (metamaskInfoBadge) {
        metamaskInfoBadge.classList.add('d-none');
      }
    }
  } catch (err) {
    console.error("Error updating MetaMask UI:", err);
  }
}

// Setup Event Listeners
export async function initUI() {
  // --- Launcher Flow Segment ---
  // 1. Show LOGO screen for 2.5s initially
  switchScreen('LOGO');

  setTimeout(() => {
    // 2. Switch to CAMERA scanner screen
    switchScreen('CAMERA');
    startCameraScanning();
  }, 2500);

  function startCameraScanning() {
    startQRScanner((data) => {
      // Success callback when QR code scanned
      vendorIpInput.value = data.vendorIp;
      vendorAddressInput.value = data.vendorAddress;
      
      stopQRScanner();
      switchScreen('STT_CHOICE');
    }).catch(err => {
      console.warn("Camera start failed, continuing manually:", err);
    });
  }

  // Skip Camera click handler
  const btnSkipScan = document.getElementById('btn-skip-scan');
  if (btnSkipScan) {
    btnSkipScan.addEventListener('click', () => {
      stopQRScanner();
      switchScreen('STT_CHOICE');
    });
  }

  // STT Choice Click Handlers
  const btnSttEdge = document.getElementById('btn-stt-edge');
  const btnSttApi = document.getElementById('btn-stt-api');

  if (btnSttEdge) {
    btnSttEdge.addEventListener('click', async () => {
      sessionStorage.setItem('stt_mode', 'local');
      
      // Load Edge model and show loading screen
      switchScreen('LOADING');
      try {
        updateProgressUI(5, 'Connecting to model repository...');
        await loadModel((data) => {
          if (data.status === 'initiate') {
            fileProgressMap.set(data.file, 0);
            updateProgressUI(10, `Initializing ${data.file.split('/').pop()}...`);
          } else if (data.status === 'progress') {
            fileProgressMap.set(data.file, data.progress);
            
            let totalProgress = 0;
            fileProgressMap.forEach(v => { totalProgress += v; });
            const avgProgress = fileProgressMap.size > 0 ? (totalProgress / fileProgressMap.size) : 0;
            
            updateProgressUI(Math.round(avgProgress), `Downloading model weights: ${Math.round(avgProgress)}%`);
          } else if (data.status === 'ready') {
            updateProgressUI(100, 'Model ready!');
          }
        });

        proceedAfterChoice();
      } catch (err) {
        console.error("Edge model failed to load:", err);
        alert(`Edge model failed to load: ${err.message}. Please reload or select Sarvam API.`);
        switchScreen('STT_CHOICE');
      }
    });
  }

  if (btnSttApi) {
    btnSttApi.addEventListener('click', () => {
      sessionStorage.setItem('stt_mode', 'api');
      proceedAfterChoice();
    });
  }

  function proceedAfterChoice() {
    if (hasPasskey() && hasWallet()) {
      setupIdleView();
      switchScreen('IDLE');
    } else {
      switchScreen('SETUP');
    }
  }

  // 3. Setup Biometrics Enrolment Screen Interaction
  if (btnRegisterBiometrics) {
    btnRegisterBiometrics.addEventListener('click', async () => {
      try {
        updateProgressUI(20, 'Registering secure passkey on device...');
        await registerPasskey();
        generateWallet();
        
        setupIdleView();
        switchScreen('IDLE');
      } catch (err) {
        alert(`Registration failed: ${err.message}\nMake sure your browser supports passkeys and you are on a secure context (localhost or HTTPS).`);
      }
    });
  }

  // 4. Idle Screen Interactions — copy wallet address on click
  if (walletAddressBadge) {
    walletAddressBadge.addEventListener('click', () => {
      const address = getAddress();
      if (address) {
        navigator.clipboard.writeText(address).then(() => {
          const span = document.getElementById('wallet-address-short');
          if (span) {
            const prev = span.textContent;
            span.textContent = 'Copied!';
            setTimeout(() => { span.textContent = prev; }, 1200);
          }
        });
      }
    });
  }

  // MetaMask connection listener
  if (btnMetaMask) {
    btnMetaMask.addEventListener('click', async () => {
      try {
        const account = await connectMetaMask();
        console.log("MetaMask connected account:", account);
        await updateMetaMaskUI();
      } catch (err) {
        alert(`MetaMask connection failed: ${err.message}`);
      }
    });
  }

  // Local vault top-up listener
  if (btnVaultTopup) {
    btnVaultTopup.addEventListener('click', async () => {
      try {
        const inrStr = prompt("Enter the amount in INR you wish to top up:", "95");
        if (!inrStr) return;
        const inrAmount = parseFloat(inrStr);
        if (isNaN(inrAmount) || inrAmount <= 0) {
          alert("Please enter a valid positive number.");
          return;
        }

        // Switch to loading view while tx processes
        switchScreen('LOADING');
        updateProgressUI(20, 'Initiating Monad Testnet top-up via MetaMask...');

        const result = await topUpLocalVault(inrAmount);
        if (result && result.success) {
          alert(`Top-up Successful!\nSuccessfully minted USDX.\nTransaction Hash: ${result.hash}`);
        }

        setupIdleView();
        switchScreen('IDLE');
      } catch (err) {
        setupIdleView();
        switchScreen('IDLE');
        alert(`Top-up failed: ${err.message}`);
      }
    });
  }

  // Microphone press and hold (for Touch / Mobile devices)
  if (btnMic) {
    btnMic.addEventListener('touchstart', (e) => {
      e.preventDefault();
      triggerRecordingStart();
    });
  }

  window.addEventListener('touchend', (e) => {
    if (currentView === 'RECORDING') {
      triggerRecordingStop();
    }
  });

  // Mouse fallbacks for desktop simulator testing
  if (btnMic) {
    btnMic.addEventListener('mousedown', (e) => {
      triggerRecordingStart();
    });
  }

  window.addEventListener('mouseup', () => {
    if (currentView === 'RECORDING') {
      triggerRecordingStop();
    }
  });

  // Tap recording stop early listener
  const btnRecordingStop = document.getElementById('btn-recording-stop');
  if (btnRecordingStop) {
    btnRecordingStop.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentView === 'RECORDING') {
        triggerRecordingStop();
      }
    });
  }

  async function triggerRecordingStart() {
    recordedChunks = [];
    try {
      if (btnMic) btnMic.classList.add('recording');
      switchScreen('RECORDING');
      startWaveform();
      startRecordingTimer();
      
      recordingState = await startRecording((chunk) => {
        recordedChunks.push(chunk);
      });
    } catch (err) {
      if (btnMic) btnMic.classList.remove('recording');
      stopWaveform();
      stopRecordingTimer();
      setupIdleView();
      switchScreen('IDLE');
      alert(`Microphone access failed: ${err.message}`);
    }
  }

  async function triggerRecordingStop() {
    if (btnMic) btnMic.classList.remove('recording');
    stopWaveform();
    stopRecordingTimer();
    
    if (!recordingState) return;
    
    // Switch briefly to a waiting overlay or state
    if (micPromptText) micPromptText.textContent = 'Transcribing your audio...';
    switchScreen('LOADING');
    updateProgressUI(40, 'Processing speech input...');

    try {
      const audioBlob = await stopRecording(recordingState);
      recordingState = null;

      let transcript = '';
      const sttMode = sessionStorage.getItem('stt_mode') || 'api';

      if (sttMode === 'api') {
        updateProgressUI(70, 'Transcribing with Sarvam API...');
        transcript = await transcribeWithSarvam(audioBlob);
      } else {
        updateProgressUI(70, 'Running offline speech-to-text...');
        const audioBuffer = mergeChunks(recordedChunks);
        if (audioBuffer.length < 16000 * 0.5) {
          throw new Error('Recording too short. Please try again.');
        }
        transcript = await transcribe(audioBuffer);
      }

      console.log("Transcribed Text:", transcript);
      if (!transcript || !transcript.trim()) {
        throw new Error('Could not hear anything clearly. Speak louder.');
      }

      updateProgressUI(90, 'Extracting intent and entities...');
      
      // Parse intent via LLM first, falling back to Regex if needed
      const parsed = await extractIntent(transcript);
      if (!parsed) {
        throw new Error(`Speech detected: "${transcript}". No amount could be identified. Try saying "Pay fifty rupees" or "bhejo 100".`);
      }

      // Store parsed attributes globally in module scope
      parsedAmount = parsed.amount;
      parsedItemName = parsed.item || 'Payment';
      parsedRecipient = parsed.recipient || '';
      parsedFallbackUsed = parsed.fallbackUsed || false;

      // Setup Confirmation Screen
      confirmAmount.textContent = `₹${parsedAmount}`;
      confirmTranscription.textContent = `"${transcript}"`;
      
      const itemLabel = document.getElementById('confirm-item-label');
      const recipientLabel = document.getElementById('confirm-recipient-label');
      if (itemLabel) itemLabel.textContent = parsedItemName;
      if (recipientLabel) {
        recipientLabel.textContent = parsedRecipient ? `to ${parsedRecipient}` : '';
      }
      
      // Setup vendor addresses
      const vAddr = vendorAddressInput.value || '0x264f3D6883F932f273558ab0cF078d473941F2A4';
      confirmVendorAddress.textContent = `${vAddr.substring(0, 8)}...${vAddr.substring(vAddr.length - 4)}`;
      confirmVendorLabel.textContent = `to ${vAddr === '0x264f3D6883F932f273558ab0cF078d473941F2A4' ? 'Chai Wala' : 'Vendor'}`;

      switchScreen('CONFIRM');
    } catch (err) {
      setupIdleView();
      switchScreen('IDLE');
      alert(err.message);
    }
  }

  // 5. Confirm Screen Interactions
  if (btnConfirmCancel) {
    btnConfirmCancel.addEventListener('click', () => {
      setupIdleView();
      switchScreen('IDLE');
    });
  }

  // Swipe-to-pay confirmation logic
  setupSwipeGesture();

  // 6. Success overlay close
  if (btnSuccessClose) {
    btnSuccessClose.addEventListener('click', () => {
      overlaySuccess.classList.remove('visible');
      setupIdleView();
      switchScreen('IDLE');
    });
  }

  // Check initial MetaMask status
  await updateMetaMaskUI();
}

function setupIdleView() {
  if (micPromptText) micPromptText.textContent = '';
  const address = getAddress();
  const shortSpan = document.getElementById('wallet-address-short');
  if (address && shortSpan) {
    shortSpan.textContent = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }
  updateBalanceUI();
  updateMetaMaskUI();
}

// Swipe Up Confirmation Handler
async function onSwipeUp() {
  let deducted = false;
  try {
    // 1. Verify biometrics locally via WebAuthn
    const success = await verifyPasskey();
    if (!success) {
      throw new Error('WebAuthn assertion failed.');
    }

    // 2. Load wallet keys
    const wallet = loadWallet();
    if (!wallet) {
      throw new Error('Local wallet not found. Run setup again.');
    }

    // Deduct local balance first before submitting payment
    try {
      deductLocalBalance(parsedAmount);
      deducted = true;
      updateBalanceUI();
    } catch (balErr) {
      throw new Error('Insufficient balance in local wallet vault');
    }

    // 3. EIP-712 Sign Voucher
    const vendorAddress = vendorAddressInput.value;
    const vendorIp = vendorIpInput.value;

    const signedVoucher = await signVoucher({
      wallet,
      vendorAddress,
      amountINR: parsedAmount
    });

    // 4. Send to vendor (Offline HTTP POST over WiFi Hotspot)
    successTitle.textContent = "Authorizing...";
    successMessage.textContent = "Sending cryptographic voucher to vendor hotspot...";
    overlaySuccess.classList.add('visible');

    const result = await sendToVendor({
      voucher: signedVoucher.voucher,
      signature: signedVoucher.signature,
      vendorIp,
      itemName: parsedItemName,
      recipient: parsedRecipient,
      fallbackUsed: parsedFallbackUsed
    });

    if (result && result.success) {
      successTitle.textContent = "Payment Successful";
      successMessage.innerHTML = `Signed voucher for <strong>₹${parsedAmount}</strong> successfully sent to vendor.<br><small class="mt-1" style="display:block;opacity:0.6">Signer: ${signedVoucher.voucher.from.substring(0,8)}...</small>`;
      if (btnSuccessClose) btnSuccessClose.classList.remove('d-none');
    } else {
      throw new Error(result?.error || 'Vendor rejected the payment voucher.');
    }

  } catch (err) {
    // Re-credit the local balance on transmission failure or reject
    if (deducted) {
      addLocalBalance(parsedAmount);
      updateBalanceUI();
    }
    overlaySuccess.classList.remove('visible');
    alert(`Payment failed: ${err.message}`);
    // Reset handle position
    if (swipeHandle) swipeHandle.style.transform = 'translateY(0)';
  }
}

function setupSwipeGesture() {
  if (!swipeHandle || !swipeTrack) return;
  let startY = 0;
  let isDragging = false;

  const resetHandle = () => {
    swipeHandle.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
    swipeHandle.style.transform = 'translateY(0)';
  };

  // Touch handlers
  swipeHandle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    isDragging = true;
    swipeHandle.style.transition = 'none';
  });

  swipeHandle.addEventListener('touchmove', e => {
    if (!isDragging) return;
    const currentY = e.touches[0].clientY;
    let dy = startY - currentY;
    
    if (dy < 0) dy = 0;
    
    const maxTravel = swipeTrack.clientHeight - swipeHandle.clientHeight - 48; // track padding margins
    if (dy > maxTravel) dy = maxTravel;
    
    swipeHandle.style.transform = `translateY(-${dy}px)`;
  });

  swipeHandle.addEventListener('touchend', e => {
    if (!isDragging) return;
    isDragging = false;
    
    const dy = startY - e.changedTouches[0].clientY;
    const maxTravel = swipeTrack.clientHeight - swipeHandle.clientHeight - 48;
    
    if (dy > maxTravel * 0.7) {
      swipeHandle.style.transition = 'transform 0.2s ease';
      swipeHandle.style.transform = `translateY(-${maxTravel}px)`;
      setTimeout(onSwipeUp, 150);
    } else {
      resetHandle();
    }
  });

  // Mouse handlers (for desktop simulator)
  swipeHandle.addEventListener('mousedown', e => {
    startY = e.clientY;
    isDragging = true;
    swipeHandle.style.transition = 'none';

    const onMouseMove = ev => {
      if (!isDragging) return;
      let dy = startY - ev.clientY;
      if (dy < 0) dy = 0;
      
      const maxTravel = swipeTrack.clientHeight - swipeHandle.clientHeight - 48;
      if (dy > maxTravel) dy = maxTravel;
      
      swipeHandle.style.transform = `translateY(-${dy}px)`;
    };

    const onMouseUp = ev => {
      if (!isDragging) return;
      isDragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      
      const dy = startY - ev.clientY;
      const maxTravel = swipeTrack.clientHeight - swipeHandle.clientHeight - 48;
      
      if (dy > maxTravel * 0.7) {
        swipeHandle.style.transition = 'transform 0.2s ease';
        swipeHandle.style.transform = `translateY(-${maxTravel}px)`;
        setTimeout(onSwipeUp, 150);
      } else {
        resetHandle();
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}
