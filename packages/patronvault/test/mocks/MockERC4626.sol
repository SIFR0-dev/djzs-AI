// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "./MockUSDC.sol";

/// @dev An ERC-4626 vault with OpenZeppelin's rounding (deposit/redeem round down, withdraw rounds up,
///      virtual share and asset of 1 each) plus three test levers:
///        gain(x)  mints x assets into the vault: the share price rises, like interest.
///        loss(x)  burns x assets from the vault: the share price falls, like bad debt.
///        setLiquidity(x) caps maxWithdraw/withdraw/redeem at x assets, like an illiquid lending market.
contract MockERC4626 {
    MockUSDC public immutable usdc;
    string public constant name = "Mock yield source";
    string public constant symbol = "mySRC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public liquidity = type(uint256).max;
    uint256 public gains; // lifetime assets injected by gain()
    uint256 public losses; // lifetime assets removed by loss()

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

    error Illiquid();

    constructor(MockUSDC usdc_) {
        usdc = usdc_;
    }

    // ───── test levers ─────

    function gain(uint256 assets) external {
        usdc.mint(address(this), assets);
        gains += assets;
    }

    function loss(uint256 assets) external {
        usdc.burn(address(this), assets);
        losses += assets;
    }

    function setLiquidity(uint256 assets) external {
        liquidity = assets;
    }

    // ───── ERC-4626 ─────

    function asset() external view returns (address) {
        return address(usdc);
    }

    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return _toShares(assets, false);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, false);
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return _toShares(assets, false);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, true);
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return _toShares(assets, true);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, false);
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) public view returns (uint256) {
        uint256 own = _toAssets(balanceOf[owner], false);
        uint256 cap = liquidity < totalAssets() ? liquidity : totalAssets();
        return own < cap ? own : cap;
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf[owner];
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = _toShares(assets, false);
        require(usdc.transferFrom(msg.sender, address(this), assets));
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        assets = _toAssets(shares, true);
        require(usdc.transferFrom(msg.sender, address(this), assets));
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        if (assets > maxWithdraw(owner)) revert Illiquid();
        shares = _toShares(assets, true);
        _spend(owner, shares);
        _burn(owner, shares);
        require(usdc.transfer(receiver, assets));
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        assets = _toAssets(shares, false);
        if (assets > maxWithdraw(owner)) revert Illiquid();
        _spend(owner, shares);
        _burn(owner, shares);
        require(usdc.transfer(receiver, assets));
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    // ───── ERC-20 ─────

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spend(from, amount);
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    // ───── internals ─────

    function _toShares(uint256 assets, bool roundUp) internal view returns (uint256) {
        uint256 num = assets * (totalSupply + 1);
        uint256 den = totalAssets() + 1;
        uint256 q = num / den;
        if (roundUp && q * den < num) q += 1;
        return q;
    }

    function _toAssets(uint256 shares, bool roundUp) internal view returns (uint256) {
        uint256 num = shares * (totalAssets() + 1);
        uint256 den = totalSupply + 1;
        uint256 q = num / den;
        if (roundUp && q * den < num) q += 1;
        return q;
    }

    function _spend(address owner, uint256 shares) internal {
        if (owner == msg.sender) return;
        uint256 a = allowance[owner][msg.sender];
        if (a != type(uint256).max) allowance[owner][msg.sender] = a - shares;
    }

    function _mint(address to, uint256 shares) internal {
        totalSupply += shares;
        balanceOf[to] += shares;
        emit Transfer(address(0), to, shares);
    }

    function _burn(address from, uint256 shares) internal {
        balanceOf[from] -= shares;
        totalSupply -= shares;
        emit Transfer(from, address(0), shares);
    }
}
