// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * USDX — US Dollar-pegged stablecoin for AirWeave collateral/vault payments
 * Deployed on Monad Testnet (Chain ID: 10143)
 *
 * 1 USDX = 1 USD (fixed peg, used for funding collateral vaults)
 * Anyone can mintPublic() up to 10,000 USDX per call (testnet only)
 */

interface IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract USDX is IERC20 {
    string public constant name     = "USD Stablecoin X";
    string public constant symbol   = "USDX";
    uint8  public constant decimals = 18;

    address public owner;
    uint256 private _totalSupply;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    modifier onlyOwner() {
        require(msg.sender == owner, "USDX: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        // Pre-mint 1,000,000 USDX to deployer
        _mint(msg.sender, 1_000_000 * 1e18);
    }

    // ── ERC-20 Standard ──────────────────────────────────────────────

    function totalSupply() external view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function transfer(address to, uint256 value) external override returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function allowance(address _owner, address spender) external view override returns (uint256) {
        return _allowances[_owner][spender];
    }

    function approve(address spender, uint256 value) external override returns (bool) {
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external override returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= value, "USDX: insufficient allowance");
        _allowances[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    // ── Mint Functions ────────────────────────────────────────────────

    /// @notice Owner mint — fund demo wallets in bulk
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Public mint — TESTNET ONLY. Max 10,000 USDX per call.
    function mintPublic(address to, uint256 amount) external {
        require(amount <= 10_000 * 1e18, "USDX: max 10000 per call");
        _mint(to, amount);
    }

    /// @notice Mint N dollars worth — e.g. mintUSDX(addr, 500) = 500 USDX
    function mintUSDX(address to, uint256 usdAmount) external onlyOwner {
        _mint(to, usdAmount * 1e18);
    }

    // ── Internal ──────────────────────────────────────────────────────

    function _transfer(address from, address to, uint256 value) internal {
        require(from != address(0), "USDX: transfer from zero");
        require(to   != address(0), "USDX: transfer to zero");
        require(_balances[from] >= value, "USDX: insufficient balance");
        _balances[from] -= value;
        _balances[to]   += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        require(to != address(0), "USDX: mint to zero");
        _totalSupply  += value;
        _balances[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "USDX: zero address");
        owner = newOwner;
    }
}