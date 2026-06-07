import fs from 'fs';
import path from 'path';
import solc from 'solc';
import { ethers } from 'ethers';
import 'dotenv/config';

const PROVIDER_URL = 'https://testnet-rpc.monad.xyz';
const USDX_ADDRESS = '0x94C647a5d232769705707925d551E99618E2688c';

async function main() {
  console.log('[AirWeave Deployer] Starting MonadAirVault compilation & deployment...');

  // 1. Setup / load Deployer Private Key
  let privateKey = process.env.VENDOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  const envPath = path.resolve('.env');

  if (!privateKey) {
    console.log('[AirWeave Deployer] Private key not found in .env. Generating a new deployer wallet...');
    const newWallet = ethers.Wallet.createRandom();
    privateKey = newWallet.privateKey;
    
    // Save to vendor .env
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    // Append or inject
    if (!envContent.includes('VENDOR_PRIVATE_KEY=')) {
      envContent += `\nVENDOR_ADDRESS=${newWallet.address}\nVENDOR_PRIVATE_KEY=${newWallet.privateKey}\n`;
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log(`[AirWeave Deployer] Saved generated address and private key in vendor .env`);
    }
  }

  const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
  const deployer = new ethers.Wallet(privateKey, provider);
  console.log(`[AirWeave Deployer] Deployer Address: ${deployer.address}`);

  // 2. Check balance
  const balance = await provider.getBalance(deployer.address);
  const balanceMon = parseFloat(ethers.formatEther(balance));
  console.log(`[AirWeave Deployer] Deployer MON Balance: ${balanceMon.toFixed(4)} MON`);

  if (balanceMon < 0.05) {
    console.error(`\n[AirWeave Deployer] INSUFFICIENT FUNDS!`);
    console.error(`Please fund the deployer wallet to proceed with the contract deploy.`);
    console.error(`Address: ${deployer.address}`);
    console.error(`Faucet URL: https://faucet.monad.xyz`);
    console.error(`After funding, run: node deploy-vault.js\n`);
    process.exit(1);
  }

  // 3. Read & Compile MonadAirVault.sol
  const contractPath = path.resolve('../contracts/MonadAirVault.sol');
  console.log(`[AirWeave Deployer] Reading contract from: ${contractPath}`);
  if (!fs.existsSync(contractPath)) {
    console.error(`[AirWeave Deployer] Error: Contract file not found!`);
    process.exit(1);
  }

  const source = fs.readFileSync(contractPath, 'utf8');

  console.log('[AirWeave Deployer] Compiling MonadAirVault.sol (solc v0.8.20)...');
  const input = {
    language: 'Solidity',
    sources: {
      'MonadAirVault.sol': {
        content: source
      }
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object']
        }
      },
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    let hasErrors = false;
    for (const err of output.errors) {
      console.error(err.formattedMessage);
      if (err.severity === 'error') hasErrors = true;
    }
    if (hasErrors) {
      console.error('[AirWeave Deployer] Compilation failed!');
      process.exit(1);
    }
  }

  const contractData = output.contracts['MonadAirVault.sol']['MonadAirVault'];
  const abi = contractData.abi;
  const bytecode = contractData.evm.bytecode.object;

  console.log('[AirWeave Deployer] Contract compiled successfully.');

  // 4. Deploy Contract
  console.log('[AirWeave Deployer] Deploying MonadAirVault to Monad Testnet...');
  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  
  // Set explicit gasLimit on Monad to prevent estimateGas high-bound overcharges
  const deployTx = await factory.deploy(USDX_ADDRESS, {
    gasLimit: 3_000_000
  });

  console.log(`[AirWeave Deployer] Deployment transaction hash: ${deployTx.deploymentTransaction().hash}`);
  console.log('[AirWeave Deployer] Waiting for transaction confirmation on Monad...');
  
  const deployedContract = await deployTx.waitForDeployment();
  const vaultAddress = await deployedContract.getAddress();
  
  console.log(`\n[AirWeave Deployer] SUCCESS! MonadAirVault deployed at: ${vaultAddress}`);

  // 5. Update environment variables & contract files
  console.log('[AirWeave Deployer] Updating environment configs...');
  
  // Update vendor .env
  let vendorEnv = fs.readFileSync(envPath, 'utf8');
  if (vendorEnv.includes('VAULT_ADDRESS=')) {
    vendorEnv = vendorEnv.replace(/VAULT_ADDRESS=\S*/g, `VAULT_ADDRESS=${vaultAddress}`);
  } else {
    vendorEnv += `\nVAULT_ADDRESS=${vaultAddress}\nUSDX_ADDRESS=${USDX_ADDRESS}\n`;
  }
  fs.writeFileSync(envPath, vendorEnv, 'utf8');
  console.log('  -> Updated vendor .env');

  // Update customer .env
  const customerEnvPath = path.resolve('../airweave-customer/.env');
  let customerEnv = '';
  if (fs.existsSync(customerEnvPath)) {
    customerEnv = fs.readFileSync(customerEnvPath, 'utf8');
  }
  if (customerEnv.includes('VITE_VAULT_ADDRESS=')) {
    customerEnv = customerEnv.replace(/VITE_VAULT_ADDRESS=\S*/g, `VITE_VAULT_ADDRESS=${vaultAddress}`);
  } else {
    customerEnv += `\nVITE_VAULT_ADDRESS=${vaultAddress}\nVITE_USDX_ADDRESS=${USDX_ADDRESS}\nVITE_MONAD_RPC=${PROVIDER_URL}\nVITE_CHAIN_ID=10143\n`;
  }
  fs.writeFileSync(customerEnvPath, customerEnv, 'utf8');
  console.log('  -> Updated customer .env');

  // Update MonadAirVault.sol placeholder comment
  let contractSource = fs.readFileSync(contractPath, 'utf8');
  contractSource = contractSource.replace(/MonadAirVault: \[DEPLOY AND FILL IN\]/g, `MonadAirVault: ${vaultAddress}`);
  fs.writeFileSync(contractPath, contractSource, 'utf8');
  console.log('  -> Updated address comment in MonadAirVault.sol');

  console.log('\n[AirWeave Deployer] Done. You can now proceed to Task 2.');
}

main().catch(err => {
  console.error('[AirWeave Deployer] Deployment error:', err);
  process.exit(1);
});
