// QR Scanner Utility utilizing jsQR from CDN
let videoStream = null;
let animationFrameId = null;

export async function startQRScanner(onSuccess) {
  const video = document.getElementById('scanner-video');
  const canvas = document.getElementById('scanner-canvas');
  const statusText = document.getElementById('scanner-status-text');
  
  if (!video || !canvas) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  try {
    statusText.textContent = "Requesting camera access...";
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    
    video.srcObject = videoStream;
    video.setAttribute('playsinline', true); // Critical for mobile iOS Safari
    video.play();
    
    statusText.textContent = "Align vendor QR code inside the viewfinder...";

    const tick = () => {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        if (window.jsQR) {
          const code = window.jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
          });
          
          if (code) {
            try {
              console.log("Decoded QR data:", code.data);
              const data = JSON.parse(code.data);
              
              if (data.vendorAddress && data.vendorIp && data.vendorPort) {
                statusText.textContent = "Connection linked!";
                
                // Draw a solid success border
                ctx.beginPath();
                ctx.lineWidth = 8;
                ctx.strokeStyle = '#10b981';
                ctx.strokeRect(0, 0, canvas.width, canvas.height);
                
                // Stop camera stream
                stopQRScanner();
                
                // Trigger success callback after brief visual confirmation
                setTimeout(() => {
                  onSuccess(data);
                }, 300);
                return;
              }
            } catch (err) {
              // Not a valid JSON connection payload, continue scanning
              console.warn("Decoded invalid connection QR data format:", err);
            }
          }
        } else {
          console.warn("jsQR library is not yet loaded in window scope.");
        }
      }
      animationFrameId = requestAnimationFrame(tick);
    };
    
    animationFrameId = requestAnimationFrame(tick);
  } catch (err) {
    console.error("Camera access failed:", err);
    statusText.textContent = "Camera error: Point camera manually or enter details.";
    throw err;
  }
}

export function stopQRScanner() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = null;
  }
  const video = document.getElementById('scanner-video');
  if (video) {
    video.srcObject = null;
  }
}
