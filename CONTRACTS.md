# DJZS Protocol — Solidity Contracts

## Overview

The DJZS protocol uses 4 Solidity contracts deployed on Base Mainnet. Together they provide on-chain trust scoring, escrow-gated audit settlement, agent staking, and a global agent registry.

---

## 1. DJZSLogicTrustScore

**Purpose**: Stores on-chain trust scores for autonomous agents after each audit. The chain writer calls `updateScore()` to record the verdict, risk score, and flag codes permanently on Base.

**Deployed Address**: [`0xB3324D07A8713b354435FF0e2A982A504e81b137`](https://basescan.org/address/0xB3324D07A8713b354435FF0e2A982A504e81b137)

### Key Functions

| Function | Access | Description |
|---|---|---|
| `updateScore(agent, riskScore, verdict, flags, irysTxId)` | Writer / Owner | Records a new audit result for the given agent address |
| `getLatestScore(agent)` | View | Returns the most recent risk score, verdict, timestamp, and total audit count |
| `getAuditRecord(agent, index)` | View | Returns a specific historical audit record by index |
| `getAuditHistory(agent)` | View | Returns the total number of audits for an agent |
| `authorizeWriter(writer)` | Owner | Grants an address permission to call `updateScore` |
| `revokeWriter(writer)` | Owner | Revokes writer permission |

### Events

- `ScoreUpdated(agent, riskScore, verdict, flags, irysTxId, timestamp)` — emitted on every trust score write
- `WriterAuthorized(writer)` — emitted when a new writer is authorized
- `WriterRevoked(writer)` — emitted when a writer is revoked

### Constructor

No parameters. Deployer becomes owner and first authorized writer.

### Environment Variables

- `TRUST_SCORE_CONTRACT_ADDRESS` — deployed contract address
- `SETTLEMENT_PRIVATE_KEY` — private key of the authorized writer wallet
- `BASE_RPC_URL` — Base Mainnet RPC endpoint

---

## 2. DJZSEscrowLock

**Purpose**: Holds USDC in escrow during an audit. When the audit completes, the settlement agent calls `settleEscrow()` to release funds to the recipient (PASS) or refund to the creator (FAIL).

**Deployed Address**: [`0xB041760147a60F63Ca701da9e431412bCc25Cfb7`](https://basescan.org/address/0xB041760147a60F63Ca701da9e431412bCc25Cfb7)

### Key Functions

| Function | Access | Description |
|---|---|---|
| `createEscrow(recipient, amount, executionTraceHash)` | Any | Locks USDC and emits `AuditPending` |
| `settleEscrow(escrowId, passed, irisTxId)` | Settlement Agent / Owner | Settles the escrow based on audit verdict |
| `refundEscrow(escrowId)` | Owner | Emergency refund for unsettled escrows |
| `getEscrow(escrowId)` | View | Returns escrow details |
| `setSettlementAgent(agent)` | Owner | Updates the settlement agent address |

### Events

- `EscrowCreated(escrowId, creator, recipient, amount, executionTraceHash)`
- `AuditPending(escrowId, creator, recipient, executionTraceHash, amount)`
- `EscrowSettled(escrowId, passed, irisTxId)`
- `EscrowRefunded(escrowId)`

### Constructor Parameters

| Parameter | Type | Description |
|---|---|---|
| `_paymentToken` | `address` | USDC token contract address on Base |

### Environment Variables

- `ESCROW_CONTRACT_ADDRESS` — deployed contract address
- `SETTLEMENT_PRIVATE_KEY` — private key of the settlement agent wallet
- `BASE_RPC_URL` — Base Mainnet RPC endpoint

---

## 3. DJZSStaking

**Purpose**: Allows agents or agent operators to stake tokens as a credibility bond. Staked agents can be slashed by the protocol owner if an audit reveals malicious behavior.

**Deployed Address**: [`0xA362947D23D52C05a431E378F30C8A962De91e8A`](https://basescan.org/address/0xA362947D23D52C05a431E378F30C8A962De91e8A)

### Key Functions

| Function | Access | Description |
|---|---|---|
| `stake(amount)` | Any | Stakes tokens with a time lock |
| `unstake()` | Staker | Withdraws stake after lock period |
| `slash(staker, amount, reason)` | Owner | Slashes a staker's bond |
| `getStake(staker)` | View | Returns stake details |
| `setMinimumStake(amount)` | Owner | Updates minimum stake requirement |
| `setLockDuration(duration)` | Owner | Updates lock duration in seconds |

### Events

- `Staked(staker, amount, lockUntil)`
- `Unstaked(staker, amount)`
- `Slashed(staker, amount, reason)`
- `MinimumStakeUpdated(newMinimum)`
- `LockDurationUpdated(newDuration)`

### Constructor Parameters

| Parameter | Type | Description |
|---|---|---|
| `_stakingToken` | `address` | ERC-20 token to stake |
| `_minimumStake` | `uint256` | Minimum stake amount |
| `_lockDuration` | `uint256` | Lock duration in seconds |

---

## 4. DJZSAgentRegistry

**Purpose**: On-chain registry of autonomous agents. Agents self-register (or are registered by the protocol owner) with a name and metadata URI. Used for fleet discovery and reputation tracking.

**Deployed Address**: [`0xe40d5669Ce8e06A91188B82Ce7292175E2013E41`](https://basescan.org/address/0xe40d5669Ce8e06A91188B82Ce7292175E2013E41)

### Key Functions

| Function | Access | Description |
|---|---|---|
| `registerAgent(agent, name, metadataUri)` | Agent / Owner | Registers a new agent |
| `deactivateAgent(agent)` | Agent Owner / Owner | Marks agent as inactive |
| `reactivateAgent(agent)` | Agent Owner / Owner | Re-activates an agent |
| `updateMetadata(agent, metadataUri)` | Agent Owner / Owner | Updates the agent's metadata URI |
| `getAgent(agent)` | View | Returns agent info |
| `getAgentCount()` | View | Total registered agents |
| `getAgentAtIndex(index)` | View | Agent address at index (for enumeration) |

### Events

- `AgentRegistered(agent, name, agentOwner)`
- `AgentDeactivated(agent)`
- `AgentReactivated(agent)`
- `AgentMetadataUpdated(agent, metadataUri)`

### Constructor

No parameters. Deployer becomes owner.

---

## 5. DJZSProofOfLogicNFT

**Purpose**: Fully on-chain ERC-721 NFT that stores the complete ProofOfLogic certificate. The NFT IS the certificate — not a pointer to it. On-chain SVG in Terminal Brutalism style. Minted only on PASS verdicts (enforced on-chain via keccak256 check).

**Deployed Address**: [`0xA91D750Cb2e1Bae30fe9dec744D27B8654c8393c`](https://basescan.org/address/0xA91D750Cb2e1Bae30fe9dec744D27B8654c8393c)

### Key Functions

| Function | Access | Description |
|---|---|---|
| `mint(recipient, auditId, timestamp, tier, riskScore, verdict, flagsJson, cryptographicHash, irysTxId, irysUrl, certificateJson)` | Minter / Owner | Mints NFT with full certificate stored on-chain. Requires verdict="PASS" |
| `tokenURI(tokenId)` | View | Returns fully on-chain ERC-721 metadata with SVG image as base64 data-URI |
| `getRawCertificate(tokenId)` | View | Returns the raw certificate JSON stored on-chain |
| `getTokenByIrys(irysTxId)` | View | Returns tokenId for a given Irys TX ID (0 if not minted) |
| `totalMinted()` | View | Returns total number of NFTs minted |
| `authorizeMinter(minter)` | Owner | Grants minting permission |
| `revokeMinter(minter)` | Owner | Revokes minting permission |

### Events

- `ProofMinted(tokenId, recipient, auditId, irysTxId, tier, riskScore)` — emitted on every mint
- `MinterAuthorized(minter)` — emitted when a minter is authorized
- `MinterRevoked(minter)` — emitted when a minter is revoked

### Errors

- `AlreadyMinted(irysTxId)` — prevents double-minting for same Irys certificate
- `VerdictNotPass()` — enforces on-chain PASS-only minting
- `NotAuthorizedMinter()` — caller is not an authorized minter
- `EmptyField()` — required field is empty

---

## Deployment

Contracts are deployed externally using Hardhat. See `hardhat.config.cjs` and `scripts/deploy.cjs` for the deployment configuration. See `scripts/deploy-proof-of-logic.cjs` for NFT contract deployment.

### Required Environment Variables for Deployment

```bash
DEPLOYER_PRIVATE_KEY=0x...   # Deployer wallet private key (funded with ETH on Base)
BASE_RPC_URL=https://mainnet.base.org
BASE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  # USDC on Base
```

### Required Environment Variables for NFT Minting (Runtime)

```bash
NFT_CONTRACT_ADDRESS=0x...     # Deployed ProofOfLogicNFT contract address
SETTLEMENT_PRIVATE_KEY=0x...   # Server wallet authorized as minter (pays gas)
BASE_RPC_URL=https://mainnet.base.org
```

### Deployment Order

1. `DJZSAgentRegistry` (no dependencies)
2. `DJZSLogicTrustScore` (no dependencies)
3. `DJZSStaking` (requires USDC address)
4. `DJZSEscrowLock` (requires USDC address)
5. `DJZSProofOfLogicNFT` (no dependencies; authorize settlement wallet as minter post-deploy)

After deployment, authorize the settlement wallet as a writer on `DJZSLogicTrustScore`, as the settlement agent on `DJZSEscrowLock`, and as a minter on `DJZSProofOfLogicNFT`.

---

## Base Sepolia Testnet

The `base-sepolia` network is configured in `hardhat.config.cjs` for testnet deployment and integration testing. ChainId: `84532`, RPC: `https://sepolia.base.org`.

### DJZSProofOfLogicNFT (Testnet)

**Deployed Address**: Testnet deployment not required — contract is live on Base Mainnet at [`0xA91D750Cb2e1Bae30fe9dec744D27B8654c8393c`](https://basescan.org/address/0xA91D750Cb2e1Bae30fe9dec744D27B8654c8393c).

### Testnet Deployment Steps

1. **Get testnet ETH** — Fund your deployer address via the [Coinbase Base Sepolia faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet).

2. **Deploy the contract**:
   ```bash
   npx hardhat run scripts/deploy-proof-of-logic.cjs --network base-sepolia
   ```
   This will print the deployed address and authorize the settlement wallet as a minter.

3. **Set the testnet address** — Add to your `.env`:
   ```bash
   NFT_CONTRACT_ADDRESS=0x<address from step 2>
   ```

4. **Run the test mint** to verify the contract works on-chain:
   ```bash
   npx hardhat run scripts/test-mint-sepolia.cjs --network base-sepolia
   ```
   This mints a test NFT, reads back the certificate, and decodes the tokenURI.

5. **Integration testing** — With `NFT_CONTRACT_ADDRESS` set and `BASE_RPC_URL` pointing to `https://sepolia.base.org`, the server will auto-mint NFTs on Founder/Treasury PASS verdicts. The Micro-tier "Mint NFT" button will also work.

### Required Environment Variables (Testnet)

```bash
DEPLOYER_MNEMONIC=...                          # 12-word mnemonic for deployment
NFT_CONTRACT_ADDRESS=0x...                     # Set after deployment
SETTLEMENT_PRIVATE_KEY=0x...                   # Server wallet (authorized minter)
BASE_RPC_URL=https://sepolia.base.org          # Point to Sepolia for testing
```

### Switching Back to Mainnet

To switch back to mainnet after testing, update:
```bash
BASE_RPC_URL=https://mainnet.base.org
NFT_CONTRACT_ADDRESS=0x<mainnet address>
```

---

## 5. DJZSVerdictRule (DJZS-VR-v1.0)

**Purpose**: The verdict rule of the deterministic engine as bytecode. Given a tally (fired codes, unknown scored fields, bounded, thesis present), derives the risk score and the verdict for DJZS-PM-v1.0 and DJZS-LF-v1.2. Refuses unknown rulesets, unknown codes and duplicate codes. Held against the engine by `tests/fixtures/verdict-rule.json` (every distinct tally the engine produces over 59,157 inputs) in `test/DJZSVerdictRule.test.cjs`.

**Deployed Address**: not yet deployed. `VERDICT_RULE.md` has the deploy order.

### Key Functions

| Function | Access | Description |
|---|---|---|
| `score(Tally)` | View | Returns `(riskScore, verdictCode)`; PASS 1, WAIT 2, FAIL 3 |
| `isConsistent(Tally, riskScore, verdict)` | View | True when the attested pair is exactly what the rule derives |
| `weightOf(rulesetId, codeId)` | View | `(weight, critical, known)`; `known` false for a code the ruleset lacks |
| `verdictString(code)` | View | "PASS", "WAIT", "FAIL" |

No owner, no setters, no state. A new taxonomy version is a new contract.

## 6. DJZSVerdictResolver

**Purpose**: EAS schema resolver for the DJZS verdict schema v3 (`bytes32 intentHash,string verdict,uint8 riskScore,string[] flags,string rulesetVersion,uint8 unknownCount,bool bounded,bool thesisPresent`, revocable = false). EAS accepts an attestation under the schema only when DJZSVerdictRule derives the stated verdict and risk score from the stated tally, whoever the attester is. `check(bytes)` is the same derivation as a free view.

**Deployed Address**: not yet deployed. Schema v3 UID = `keccak256(abi.encodePacked(schema, resolver, false))`, printed by `scripts/deploy-verdict-rule.cjs`.

### Environment Variables

- `EAS_RESOLVER_ADDRESS` (djzs-trust-mcp wrangler.toml `[vars]`): when set, the Worker attests under schema v3; absent, schema v2 as before.
