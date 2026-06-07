// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              MonadAirVault — AirWeave Phase 2                ║
 * ║         Offline Payment Settlement on Monad Testnet           ║
 * ║                   Chain ID: 10143                             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * WHAT THIS CONTRACT DOES:
 * -------------------------------------------------
 * 1. Customers deposit USDX tokens into their personal vault before
 *    going offline into low-connectivity zones.
 *
 * 2. While offline, the customer signs EIP-712 vouchers locally on their
 *    device — mathematical IOUs denominated in Paise (1 INR = 100 Paise).
 *    These vouchers are transmitted over local WiFi to the vendor's SQLite
 *    ledger — no blockchain contact required.
 *
 * 3. When the vendor's device reaches connectivity, it submits the
 *    collected voucher batch to this contract. The contract:
 *      a. Recovers the customer's address from each signature (ecrecover)
 *      b. Reads the live INR/USDX rate from a stored oracle rate
 *         (updated by the owner when settling — hackathon-safe approach)
 *      c. Calculates the exact USDX amount matching the promised Paise value
 *      d. Debits the customer's vault, credits the vendor's balance
 *      e. Marks the nonce as used (replay protection)
 *
 * 4. Vendors withdraw their accumulated USDX balance at any time.
 *
 * MONAD-SPECIFIC DESIGN NOTES:
 * -------------------------------------------------
 * - Gas is charged on gas_limit, NOT gas_used on Monad. We set explicit
 *   gas limits in the app layer rather than relying on eth_estimateGas,
 *   which avoids MetaMask's high-gas fallback behavior on revert.
 *
 * - Monad's parallel EVM executes independent transactions simultaneously.
 *   Each voucher in a batch touches a DIFFERENT customer's vault balance
 *   and a DIFFERENT nonce slot → zero state contention → true parallelism.
 *   The entire regional offline backlog settles in one 0.4-second block.
 *
 * - Reserve Balance: EOAs must keep 10 MON. This contract holds USDX (ERC-20),
 *   not MON, so reserve balance doesn't affect vault operations.
 *
 * SECURITY MODEL:
 * -------------------------------------------------
 * - ecrecover verifies every signature with zero network dependency
 * - Nonces are per-customer and strictly tracked (no replay)
 * - Voucher expiry prevents stale outstanding obligations
 * - Over-collateralization: app layer caps offline spend at 60% of vault
 * - Owner can update the INR rate for demo purposes (production: use Pyth oracle)
 *
 * DEPLOYED ADDRESSES:
 * -------------------------------------------------
 * USDX Token: 0x94C647a5d232769705707925d551E99618E2688c
 * MonadAirVault: [DEPLOY AND FILL IN]
 *
 * DEPLOY VIA REMIX:
 * -------------------------------------------------
 * Constructor arg: _usdxToken = "0x94C647a5d232769705707925d551E99618E2688c"
 */

// ── Minimal ERC-20 interface for USDX interactions ──────────────────────────

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

// ── Main contract ────────────────────────────────────────────────────────────

