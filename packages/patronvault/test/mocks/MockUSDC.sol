// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal 6-decimal ERC-20 for tests. Mint and burn are open.
contract MockUSDC {
    string public constant name = "USD Coin (mock)";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    mapping(address => bool) public blocked; // like Circle's blacklist: transfers to or from revert
    mapping(address => uint256) public nonces;

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error Blocked(address who);
    error PermitExpired();
    error BadSignature();

    function setBlocked(address who, bool isBlocked) external {
        blocked[who] = isBlocked;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    /// @dev USDC v2.2's ERC-7597 permit: a bytes signature, ECDSA for an EOA, EIP-1271 for a contract owner.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature)
        external
    {
        if (block.timestamp > deadline) revert PermitExpired();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        if (owner.code.length != 0) {
            (bool ok, bytes memory ret) = owner.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, signature));
            if (!ok || ret.length < 32 || abi.decode(ret, (bytes4)) != bytes4(0x1626ba7e)) revert BadSignature();
        } else {
            if (signature.length != 65) revert BadSignature();
            bytes32 r;
            bytes32 s_;
            assembly {
                r := calldataload(signature.offset)
                s_ := calldataload(add(signature.offset, 32))
            }
            uint8 v = uint8(signature[64]);
            if (ecrecover(digest, v, r, s_) != owner || owner == address(0)) revert BadSignature();
        }
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
