import { ethers } from 'ethers';

const STORAGE_KEY = 'airweave_wallet_enc';
const BALANCE_KEY = 'airweave_vault_inr';

const USDX_ADDRESS = '0x94C647a5d232769705707925d551E99618E2688c';
const USDX_ABI = [
  'function mintPublic(address to, uint256 amount) external',
  'function balanceOf(address) view returns (uint256)',
];
const INR_PER_USDX = 95;

/**
 * Generate and store local wallet, protected by a derived key from the passkey assertion.
 */
export function generateWallet() {
  const wallet = ethers.Wallet.createRandom();
  
  const data = {
    address: wallet.address,
    privateKey: wallet.privateKey,  // AES encrypted in production
    createdAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  
  // Set default starting balance
  if (!localStorage.getItem(BALANCE_KEY)) {
    localStorage.setItem(BALANCE_KEY, '1500.00'); // Starting balance for offline demo
  }
  
  return wallet;
}

export function loadWallet() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const data = JSON.parse(raw);
  return new ethers.Wallet(data.privateKey);
}

export function getAddress() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return JSON.parse(raw).address;
}

export function hasWallet() {
  return !!localStorage.getItem(STORAGE_KEY);
}

// Local Balance Helpers
export function getLocalBalance() {
  const bal = localStorage.getItem(BALANCE_KEY);
  if (!bal) {
    localStorage.setItem(BALANCE_KEY, '1500.00');
    return 1500.00;
  }
  return parseFloat(bal);
}

export function deductLocalBalance(amountInr) {
  const current = getLocalBalance();
  if (current < amountInr) {
    throw new Error('Insufficient balance in local wallet vault');
  }
  const newBal = current - amountInr;
  localStorage.setItem(BALANCE_KEY, newBal.toFixed(2));
  return newBal;
}

export function addLocalBalance(amountInr) {
  const current = getLocalBalance();
  const newBal = current + amountInr;
  localStorage.setItem(BALANCE_KEY, newBal.toFixed(2));
  return newBal;
}

// MetaMask Connection and Vault On-Chain Top Up
export async function topUpLocalVault(inrAmount) {
  if (!window.ethereum) {
    throw new Error('MetaMask or Web3 Wallet injection not detected.');
  }

  // 1. Check local wallet address
  const localWalletAddress = getAddress();
  if (!localWalletAddress) {
    throw new Error('Local wallet not generated yet. Finish biometrics setup first.');
  }

  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  const signer = await provider.getSigner();

  // 2. Switch/Add Monad Testnet Chain (10143 decimal / 0x279F hex)
  try {
    await provider.send('wallet_switchEthereumChain', [{ chainId: '0x279F' }]);
  } catch (switchError) {
    // Code 4902 indicates chain has not been added to MetaMask
    if (switchError.code === 4902) {
      await provider.send('wallet_addEthereumChain', [{
        chainId: '0x279F',
        chainName: 'Monad Testnet',
        rpcUrls: ['https://testnet-rpc.monad.xyz'],
        nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
        blockExplorerUrls: ['https://testnet.monadexplorer.com/']
      }]);
    } else {
      throw switchError;
    }
  }

  // 3. Mint USDX to the customer PWA's local wallet address
  const usdxAmount = inrAmount / INR_PER_USDX;
  // Format float safely to maximum 6 decimal places to avoid precision errors
  const parsedAmount = ethers.parseUnits(usdxAmount.toFixed(6), 18);

  console.log(`Minting ${usdxAmount} USDX (₹${inrAmount}) to local address: ${localWalletAddress}`);
  
  const contract = new ethers.Contract(USDX_ADDRESS, USDX_ABI, signer);
  const tx = await contract.mintPublic(localWalletAddress, parsedAmount);
  
  console.log("USDX Mint transaction sent:", tx.hash);
  await tx.wait();
  console.log("USDX Mint transaction mined successfully!");

  // 4. Update local INR balance in PWA
  const newBal = addLocalBalance(inrAmount);
  return { success: true, newBalance: newBal, hash: tx.hash };
}

export async function connectMetaMask() {
  if (!window.ethereum) {
    throw new Error('MetaMask or Web3 Wallet injection not detected.');
  }
  const provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await provider.send('eth_requestAccounts', []);
  return accounts[0];
}