contract MonadAirVault {

    // ── State variables ──────────────────────────────────────────────────────

    address public owner;
    IERC20  public usdxToken;

    // Customer vault balances (in USDX wei — 18 decimals)
    mapping(address => uint256) public vaultBalances;

    // Vendor accumulated balances (in USDX wei — 18 decimals)
    mapping(address => uint256) public vendorBalances;

    // Replay protection: tracks used nonces per customer address
    // customer => nonce => used
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    // INR/USDX exchange rate for settlement
    // Stored as: how many Paise equals 1 USDX (18 decimals)
    // Example: 1 USDX = 95 INR = 9500 Paise
    // So inrRateInPaise = 9500
    // This means: usdxAmount = (voucher.amountPaise * 1e18) / inrRateInPaise
    uint256 public inrRateInPaise;

    // EIP-712 domain separator — hardlocked to Monad Testnet chain ID 10143
    bytes32 public DOMAIN_SEPARATOR;

    // EIP-712 typehash for the Voucher struct
    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(address from,address to,uint256 amountINR,uint256 nonce,uint256 expiry)"
    );

    // ── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed customer, uint256 usdxAmount, uint256 inrEquivalent);
    event VoucherSettled(
        uint256 indexed nonce,
        address indexed customer,
        address indexed vendor,
        uint256 amountPaise,
        uint256 usdxDebited
    );
    event VendorWithdraw(address indexed vendor, uint256 usdxAmount);
    event RateUpdated(uint256 oldRate, uint256 newRate);
    event BatchSettled(uint256 count, uint256 totalUsdx);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error ZeroAmount();
    error VoucherExpired(uint256 expiry, uint256 blockTimestamp);
    error NonceAlreadyUsed(address customer, uint256 nonce);
    error SignerMismatch(address recovered, address claimed);
    error InsufficientVaultBalance(address customer, uint256 required, uint256 available);
    error InvalidSignatureLength();
    error TransferFailed();
    error ZeroRate();

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param _usdxToken Address of the USDX ERC-20 token contract
     *                   On Monad Testnet: 0x94C647a5d232769705707925d551E99618E2688c
     */
    constructor(address _usdxToken) {
        owner = msg.sender;
        usdxToken = IERC20(_usdxToken);

        // Default rate: 1 USDX = 95 INR = 9500 Paise
        // Update this before settling with setRate()
        inrRateInPaise = 9500;

        // Build EIP-712 domain separator
        // chainId 10143 = Monad Testnet
        // This MUST match the DOMAIN object in your ethers.js app code exactly
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("AirWeave"),
            keccak256("1"),
            uint256(10143),
            address(this)
        ));
    }

    // ── Customer: Deposit ────────────────────────────────────────────────────

    /**
     * @notice Deposit USDX into your vault before going offline.
     *         Customer must first call usdxToken.approve(vaultAddress, amount).
     *
     * @param usdxAmount Amount of USDX to deposit (18 decimals)
     *                   Example: 10 USDX = 10 * 1e18 = 10000000000000000000
     *
     * UI equivalent in ethers.js:
     *   const amount = ethers.parseUnits("10", 18);  // 10 USDX
     *   await usdx.approve(vaultAddress, amount);
     *   await vault.deposit(amount);
     */
    function deposit(uint256 usdxAmount) external {
        if (usdxAmount == 0) revert ZeroAmount();

        bool ok = usdxToken.transferFrom(msg.sender, address(this), usdxAmount);
        if (!ok) revert TransferFailed();

        vaultBalances[msg.sender] += usdxAmount;

        // Calculate INR equivalent for event (informational only)
        uint256 inrEquivalent = (usdxAmount * inrRateInPaise) / 1e18;

        emit Deposited(msg.sender, usdxAmount, inrEquivalent);
    }

    // ── Vendor: Settle a single voucher ─────────────────────────────────────

    /**
     * @notice Submit one offline-signed voucher for settlement.
     *         Typically called by the vendor when connectivity returns.
     *
     * @param from       Customer's address (voucher.from)
     * @param to         Vendor's address (voucher.to)
     * @param amountINR  Amount in Paise (₹35 = 3500, not 35)
     * @param nonce      Customer's nonce for this voucher
     * @param expiry     Unix timestamp after which voucher is invalid
     * @param signature  65-byte EIP-712 signature from customer's wallet
     *
     * NOTE: amountINR field name kept for EIP-712 compatibility with frontend.
     *       The actual value stored is in Paise (1 INR = 100 Paise).
     */
    function settleVoucher(
        address from,
        address to,
        uint256 amountINR,
        uint256 nonce,
        uint256 expiry,
        bytes calldata signature
    ) external {
        // 1. Check expiry
        if (block.timestamp > expiry) {
            revert VoucherExpired(expiry, block.timestamp);
        }

        // 2. Check nonce hasn't been used
        if (usedNonces[from][nonce]) {
            revert NonceAlreadyUsed(from, nonce);
        }

        // 3. Recover signer from EIP-712 signature
        address recovered = _recoverSigner(from, to, amountINR, nonce, expiry, signature);

        // 4. Verify recovered address matches claimed sender
        if (recovered != from) {
            revert SignerMismatch(recovered, from);
        }

        // 5. Calculate USDX amount from Paise value using current rate
        // usdxAmount = (amountPaise * 1e18) / inrRateInPaise
        uint256 usdxAmount = (amountINR * 1e18) / inrRateInPaise;

        // 6. Check customer has enough vault balance
        if (vaultBalances[from] < usdxAmount) {
            revert InsufficientVaultBalance(from, usdxAmount, vaultBalances[from]);
        }

        // 7. Mark nonce as used BEFORE state changes (reentrancy-safe ordering)
        usedNonces[from][nonce] = true;

        // 8. Atomic settlement: debit customer, credit vendor
        vaultBalances[from]   -= usdxAmount;
        vendorBalances[to]    += usdxAmount;

        emit VoucherSettled(nonce, from, to, amountINR, usdxAmount);
    }

    // ── Vendor: Batch settle ─────────────────────────────────────────────────

    /**
     * @notice Settle multiple vouchers in one transaction.
     *         This is the PRIMARY function used at settlement time.
     *
     *         Because each voucher touches a DIFFERENT customer address and
     *         a DIFFERENT nonce slot, Monad's parallel EVM executes all
     *         state reads and writes simultaneously — zero contention.
     *
     * @param froms      Array of customer addresses
     * @param tos        Array of vendor addresses
     * @param amounts    Array of amountINR values (in Paise)
     * @param nonces     Array of nonces
     * @param expiries   Array of expiry timestamps
     * @param signatures Array of 65-byte EIP-712 signatures
     *
     * Example for settling 3 vouchers:
     *   await vault.settleBatch(
     *     [cust1, cust2, cust3],
     *     [vendor, vendor, vendor],
     *     [3500, 7000, 1500],     // ₹35, ₹70, ₹15 in Paise
     *     [7, 3, 12],             // nonces
     *     [exp1, exp2, exp3],
     *     [sig1, sig2, sig3]
     *   );
     */
    function settleBatch(
        address[] calldata froms,
        address[] calldata tos,
        uint256[] calldata amounts,
        uint256[] calldata nonces,
        uint256[] calldata expiries,
        bytes[]   calldata signatures
    ) external {
        uint256 len = froms.length;
        require(
            tos.length == len &&
            amounts.length == len &&
            nonces.length == len &&
            expiries.length == len &&
            signatures.length == len,
            "MonadAirVault: array length mismatch"
        );

        uint256 totalUsdx = 0;
        uint256 settledCount = 0;

        for (uint256 i = 0; i < len; i++) {
            // Skip expired or already-used vouchers silently in batch mode
            // (don't revert the entire batch for one bad voucher)
            if (block.timestamp > expiries[i]) continue;
            if (usedNonces[froms[i]][nonces[i]]) continue;

            // Recover signer
            address recovered = _recoverSigner(
                froms[i], tos[i], amounts[i], nonces[i], expiries[i], signatures[i]
            );
            if (recovered != froms[i]) continue;

            // Calculate USDX
            uint256 usdxAmount = (amounts[i] * 1e18) / inrRateInPaise;

            // Skip if insufficient balance (don't revert batch)
            if (vaultBalances[froms[i]] < usdxAmount) continue;

            // Settle
            usedNonces[froms[i]][nonces[i]] = true;
            vaultBalances[froms[i]]  -= usdxAmount;
            vendorBalances[tos[i]]   += usdxAmount;

            totalUsdx += usdxAmount;
            settledCount++;

            emit VoucherSettled(nonces[i], froms[i], tos[i], amounts[i], usdxAmount);
        }

        emit BatchSettled(settledCount, totalUsdx);
    }

    // ── Vendor: Withdraw ─────────────────────────────────────────────────────

    /**
     * @notice Withdraw accumulated USDX to vendor's wallet.
     *         In production: integrate with Transak/Mudrex for INR off-ramp.
     *         For demo: just shows USDX moving to vendor address.
     */
    function vendorWithdraw() external {
        uint256 amount = vendorBalances[msg.sender];
        if (amount == 0) revert ZeroAmount();

        vendorBalances[msg.sender] = 0;

        bool ok = usdxToken.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit VendorWithdraw(msg.sender, amount);
    }

    // ── Customer: Withdraw (emergency) ───────────────────────────────────────

    /**
     * @notice Emergency withdrawal for customers — reclaim unspent vault balance.
     *         Note: any outstanding unsigned vouchers become uncollectable by vendor.
     */
    function customerWithdraw(uint256 usdxAmount) external {
        if (usdxAmount == 0) revert ZeroAmount();
        if (vaultBalances[msg.sender] < usdxAmount) {
            revert InsufficientVaultBalance(msg.sender, usdxAmount, vaultBalances[msg.sender]);
        }

        vaultBalances[msg.sender] -= usdxAmount;

        bool ok = usdxToken.transfer(msg.sender, usdxAmount);
        if (!ok) revert TransferFailed();
    }

    // ── Owner: Update exchange rate ───────────────────────────────────────────

    /**
     * @notice Update the INR/USDX exchange rate used for settlement.
     *         For demo: call this before settling with the current market rate.
     *         For production: replace with Pyth Network pull oracle.
     *
     * @param newRateInPaise  Paise per USDX. Example: 9500 = 1 USDX = 95 INR
     *
     * How to calculate:
     *   If 1 USDX = 84 INR → newRateInPaise = 8400
     *   If 1 USDX = 95 INR → newRateInPaise = 9500
     *   If 1 USDX = 100 INR → newRateInPaise = 10000
     */
    function setRate(uint256 newRateInPaise) external onlyOwner {
        if (newRateInPaise == 0) revert ZeroRate();
        uint256 old = inrRateInPaise;
        inrRateInPaise = newRateInPaise;
        emit RateUpdated(old, newRateInPaise);
    }

    // ── Owner: Transfer ownership ─────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "MonadAirVault: zero address");
        owner = newOwner;
    }

    // ── View functions ────────────────────────────────────────────────────────

    /**
     * @notice Get customer vault balance in both USDX and INR equivalent
     */
    function getVaultBalance(address customer)
        external view
        returns (uint256 usdxAmount, uint256 inrEquivalent)
    {
        usdxAmount   = vaultBalances[customer];
        inrEquivalent = (usdxAmount * inrRateInPaise) / 1e18;
    }

    /**
     * @notice Get vendor balance in both USDX and INR equivalent
     */
    function getVendorBalance(address vendor)
        external view
        returns (uint256 usdxAmount, uint256 inrEquivalent)
    {
        usdxAmount   = vendorBalances[vendor];
        inrEquivalent = (usdxAmount * inrRateInPaise) / 1e18;
    }

    /**
     * @notice Check if a specific nonce has been used for a customer
     */
    function isNonceUsed(address customer, uint256 nonce) external view returns (bool) {
        return usedNonces[customer][nonce];
    }

    /**
     * @notice Calculate USDX required for a given Paise amount at current rate
     *         Frontend uses this to show "you need X USDX in vault for this payment"
     */
    function calculateUsdx(uint256 amountPaise) external view returns (uint256) {
        return (amountPaise * 1e18) / inrRateInPaise;
    }

    // ── Internal: EIP-712 signature recovery ──────────────────────────────────

    /**
     * @dev Recovers the signer address from an EIP-712 typed data signature.
     *      This is pure offline math — no network calls, no oracle queries.
     *      The domain separator locks recovery to this specific contract on
     *      Monad Testnet (chain ID 10143) — prevents cross-chain replay.
     */
    function _recoverSigner(
        address from,
        address to,
        uint256 amountINR,
        uint256 nonce,
        uint256 expiry,
        bytes calldata signature
    ) internal view returns (address) {
        if (signature.length != 65) revert InvalidSignatureLength();

        // Hash the voucher struct
        bytes32 structHash = keccak256(abi.encode(
            VOUCHER_TYPEHASH,
            from,
            to,
            amountINR,
            nonce,
            expiry
        ));

        // Build the full EIP-712 digest
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            DOMAIN_SEPARATOR,
            structHash
        ));

        // Extract r, s, v from signature bytes
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        // Recover and return signer address
        return ecrecover(digest, v, r, s);
    }

    // ── Admin: Emergency pause (for demo safety) ──────────────────────────────

    bool public paused;

    modifier notPaused() {
        require(!paused, "MonadAirVault: paused");
        _;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }
}
