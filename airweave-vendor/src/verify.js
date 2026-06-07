import { ethers } from 'ethers';

const DOMAIN = {
  name: 'AirWeave',
  version: '1',
  chainId: 10143,
};

const TYPES = {
  Voucher: [
    { name: 'from',      type: 'address' },
    { name: 'to',        type: 'address' },
    { name: 'amountINR', type: 'uint256' },
    { name: 'nonce',     type: 'uint256' },
    { name: 'expiry',    type: 'uint256' },
  ]
};

/**
 * Recovers the signer's address from an EIP-712 signed voucher.
 * 
 * @param {Object} voucher The EIP-712 Voucher struct
 * @param {string} signature The cryptographic signature
 * @returns {string} The recovered Ethers address
 */
export function verifyVoucher(voucher, signature) {
  const typedVoucher = {
    from: voucher.from,
    to: voucher.to,
    amountINR: BigInt(voucher.amountINR),
    nonce: BigInt(voucher.nonce),
    expiry: BigInt(voucher.expiry),
  };
  
  return ethers.verifyTypedData(DOMAIN, TYPES, typedVoucher, signature);
}
