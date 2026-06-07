const RP_NAME = 'AirWeave Pay';

export function isWebAuthnSupported() {
  return window.PublicKeyCredential !== undefined;
}

export function isIpAddress(hostname) {
  const ipv4Pattern = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  const ipv6Pattern = /^[a-fA-F0-9:]+$/;
  return ipv4Pattern.test(hostname) || ipv6Pattern.test(hostname);
}

// Call once on first app launch
export async function registerPasskey() {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported on this browser/device.');
  }

  const hostname = window.location.hostname;

  // WebAuthn strictly forbids raw IP addresses as Relying Party IDs.
  // We provide a simulated biometric prompt fallback for developer/LAN IP testing.
  if (isIpAddress(hostname)) {
    console.warn("WebAuthn does not support raw IP addresses as RP IDs. Using mock dev fallback.");
    const mockCredId = 'mock_passkey_ip_fallback';
    localStorage.setItem('airweave_cred_id', mockCredId);
    return mockCredId;
  }

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: hostname, name: RP_NAME },
      user: {
        id: userId,
        name: 'airweave-user',
        displayName: 'AirWeave User',
      },
      pubKeyCredParams: [
        { alg: -7,  type: 'public-key' },  // ES256 (most common)
        { alg: -257, type: 'public-key' }, // RS256 fallback
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',   // device biometric only
        userVerification: 'required',          // MUST verify (face/fingerprint)
        residentKey: 'required',
      },
      timeout: 60000,
    }
  });

  if (!credential) throw new Error('Failed to create biometric credential.');

  // Store credential ID for future assertions
  const credId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
  localStorage.setItem('airweave_cred_id', credId);
  return credId;
}

// Call every time user wants to pay
export async function verifyPasskey() {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported on this browser/device.');
  }

  const storedCredId = localStorage.getItem('airweave_cred_id');
  if (!storedCredId) throw new Error('No passkey registered');

  const hostname = window.location.hostname;

  // WebAuthn strictly forbids raw IP addresses as Relying Party IDs.
  if (isIpAddress(hostname) || storedCredId === 'mock_passkey_ip_fallback') {
    console.warn("WebAuthn running in IP address mock dev mode.");
    const confirmed = confirm("AirWeave Biometrics Simulator\n\nVerify payment authorization with simulated fingerprint/face ID?");
    if (!confirmed) {
      throw new Error('Biometric verification cancelled by user.');
    }
    return true;
  }

  const credIdBytes = Uint8Array.from(atob(storedCredId), c => c.charCodeAt(0));
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: hostname,
      allowCredentials: [{
        id: credIdBytes,
        type: 'public-key',
      }],
      userVerification: 'required',
      timeout: 60000,
    }
  });

  if (!assertion) throw new Error('Passkey verification failed.');
  return assertion !== null;
}

export function hasPasskey() {
  return !!localStorage.getItem('airweave_cred_id');
}

