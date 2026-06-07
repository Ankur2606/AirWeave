export const USDX_ADDRESS = process.env.USDX_ADDRESS || "0x94C647a5d232769705707925d551E99618E2688c";
export const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "0x0000000000000000000000000000000000000000";

export const USDX_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function mintPublic(address to, uint256 amount) external"
];

export const VAULT_ABI = [
  "function deposit(uint256 usdxAmount) external",
  "function getVaultBalance(address customer) external view returns (uint256 usdxAmount, uint256 inrEquivalent)",
  "function getVendorBalance(address vendor) external view returns (uint256 usdxAmount, uint256 inrEquivalent)",
  "function isNonceUsed(address customer, uint256 nonce) external view returns (bool)",
  "function calculateUsdx(uint256 amountPaise) external view returns (uint256)",
  "function settleVoucher(address from, address to, uint256 amountINR, uint256 nonce, uint256 expiry, bytes calldata signature) external",
  "function settleBatch(address[] calldata froms, address[] calldata tos, uint256[] calldata amounts, uint256[] calldata nonces, uint256[] calldata expiries, bytes[] calldata signatures) external",
  "function vendorWithdraw() external",
  "function inrRateInPaise() external view returns (uint256)"
];

export const GAS_LIMITS = {
  approve:       80_000,
  deposit:      120_000,
  mintPublic:    90_000,
  settleVoucher: 150_000,
  settleBatch:   200_000,
  vendorWithdraw: 100_000,
};
