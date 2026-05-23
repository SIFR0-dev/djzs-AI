# DJZS Adversarial Reasoning Auditor for AI Agents

> **No agent acts without audit.**
> *DJZS Protocol — The Immutable Mind*

[![Live](https://img.shields.io/badge/Live-djzs.ai-blue)](https://djzs.ai)
[![License](https://img.shields.io/badge/license-See%20LICENSE-lightgrey)](./LICENSE)

---

## What DJZS Is

DJZS is a **provably-isolated adversarial reasoning audit** for autonomous AI agents.

It does NOT claim deterministic formal verification. It provides something different and complementary: a hostile second brain that stress-tests agent logic in a hardware-isolated environment, then permanently certifies the result on-chain.

Think of it as a **cryptographically-attested code review by a hostile second brain.** The value isn't that it's perfect — it's that it's independent, isolated, and permanent.

**Three pillars:**

- **Adversarial LLM Analysis** — Venice AI stress-tests agent reasoning against the DJZS-LF structured failure taxonomy inside a TEE. Outputs a binary `PASS / FAIL` verdict with machine-parseable failure codes.
- **Tamper-Proof Isolation** — The audit runs inside a Phala/Intel SGX enclave. Neither the agent operator nor DJZS itself can alter the verdict after execution.
- **Immutable Certification** — Every audit result is stored permanently on Irys Datachain with a publicly verifiable, no-auth gateway URL.

> ⚠️ **On Venice AI's "zero data retention" claim:** DJZS's SGX enclave isolates keys and execution from the host operator — it does not enforce Venice's data retention policy. That guarantee is Venice's own claim. Sophisticated operators should evaluate it independently.

---

## Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                      Calling Agent                          │
│         Sends strategy_memo + USDC payment (x402)           │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              Phala Network TEE (Intel SGX Enclave)           │
│                                                             │
│  ┌──────────────┐   ┌───────────────┐   ┌───────────────┐  │
│  │ x402 Payment │──▶│ Venice AI     │──▶│ Irys Datachain│  │
│  │ Verification │   │ Adversarial   │   │ Permanent     │  │
│  │ (Base USDC)  │   │ Analysis      │   │ Upload        │  │
│  └──────────────┘   └───────────────┘   └───────┬───────┘  │
│                                                  │          │
│  Private keys isolated in hardware enclave       │          │
│  (Venice API, Irys wallet, x402 keys)            │          │
└──────────────────────────────────────────────────┼──────────┘
                                                   │
                          ┌────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              ProofOfLogic Certificate                       │
│                                                             │
│  verdict: PASS/FAIL    irys_tx_id: "71oNMzL4hg..."         │
│  risk_score: 0-100     irys_url: gateway.irys.xyz/...       │
│  flags: [DJZS-LF]     provenance_provider: IRYS_DATACHAIN  │
└─────────────────────────────────────────────────────────────┘
```

### Stack

| Layer | Technology | Role |
|---|---|---|
| **Compute** | Phala Network (Intel SGX) | Hardware-isolated execution — private keys never touch disk |
| **Intelligence** | Venice AI (llama-3.3-70b, uncensored) | Adversarial logic analysis with zero data retention |
| **Settlement** | Base Network (USDC) | x402 micropayments — pay-per-audit, no subscriptions |
| **Memory** | Irys Datachain | Permanent, immutable ProofOfLogic certificate storage |
| **Messaging** | XMTP MLS | A2A encrypted dark-channel — agents DM the Oracle directly |

---

## A2A Dark-Channel (XMTP Integration)

DJZS exposes an encrypted agent-to-agent channel via XMTP MLS. Agents can submit reasoning traces directly to the Oracle node without any public HTTP surface — alpha never leaves the encrypted channel.

**Prefix routing dispatches payloads to different backends:**

| Prefix | Backend | Use Case |
|---|---|---|
| `Thinking:` | AdversarialOracle | Logic stress-test, contradiction detection |
| `Journal:` | JournalInsight | Narrative drift analysis, founder reasoning audit |

The XMTP agent listener (`server/agent.ts`) runs concurrently with the REST API inside the Phala CVM. Both share the same SGX enclave — the same key isolation guarantees apply to all channels.

---

## API Integration

### Tiered Pricing

| Tier | Endpoint | Price (USDC) | Memo Limit | Use Case |
|---|---|---|---|---|
| Micro-Zone | `POST /api/audit/micro` | $0.10 | 1,000 chars | Operational sanity checks, binary risk scoring |
| Founder Zone | `POST /api/audit/founder` | $1.00 | 5,000 chars | Strategic roadmap diligence, narrative drift detection |
| Treasury Zone | `POST /api/audit/treasury` | $10.00 | Unlimited | Exhaustive adversarial stress-test for capital deployment decisions |
| Escrow Zone | `POST /api/audit/escrow` | Escrow-funded | Per tier | On-chain escrow audit with hash verification + settlement callback |

`POST /api/audit` is a backward-compatible alias for Micro-Zone.

**Treasury Zone** runs an uncapped adversarial analysis designed for high-stakes capital deployment — multiple reasoning passes, full DJZS-LF sweep, and structural recommendations. Appropriate when the cost of a bad decision materially exceeds $50.

**Escrow Zone** is for agents with on-chain escrow contracts. No x402 payment required — the escrow IS the payment. The Oracle verifies the caller's signature, reads the `AuditPending` event from the escrow transaction, verifies the strategy memo hash on-chain, runs the adversarial audit, uploads to Irys, and settles the escrow contract on Base Mainnet.

### Request Format

```bash
curl -X POST https://YOUR_ORACLE_URL/api/audit/micro \
  -H "Content-Type: application/json" \
  -H "x-payment-proof: 0xYOUR_BASE_MAINNET_TX_HASH" \
  -d '{
    "strategy_memo": "Proposal to allocate 20% of DAO treasury to ETH staking for yield generation. Current treasury: $2.4M USDC. Expected APY: 4.2%.",
    "audit_type": "treasury",
    "target_system": "MyDAOProject"
  }'
```

### Escrow Request Format

```bash
curl -X POST https://YOUR_ORACLE_URL/api/audit/escrow \
  -H "Content-Type: application/json" \
  -H "x-escrow-signature: 0xSIGNATURE_FROM_RECIPIENT_WALLET" \
  -d '{
    "escrow_id": 42,
    "escrow_tx_hash": "0xTRANSACTION_HASH_CONTAINING_AUDIT_PENDING_EVENT",
    "strategy_memo": "Proposal to bridge 500K USDC from Ethereum to Base via official bridge for yield optimization.",
    "audit_type": "treasury"
  }'
```

The `x-escrow-signature` header must be an EIP-191 signature of the message `DJZS-AUDIT:{escrowId}:{keccak256(strategy_memo)}`, signed by the escrow recipient's wallet.

### Request Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `strategy_memo` | string | Yes | The reasoning trace to audit (min 20 chars) |
| `audit_type` | string | No | `treasury`, `founder_drift`, `strategy`, or `general` (default: `general`) |
| `target_system` | string | No | Project name or wallet address — tags the Irys upload for GraphQL discoverability |
| `escrow_id` | number | Escrow only | On-chain escrow ID (positive integer) |
| `escrow_tx_hash` | string | Escrow only | Transaction hash containing the `AuditPending` event |
| `intelligence_context` | string | No | Pre-flight intelligence brief from `/api/intelligence/brief` |
| `trade_params` | object | No | Structured trade parameters for deterministic trade auditing |
| `agent_id` | string | No | Wallet address or XMTP identity for reputation tracking |

### Payment Flow

1. Agent sends USDC to the treasury wallet on Base Mainnet
2. Agent includes the TX hash in the `x-payment-proof` header
3. Oracle verifies on-chain via viem: confirms TX success, decodes ERC-20 Transfer logs, validates recipient and amount, checks replay attacks (each TX hash is single-use)
4. On verification, the adversarial audit runs and the ProofOfLogic certificate is minted on Irys

### Escrow Audit Flow

For agents using on-chain escrow contracts, the flow is different — no x402 payment required:

1. Agent creates an escrow on the DJZS Escrow Contract (Base Mainnet), which emits an `AuditPending` event containing `escrowId`, `creator`, `recipient`, `executionTraceHash`, and `amount`
2. Agent signs the message `DJZS-AUDIT:{escrowId}:{keccak256(strategy_memo)}` with the recipient wallet
3. Agent calls `POST /api/audit/escrow` with the signature in `x-escrow-signature` header, plus `escrow_id`, `escrow_tx_hash`, and `strategy_memo` in the body
4. Oracle verifies: (a) signature proves caller is the escrow recipient, (b) escrow is not already settled, (c) `executionTraceHash` from the on-chain event matches `keccak256(strategy_memo)` — rejecting tampered memos, (d) `escrow_id` in the request matches the event's `escrowId` — preventing mismatch attacks
5. Adversarial audit runs, ProofOfLogic certificate is uploaded to Irys Datachain
6. Oracle calls `settleEscrow(escrowId, passed, irisTxId)` on-chain — releasing or freezing funds based on the verdict
7. Response includes the full certificate, Irys provenance, and `settlement_tx_hash`

---

## ProofOfLogic Certificate

Every successful audit returns a deterministic JSON certificate. The verdict is binary — `PASS` or `FAIL`. No probabilistic hedging.

```json
{
  "audit_id": "219a7394-0132-4e02-b2cf-00dfdb28a0ec",
  "timestamp": "2026-03-03T22:33:20.601Z",
  "tier": "micro",
  "verdict": "FAIL",
  "risk_score": 90,
  "primary_flaw": "DJZS-X01",
  "summary": "The strategy fails due to critical logic and risk management flaws, including circular logic, authority substitution, and lack of risk bounds.",
  "flags": [
    {
      "code": "DJZS-S01",
      "severity": "CRITICAL",
      "evidence": "The conclusion that ETH will keep going up is based on the premise that it has been going up for 3 days, which is a circular logic.",
      "recommendation": "Consider multiple factors and historical data to support the conclusion."
    },
    {
      "code": "DJZS-X01",
      "severity": "CRITICAL",
      "evidence": "No stop loss is defined, which means there are no risk bounds.",
      "recommendation": "Define a stop loss and consider position sizing to manage risk."
    }
  ],
  "should_abort": true,
  "abort_reasons": [
    "DJZS-S01 (CRITICAL): The conclusion that ETH will keep going up is based on the premise that it has been going up for 3 days.",
    "DJZS-X01 (CRITICAL): No stop loss is defined, which means there are no risk bounds."
  ],
  "cryptographic_hash": "3afb941dabed235a39fcdcaf862153dd6593dfdae6d62f4e1b3b8f55e9e202f8",
  "keccak256_hash": "0xe10053b20f9bf900329f372951d9d45a9b3e7f8584fb5493fd61549564e3676d",
  "provenance_provider": "IRYS_DATACHAIN",
  "irys_tx_id": "71oNMzL4hgLoXo7SNEsgPSJ8oCETs15jKwioke3V2rSH",
  "irys_url": "https://gateway.irys.xyz/71oNMzL4hgLoXo7SNEsgPSJ8oCETs15jKwioke3V2rSH"
}
```

The `irys_url` is permanent and public — no API key, no auth, no expiration. Anyone can verify the AI's reasoning by visiting the gateway URL directly.

Escrow audit responses additionally include `settlement_tx_hash`, `escrow_id`, `escrow_creator`, and `escrow_recipient`.

### Key Fields

| Field | Description |
|---|---|
| `verdict` | `PASS` or `FAIL` — deterministic, binary |
| `risk_score` | 0–100 (0 = flawless logic, 100 = critically compromised) |
| `primary_flaw` | The dominant DJZS-LF failure code, or `"None"` |
| `summary` | One-sentence natural language summary of the audit result |
| `flags` | Array of DJZS-LF failure codes with `severity`, `evidence`, and `recommendation` |
| `should_abort` | Boolean — `true` if the agent should halt execution |
| `abort_reasons` | Array of human-readable abort trigger descriptions |
| `cryptographic_hash` | SHA-256 of the input strategy memo — tamper detection |
| `keccak256_hash` | Keccak-256 of the strategy memo — for on-chain verification |
| `irys_tx_id` | Permanent Irys receipt — the immutable audit record |
| `irys_url` | Direct public gateway link to the certificate |
| `settlement_tx_hash` | (Escrow only) Base Mainnet TX hash of the `settleEscrow` call |

---

## DJZS-LF Failure Code Taxonomy

All detected reasoning flaws are mapped to strict, machine-parseable codes. **Autonomous agents should halt execution on `CRITICAL` or `HIGH` severity flags.**

| Code | Category | Name | Severity | Auto-Abort | Risk Points |
|---|---|---|---|---|---|
| `DJZS-S01` | Structural | CIRCULAR_LOGIC | Critical | Yes | 30 |
| `DJZS-S02` | Structural | MISSING_FALSIFIABILITY | Critical | Yes | 25 |
| `DJZS-E01` | Epistemic | CONFIRMATION_TUNNEL | High | Yes | 20 |
| `DJZS-E02` | Epistemic | AUTHORITY_SUBSTITUTION | High | Yes | 20 |
| `DJZS-I01` | Incentive | MISALIGNED_INCENTIVE | Medium | No (Review) | 15 |
| `DJZS-I02` | Incentive | NARRATIVE_DEPENDENCY | Medium | No (Review) | 15 |
| `DJZS-X01` | Execution | UNHEDGED_EXECUTION | Critical | Yes | 25 |
| `DJZS-X02` | Execution | DATA_DEPENDENCY | High | Yes | 15 |
| `DJZS-X03` | Execution | COMPLEXITY_EXCESS | Medium | No (Review) | 10 |
| `DJZS-T01` | Temporal | TEMPORAL_ASSUMPTION | High | Yes | 15 |
| `DJZS-T02` | Temporal | REGIME_BLINDNESS | Medium | No (Review) | 15 |

---

## Verification (Free & Public)


Verify any ProofOfLogic certificate by Irys transaction ID — no payment required:

```bash
GET /api/audit/verify/:txId
```

```bash
curl https://YOUR_ORACLE_URL/api/audit/verify/71oNMzL4hgLoXo7SNEsgPSJ8oCETs15jKwioke3V2rSH
```

Returns:
```json
{
  "verified": true,
  "provenance_provider": "IRYS_DATACHAIN",
  "irys_tx_id": "71oNMzL4hgLoXo7SNEsgPSJ8oCETs15jKwioke3V2rSH",
  "irys_url": "https://gateway.irys.xyz/71oNMzL4hgLoXo7SNEsgPSJ8oCETs15jKwioke3V2rSH",
  "certificate": {
    "audit_id": "fe1f14d0-73ac-4467-ac33-d76bf3fdce21",
    "timestamp": "2026-02-25T00:58:33.760Z",
    "tier": "micro",
    "verdict": "PASS",
    "risk_score": 0
  }
}
```

---

## Discovery Endpoints

| Endpoint | Description |
|---|---|
| `GET /.well-known/agent.json` | A2A agent discovery manifest — machine-readable service description |
| `GET /api/audit/schema` | Full API schema with pricing, field definitions, and integration details |
| `GET /api/audit/logs` | Paginated audit history |
| `GET /api/audit/verify/:txId` | Public certificate verification via Irys Datachain |
| `POST /api/audit/escrow` | Escrow-funded audit with on-chain hash verification + settlement callback |

---

## Irys Datachain & GraphQL Discoverability

Every upload includes metadata tags. Query the [Irys GraphQL endpoint](https://uploader.irys.xyz/graphql) to find all audits for a specific project:

```graphql
query {
  transactions(
    tags: [
      { name: "Protocol", values: ["ProofOfLogic"] },
      { name: "Target-System", values: ["MyDAOProject"] }
    ]
  ) {
    edges {
      node {
        id
        tags { name value }
      }
    }
  }
}
```

### Tags

| Tag | Value | Purpose |
|---|---|---|
| `Protocol` | `ProofOfLogic` | Identifies DJZS protocol certificates |
| `application-id` | `DJZS-Oracle` | Application identifier |
| `Target-System` | Project name or `Unknown` | Enables per-project search |
| `audit-id` | UUID | Unique audit identifier |
| `tier` | `micro` / `founder` / `treasury` | Audit tier |
| `verdict` | `PASS` / `FAIL` | Audit result |

---

## x402 Audit Console

The `/chat` page is a wallet-gated audit interface for running paid audits against the real x402 endpoints:

| Feature | Description |
|---|---|
| Tier Selection | Micro ($0.10), Founder ($1.00), Treasury ($10.00) USDC on Base Mainnet |
| Wallet Gate | Requires RainbowKit wallet connection; Run button disabled when disconnected |
| Pipeline Visualization | Real-time status: signature → hash check → auditing → Irys upload → settlement |
| ProofOfLogic Certificate | Risk score gauge, DJZS-LF failure codes, Irys certificate link, BaseScan TX link |

BYOK: bring your own Venice API key for full control over AI billing. The Live Demo (`/demo`) provides a free, rate-limited preview with preloaded scenarios.

---

## Frontend Design: Terminal Brutalism

The landing page follows a **Terminal Brutalism** aesthetic — monospace-first (`JetBrains Mono`), black backgrounds (`#0a0a0a`), green-400 accents (`#4ade80`), and scan-line overlays. Every section opens with a `//` comment-style header reminiscent of a system boot log.

| Element | Implementation |
|---|---|
| Boot Sequence | Animated 8-line terminal startup on page load |
| LF Taxonomy | Interactive accordion displaying all 11 DJZS-LF codes with severity badges and auto-abort indicators |
| Interactive Demo | Three preloaded scenarios (FOMO, Hallucinated Data, Valid Strategy) with scanning animation and hard FAIL/PASS verdicts |
| Pricing | Micro ($0.10), Founder ($1.00), Treasury ($10.00) — x402 USDC on Base Mainnet |
| Certificates | Sample ProofOfLogic JSON block with Irys Datachain provenance link |
| Wallet | RainbowKit `ConnectButton.Custom` integration preserved across all pages |

---

## ProofOfLogic NFT (ERC-721)

When an audit verdict is **PASS**, an ERC-721 NFT is minted on Base Mainnet containing the full ProofOfLogic certificate stored on-chain — not a pointer, the actual data. The NFT includes an on-chain SVG rendered in Terminal Brutalism style.

| Tier | Mint Behavior |
|---|---|
| Founder / Treasury | Auto-minted after audit. Treasury wallet pays gas. `nft_tx_hash` returned in API response. |
| Micro | `nft_mint_available: true` in API response. User triggers mint via `POST /api/audit/mint-nft`. Treasury pays gas. |
| FAIL verdict | No NFT minted. |

**Contract:** `DJZSProofOfLogicNFT` (`DJZS-POL`) — `contracts/DJZSProofOfLogicNFT.sol`

**Deploy:**
```bash
npx hardhat run scripts/deploy-proof-of-logic.cjs --network base
```

**On-Chain Data:**
- `tokenURI()` returns `data:application/json;base64,...` with full ERC-721 metadata, on-chain SVG image, and the raw certificate JSON in the `certificate` attribute
- `getRawCertificate(tokenId)` returns the certificate JSON directly
- `getTokenByIrys(irysTxId)` returns the token ID for a given Irys transaction

**Env Var:** `NFT_CONTRACT_ADDRESS` — set after deployment

---

## Security Design

- **TEE Isolation** — Oracle runs inside a Phala Cloud CVM (Intel SGX). Private keys for Venice AI, Irys wallet, and x402 are managed in hardware — inaccessible to the host operator
- **Replay Protection** — Each payment TX hash is single-use
- **On-Chain Verification** — USDC payments verified directly against Base Mainnet via viem
- **Immutable Provenance** — Irys certificates cannot be altered or deleted after upload
- **Minimal Client State** — No client-side document store; all ProofOfLogic certificates persisted permanently on Irys Datachain
- **No Hardcoded Secrets** — All sensitive values loaded from environment variables inside the TEE enclave

---

## Key Components

| Component | File | Purpose |
|---|---|---|
| Audit Engine | `server/audit-agent.ts` | Venice AI adversarial logic analysis with DJZS-LF taxonomy |
| Irys Service | `server/irys.ts` | Permanent certificate upload with metadata tags |
| Payment Verifier | `server/payment-verifier.ts` | On-chain USDC verification via viem on Base Mainnet |
| OpenClaw Runner | `server/openclaw.ts` | Unified AI agent dispatcher (JournalInsight, AdversarialOracle) |
| XMTP Agent | `server/agent.ts` | A2A encrypted listener — routes `Thinking:` / `Journal:` via XMTP MLS |
| Venice AI Client | `server/venice.ts` | Privacy-first AI processing via Venice API |
| Storage Layer | `server/storage.ts` | PostgreSQL persistence via Drizzle ORM |
| Audit Schema | `shared/audit-schema.ts` | Tier config, DJZS-LF failure codes, Zod validation |
| NFT Minter | `server/nftMinter.ts` | ProofOfLogic ERC-721 minting — full certificate stored on-chain |
| NFT Contract | `contracts/DJZSProofOfLogicNFT.sol` | On-chain SVG + certificate data, PASS-only, Base Mainnet |
| Agent Discovery | `server/routes.ts` | `/.well-known/agent.json` A2A manifest |

---

## Full Tech Stack

| Layer | Technology |
|---|---|
| Compute | Phala Network TEE (Intel SGX) |
| Intelligence | Venice AI (llama-3.3-70b, uncensored) |
| Provenance | Irys Datachain |
| Settlement | USDC on Base Mainnet, x402 protocol |
| Messaging | XMTP (MLS protocol, quantum-resistant) |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS — Terminal Brutalism design (JetBrains Mono, green-400 accents on black) |
| Backend | Express.js, TypeScript |
| Database | PostgreSQL, Drizzle ORM |
| Wallet | RainbowKit, wagmi, viem |
| Local Storage | Browser localStorage (BYOK keys) |
| Validation | Zod |

---

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Base Mainnet wallet with USDC (for testing payments)
  
- Ethereum wallet with ETH on Base (for Irys upload fees)

 ```bash
git clone https://github.com/UsernameDAOEth/djzs-AI.git
cd djzs-AI
npm install
  ```
  
  Set environment variables, then:
 
 ```bash
npm run db:push   # Push schema to database
npm run dev       # Start development server (API only)
npm start         # Production: boots API + XMTP Agent via concurrently
 ```

### Environment Variables

**Required:**

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `TREASURY_WALLET_ADDRESS` | Base Mainnet wallet for receiving USDC |
| `VENICE_API_KEY` | Venice AI API key |
| `BASE_RPC_URL` | Base Mainnet RPC endpoint |
| `IRYS_PRIVATE_KEY` | Ethereum wallet private key for Irys uploads (needs ETH on Base) |

**Optional:**

| Variable | Description |
|---|---|
| `CDP_API_KEY_ID` | Coinbase Developer Platform key ID (enables x402) |
| `CDP_API_KEY_SECRET` | Coinbase Developer Platform secret |
| `X402_NETWORK` | x402 network (default: `eip155:8453`) |
| `VENICE_MODEL` | Venice model (default: `llama-3.3-70b`) |
| `VENICE_BASE_URL` | Venice API base URL (default: `https://api.venice.ai/api/v1`) |
| `XMTP_WALLET_KEY` | 0x-prefixed hex private key for XMTP Oracle identity |
| `XMTP_ENV` | XMTP environment: `dev` or `production` |
| `ESCROW_CONTRACT_ADDRESS` | Deployed DJZS Escrow Contract address on Base Mainnet |
| `SETTLEMENT_PRIVATE_KEY` | 0x-prefixed hex private key for the settlement wallet (signs `settleEscrow` transactions) |
| `NFT_CONTRACT_ADDRESS` | Deployed DJZSProofOfLogicNFT contract address on Base Mainnet — enables PASS-only NFT minting |

---

## Deployment

### Docker
```bash
docker build -t djzs-ai .
docker run -p 5000:5000 --env-file .env djzs-ai
```

### Phala Cloud TEE (Recommended)

1. Build and push Docker image to DockerHub: `djzs/djzs-ai:latest`
2. Provision a CVM on Phala Cloud with environment variables injected at runtime
3. `npm start` boots Express REST API + XMTP Agent simultaneously via `concurrently` — required for Phala's single-entrypoint constraint
4. All private keys are managed inside the SGX enclave — never touch disk, inaccessible to the host operator

Current deployment: `dstack-pha-prod5.phala.network`

### CI/CD

Automated Docker builds via GitHub Actions (`.github/workflows/docker-publish.yml`) on push to `main`. Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` to your repository secrets.

---

## On-Chain Artifacts

### Synthesis Hackathon

| Artifact | Link |
|---|---|
| Registration TX (ERC-8004) | [`0x99b9fcfc...`](https://basescan.org/tx/0x99b9fcfc64af207771afde1851fa7e569e5161d5bb166dbd000b44743bd1ce23) |
| Phala TEE Deployment | [dstack-pha-prod5.phala.network](https://d7255cce710465c7e67fd27a4688e9d9f5296179-5000.dstack-pha-prod5.phala.network) |

### Solidity Contracts (Base Mainnet)

| Contract | Address | Purpose |
|---|---|---|
| `DJZSLogicTrustScore` | [`0xB3324D07A8713b354435FF0e2A982A504e81b137`](https://basescan.org/address/0xB3324D07A8713b354435FF0e2A982A504e81b137) | On-chain trust score registry |
| `DJZSEscrowLock` | [`0xB041760147a60F63Ca701da9e431412bCc25Cfb7`](https://basescan.org/address/0xB041760147a60F63Ca701da9e431412bCc25Cfb7) | USDC escrow with audit-gated settlement |
| `DJZSStaking` | [`0xA362947D23D52C05a431E378F30C8A962De91e8A`](https://basescan.org/address/0xA362947D23D52C05a431E378F30C8A962De91e8A) | Agent staking with slashing |
| `DJZSAgentRegistry` | [`0xe40d5669Ce8e06A91188B82Ce7292175E2013E41`](https://basescan.org/address/0xe40d5669Ce8e06A91188B82Ce7292175E2013E41) | On-chain agent registry |

> **Note:** Contract source code is in `contracts/`. See [CONTRACTS.md](./CONTRACTS.md) for full interface reference.

### Irys Datachain Certificates

Every audit produces a permanent ProofOfLogic certificate on Irys. Sample certificates from integration testing:

| Test Case | Verdict | Risk Score | Irys Certificate |
|---|---|---|---|
| FOMO leveraged trade (no risk bounds) | FAIL | 95 | [G8TNstxk...](https://gateway.irys.xyz/G8TNstxkpWVX6zMj9Qizz5Mzj6rajHSSp2csvm3gEKDR) |
| Circular logic with authority substitution | FAIL | 85 | [Hpzv4qEK...](https://gateway.irys.xyz/Hpzv4qEKn7hDrNzyxEByFMbZy25kqvxVwmuCpV4b47Hn) |
| Borderline strategy (edge case) | FAIL | 65 | [8Mjfz7dk...](https://gateway.irys.xyz/8Mjfz7dkWskpWPSpCJTxyXb2SnJGwpTDkAeDAncRcnY8) |
| DCA strategy with risk bounds | FAIL | 65 | [BcwhJEV7...](https://gateway.irys.xyz/BcwhJEV7XfeFz1MARQkmbEnGpwf9uTCuybP1dwVnGYw1) |
| Conservative treasury rebalance | FAIL | 65 | [2SPDEfFd...](https://gateway.irys.xyz/2SPDEfFdXUQNLNMsEkvBZ8J5A4njazEj6LnNZ546Ckok) |

All certificates are permanent, public, and require no authentication to verify: click any Irys link above.

---

## How to Run the Demo

### 1. Quick Audit (cURL)

```bash
curl -X POST https://d7255cce710465c7e67fd27a4688e9d9f5296179-5000.dstack-pha-prod5.phala.network/api/audit/micro \
  -H "Content-Type: application/json" \
  -H "x-payment-proof: 0xYOUR_BASE_MAINNET_TX_HASH" \
  -d '{
    "strategy_memo": "Your agent reasoning trace here (min 20 chars)",
    "audit_type": "treasury",
    "target_system": "YourProject"
  }'
```

### 2. CLI Tool

```bash
cd djzs-AI
npx djzs health                          # Check Oracle status
npx djzs init                            # Generate wallet + config
npx djzs audit "Your strategy memo"      # Run adversarial audit
```

### 3. x402 Audit Console (Web UI)

Visit [djzs.ai/chat](https://djzs.ai/chat) for wallet-gated paid audits, or [djzs.ai/demo](https://djzs.ai/demo) for a free rate-limited preview:
- **Tier Selection** — Micro ($0.10), Founder ($1.00), Treasury ($10.00) USDC on Base
- **Pipeline Visualization** — Real-time audit progress with Irys + BaseScan links
- **ProofOfLogic Certificate** — Risk score, DJZS-LF failure codes, permanent Irys provenance

### 4. Verify Any Certificate

```bash
curl https://d7255cce710465c7e67fd27a4688e9d9f5296179-5000.dstack-pha-prod5.phala.network/api/audit/verify/G8TNstxkpWVX6zMj9Qizz5Mzj6rajHSSp2csvm3gEKDR
```

Or visit the Irys gateway directly: `https://gateway.irys.xyz/<IRYS_TX_ID>`

---

## Hackathon Submission

- **Event:** The Synthesis (synthesis.md)
- **Tracks:** Agents that Trust, Agents that Cooperate, Agents that Pay
- **Participant ID:** `1edf7b02720e4cda9596470328e7bd92`
- **Team ID:** `13b341fbe3684cfda9a56b510ec2e15f`
- **Conversation Log:** [CONVERSATION_LOG.md](./CONVERSATION_LOG.md)
- **Demo Script:** [DEMO_SCRIPT.md](./DEMO_SCRIPT.md)

---

## License

See [LICENSE](./LICENSE) for details.

---

<p align="center">
  <strong>No agent acts without audit.</strong><br>
  <em>DJZS Protocol — The Immutable Mind</em>
</p>
