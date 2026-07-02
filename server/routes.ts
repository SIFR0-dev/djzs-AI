import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertMemberSchema, insertRoomSchema, insertStoredMessageSchema, insertJournalEntrySchema } from "@shared/schema";
import { z } from "zod";
import { analyzeJournalEntry } from "./venice";
import { analyzeWithAgent, agentInputSchema } from "./agent.api";
import { runAgent, journalInsightPayloadSchema, adversarialOraclePayloadSchema, type AgentName } from "./openclaw";
let _cachedGitHubImport: any = null;
async function getGitHubClient() {
  if (!process.env.REPLIT_CONNECTORS_HOSTNAME) return null;
  if (!_cachedGitHubImport) {
    _cachedGitHubImport = await import("./github");
  }
  return _cachedGitHubImport.getUncachableGitHubClient();
}
import { auditRequestSchema, createTieredRequestSchema, TIER_CONFIG, type AuditTier, escrowAuditRequestSchema } from "@shared/audit-schema";
import { executeAudit, mapToLegacyAuditLog, postAuditChainWrite } from "./audit-agent";
import { intelligenceRequestSchema, generateServerIntelligenceBrief } from "./intelligence-engine";
import { verifyUsdcPayment } from "./payment-verifier";
import { uploadAuditToIrys } from "./irys";
import { requireEscrowSignature } from "./signature-verifier";
import { evaluateEscrowGate } from "./escrowGate";
import { mintProofOfLogicNft, buildNftMintInput } from "./nftMinter";
import { extractAuditInputConsensus } from "./engine-v2/extraction-layer";
import { runDeterministicAudit } from "./engine-v2/deterministic-engine";


export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/sitemap.xml", (_req, res) => {
    res.setHeader("Content-Type", "application/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://djzs.ai/</loc>
    <lastmod>2026-02-22</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://djzs.ai/docs</loc>
    <lastmod>2026-02-22</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://djzs.ai/about</loc>
    <lastmod>2026-02-22</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`);
  });

  app.get("/.well-known/agent.json", (_req, res) => {
    res.json({
      name: "DJZS Logic Oracle",
      description: "Adversarial Logic Auditor for the A2A Economy. Deterministic reasoning-flaw detection using DJZS-LF v1.0 taxonomy.",
      url: "https://djzs.ai",
      version: "2.0",
      capabilities: {
        audit: true,
        x402_payments: true,
        irys_provenance: true,
        nft_minting: !!process.env.NFT_CONTRACT_ADDRESS,
        escrow: !!process.env.ESCROW_CONTRACT_ADDRESS,
      },
      integration_channels: {
        light: {
          protocol: "REST",
          base_url: "https://djzs.ai/api",
          payment: "x402 USDC on Base Mainnet",
          endpoints: [
            { method: "POST", path: "/api/audit/micro", price: "$0.10 USDC" },
            { method: "POST", path: "/api/audit/founder", price: "$1.00 USDC" },
            { method: "POST", path: "/api/audit/treasury", price: "$10.00 USDC" },
          ],
        },
        dark: {
          protocol: "XMTP",
          encryption: "MLS (E2E)",
          address: "0xC5Ab9496233c1e51eD21c712e8abc86a3F434fc5",
        },
      },
      schema: "/api/audit/schema",
      health: "/api/health",
    });
  });

  const startTime = Date.now();

  app.get("/api/health", (_req, res) => {
    res.json({ 
      ok: true, 
      timestamp: Date.now(), 
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      version: "2.1.0",
      service: "DJZS - Logic Oracle for the Decentralized Web",
      components: {
        api: "healthy",
        xmtp_agent: process.env.XMTP_WALLET_KEY ? "configured" : "not_configured",
        venice_ai: process.env.VENICE_API_KEY ? "configured" : "not_configured",
        irys_datachain: process.env.IRYS_PRIVATE_KEY ? "configured" : "not_configured",
        trust_score_contract: process.env.TRUST_SCORE_CONTRACT_ADDRESS ? "configured" : "not_configured",
        x402_payments: "active",
      },
      capabilities: {
        a2a_audit_api: true,
        structured_trade_params: true,
        irys_provenance: !!process.env.IRYS_PRIVATE_KEY,
        dark_channel_xmtp: !!process.env.XMTP_WALLET_KEY,
        light_channel_rest: true,
      }
    });
  });

  app.get("/api/github/status", async (_req, res) => {
    try {
      const octokit = await getGitHubClient();
      if (!octokit) {
        return res.json({ connected: false, error: "GitHub integration not available in this environment" });
      }
      const { data: user } = await octokit.users.getAuthenticated();
      res.json({
        connected: true,
        username: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
      });
    } catch (error) {
      console.error("GitHub status error:", error);
      res.status(500).json({ 
        connected: false, 
        error: error instanceof Error ? error.message : "GitHub connection failed" 
      });
    }
  });

  app.get("/api/github/repos", async (_req, res) => {
    try {
      const octokit = await getGitHubClient();
      if (!octokit) {
        return res.json([]);
      }
      const { data: repos } = await octokit.repos.listForAuthenticatedUser({
        sort: "updated",
        per_page: 20,
      });
      res.json(repos.map((r: any) => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        url: r.html_url,
        description: r.description,
        updatedAt: r.updated_at,
      })));
    } catch (error) {
      console.error("GitHub repos error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch repos" });
    }
  });

  app.post("/api/openclaw/run", async (req, res) => {
    try {
      const userVeniceKey = req.headers['x-venice-api-key'] as string | undefined;
      const { agent: agentName, payload } = req.body;

      if (!agentName || !payload) {
        return res.status(400).json({ error: "Missing 'agent' and 'payload' fields" });
      }

      const validAgents: AgentName[] = ["JournalInsight", "AdversarialOracle"];
      if (!validAgents.includes(agentName)) {
        return res.status(400).json({ error: `Unknown agent: ${agentName}. Valid: ${validAgents.join(", ")}` });
      }

      let validatedPayload;
      if (agentName === "JournalInsight") {
        validatedPayload = journalInsightPayloadSchema.parse(payload);
      } else {
        validatedPayload = adversarialOraclePayloadSchema.parse(payload);
      }

      const result = await runAgent(agentName, validatedPayload, userVeniceKey);
      res.json({ agent: agentName, result });
    } catch (error) {
      console.error("OpenClaw agent error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid payload", details: error.errors });
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : "Agent processing failed",
      });
    }
  });

  app.get("/api/members", async (_req, res) => {
    try {
      const members = await storage.getAllMembers();
      res.json(members);
    } catch (error) {
      console.error("Error fetching members:", error);
      res.status(500).json({ error: "Failed to fetch members" });
    }
  });

  app.get("/api/members/:address", async (req, res) => {
    try {
      const member = await storage.getMember(req.params.address);
      if (!member) {
        return res.status(404).json({ error: "Member not found" });
      }
      res.json(member);
    } catch (error) {
      console.error("Error fetching member:", error);
      res.status(500).json({ error: "Failed to fetch member" });
    }
  });

  app.post("/api/members", async (req, res) => {
    try {
      const validatedData = insertMemberSchema.parse(req.body);
      const member = await storage.createMember(validatedData);
      res.status(201).json(member);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid member data", details: error.errors });
      }
      if (error instanceof Error && error.message === "MEMBER_EXISTS") {
        return res.status(409).json({ error: "Member already exists" });
      }
      console.error("Error creating member:", error);
      res.status(500).json({ error: "Failed to create member" });
    }
  });

  app.patch("/api/members/:address", async (req, res) => {
    try {
      const updated = await storage.updateMember(req.params.address, req.body);
      if (!updated) {
        return res.status(404).json({ error: "Member not found" });
      }
      res.json(updated);
    } catch (error) {
      console.error("Error updating member:", error);
      res.status(500).json({ error: "Failed to update member" });
    }
  });

  app.delete("/api/members/:address", async (req, res) => {
    try {
      const deleted = await storage.deleteMember(req.params.address);
      if (!deleted) {
        return res.status(404).json({ error: "Member not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting member:", error);
      res.status(500).json({ error: "Failed to delete member" });
    }
  });

  app.get("/api/rooms", async (_req, res) => {
    try {
      const rooms = await storage.getAllRooms();
      res.json(rooms);
    } catch (error) {
      console.error("Error fetching rooms:", error);
      res.status(500).json({ error: "Failed to fetch rooms" });
    }
  });

  app.get("/api/rooms/:id", async (req, res) => {
    try {
      const room = await storage.getRoom(req.params.id);
      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }
      res.json(room);
    } catch (error) {
      console.error("Error fetching room:", error);
      res.status(500).json({ error: "Failed to fetch room" });
    }
  });

  app.post("/api/rooms", async (req, res) => {
    try {
      const validatedData = insertRoomSchema.parse(req.body);
      const room = await storage.createRoom(validatedData);
      res.status(201).json(room);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid room data", details: error.errors });
      }
      console.error("Error creating room:", error);
      res.status(500).json({ error: "Failed to create room" });
    }
  });

  app.patch("/api/rooms/:id", async (req, res) => {
    try {
      const updated = await storage.updateRoom(req.params.id, req.body);
      if (!updated) {
        return res.status(404).json({ error: "Room not found" });
      }
      res.json(updated);
    } catch (error) {
      console.error("Error updating room:", error);
      res.status(500).json({ error: "Failed to update room" });
    }
  });

  app.delete("/api/rooms/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteRoom(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Room not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting room:", error);
      res.status(500).json({ error: "Failed to delete room" });
    }
  });

  app.get("/api/messages/:roomId", async (req, res) => {
    try {
      const messages = await storage.getMessagesByRoom(req.params.roomId);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  app.post("/api/messages", async (req, res) => {
    try {
      const validatedData = insertStoredMessageSchema.parse(req.body);
      
      const msg = validatedData.message as Record<string, any> | null;
      const authorAddress = msg
        ? (msg.authorAddress ?? msg.voterAddress ?? null)
        : null;
      
      if (!authorAddress) {
        return res.status(400).json({ error: "Message must include author address" });
      }
      
      const member = await storage.getMember(authorAddress);
      if (!member) {
        return res.status(403).json({ error: "Not a registered member" });
      }
      if (!member.isAllowlisted && !member.isAdmin) {
        return res.status(403).json({ error: "Not on allowlist" });
      }
      if (member.isMuted) {
        return res.status(403).json({ error: "You are muted and cannot send messages" });
      }
      
      const message = await storage.createMessage(validatedData);
      res.status(201).json(message);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid message data", details: error.errors });
      }
      console.error("Error creating message:", error);
      res.status(500).json({ error: "Failed to create message" });
    }
  });

  app.post("/api/journal/analyze", async (req, res) => {
    try {
      const userVeniceKey = req.headers['x-venice-api-key'] as string | undefined;
      const { content, walletAddress, zone = "journal" } = req.body;
      
      if (!content || !walletAddress) {
        return res.status(400).json({ error: "content and walletAddress required" });
      }
      
      if (typeof content !== "string" || content.length < 10) {
        return res.status(400).json({ error: "Entry must be at least 10 characters" });
      }
      
      const entry = await storage.createJournalEntry({ content, walletAddress });
      const recentEntries = await storage.getRecentJournalEntries(walletAddress, 3);
      const contextEntries = recentEntries.filter(e => e.id !== entry.id);
      const analysis = await analyzeJournalEntry(content, contextEntries, userVeniceKey);
      res.json({
        entry,
        analysis,
        zone,
      });
    } catch (error) {
      console.error("Error analyzing journal entry:", error);
      if (error instanceof Error && error.message.includes("VENICE_API_KEY")) {
        return res.status(503).json({ error: "AI service not configured" });
      }
      res.status(500).json({ error: "Failed to analyze journal entry" });
    }
  });

  app.get("/api/journal/entries/:walletAddress", async (req, res) => {
    try {
      const entries = await storage.getRecentJournalEntries(req.params.walletAddress, 20);
      res.json(entries);
    } catch (error) {
      console.error("Error fetching journal entries:", error);
      res.status(500).json({ error: "Failed to fetch entries" });
    }
  });

  app.post("/api/agent/analyze", async (req, res) => {
    try {
      const userVeniceKey = req.headers['x-venice-api-key'] as string | undefined;
      const input = agentInputSchema.parse(req.body);
      const result = await analyzeWithAgent(input, userVeniceKey);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      console.error("Error in agent analyze:", error);
      if (error instanceof Error && error.message.includes("VENICE_API_KEY")) {
        return res.status(503).json({ error: "AI service not configured" });
      }
      res.status(500).json({ error: "Failed to analyze entry" });
    }
  });

  const COINGECKO_IDS: Record<string, string> = {
    btc: "bitcoin", bitcoin: "bitcoin",
    eth: "ethereum", ethereum: "ethereum",
    sol: "solana", solana: "solana",
    bnb: "binancecoin",
    xrp: "ripple",
    ada: "cardano",
    doge: "dogecoin",
    dot: "polkadot",
    avax: "avalanche-2",
    matic: "matic-network", polygon: "matic-network",
    link: "chainlink",
    uni: "uniswap",
    atom: "cosmos",
    arb: "arbitrum",
    op: "optimism",
    sui: "sui",
    apt: "aptos",
    near: "near",
    ftm: "fantom",
    sei: "sei-network",
    inj: "injective-protocol",
    tia: "celestia",
    jup: "jupiter-exchange-solana",
    render: "render-token",
    pepe: "pepe",
    wif: "dogwifcoin",
    bonk: "bonk",
  };

  app.get("/api/market/price/:asset", async (req, res) => {
    try {
      const raw = req.params.asset.toLowerCase().trim();
      const coinId = COINGECKO_IDS[raw] || raw;
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_24hr_change=true`
      );
      if (!response.ok) {
        return res.status(502).json({ error: "Failed to fetch price from CoinGecko" });
      }
      const data = await response.json();
      const entry = data[coinId];
      if (!entry) {
        return res.status(404).json({ error: `Asset "${raw}" not found on CoinGecko` });
      }
      res.json({
        asset: raw,
        coinId,
        priceUsd: entry.usd,
        change24h: entry.usd_24h_change ?? null,
      });
    } catch (error) {
      console.error("Market price fetch error:", error);
      res.status(500).json({ error: "Failed to fetch market price" });
    }
  });

  app.get("/api/market/sentiment", async (_req, res) => {
    try {
      const response = await fetch("https://api.alternative.me/fng/?limit=1");
      if (!response.ok) {
        return res.status(502).json({ error: "Failed to fetch Fear & Greed Index" });
      }
      const data = await response.json();
      const entry = data?.data?.[0];
      if (!entry) {
        return res.status(502).json({ error: "No sentiment data available" });
      }
      const score = parseInt(entry.value, 10);
      let label: "FEAR" | "NEUTRAL" | "GREED";
      if (score <= 35) label = "FEAR";
      else if (score <= 65) label = "NEUTRAL";
      else label = "GREED";
      res.json({
        score,
        label,
        classification: entry.value_classification,
        timestamp: entry.timestamp,
      });
    } catch (error) {
      console.error("Sentiment fetch error:", error);
      res.status(500).json({ error: "Failed to fetch market sentiment" });
    }
  });

  app.post("/api/market/batch-price", async (req, res) => {
    try {
      const { assets } = req.body;
      if (!Array.isArray(assets) || assets.length === 0) {
        return res.status(400).json({ error: "assets array required" });
      }
      const coinIds = assets.map((a: string) => {
        const lower = a.toLowerCase().trim();
        return COINGECKO_IDS[lower] || lower;
      });
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds.join(",")}&vs_currencies=usd&include_24hr_change=true`
      );
      if (!response.ok) {
        return res.status(502).json({ error: "Failed to fetch prices from CoinGecko" });
      }
      const data = await response.json();
      const results: Record<string, { priceUsd: number; change24h: number | null }> = {};
      assets.forEach((a: string, i: number) => {
        const entry = data[coinIds[i]];
        if (entry) {
          results[a.toUpperCase()] = { priceUsd: entry.usd, change24h: entry.usd_24h_change ?? null };
        }
      });
      res.json(results);
    } catch (error) {
      console.error("Batch price fetch error:", error);
      res.status(500).json({ error: "Failed to fetch batch prices" });
    }
  });

  const TREASURY_WALLET = process.env.TREASURY_WALLET_ADDRESS;
  if (!TREASURY_WALLET) {
    console.warn("TREASURY_WALLET_ADDRESS not set — payment verification will reject all transactions");
  }

  const X402_NETWORK = (process.env.X402_NETWORK || "eip155:8453") as `${string}:${string}`;
  let x402Initialized = false;

  const hasCdpKeys = !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);

  const AUDIT_ROUTE_PREFIXES = ["/api/audit/micro", "/api/audit/founder", "/api/audit/treasury", "/api/audit"];
  const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
  app.use((req: any, _res: any, next: any) => {
    if (
      req.method === "POST" &&
      AUDIT_ROUTE_PREFIXES.some(p => req.path === p) &&
      req.headers["x-payment-proof"]
    ) {
      const proof = String(req.headers["x-payment-proof"]);
      if (TX_HASH_RE.test(proof)) {
        req.directPaymentProof = proof;
        console.log(`[payment] Direct USDC proof detected on ${req.path}: ${proof}`);
      }
    }
    next();
  });

  if (hasCdpKeys && TREASURY_WALLET) {
    try {
      const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
      const { ExactEvmScheme } = await import("@x402/evm/exact/server");
      const { HTTPFacilitatorClient } = await import("@x402/core/server");
      const { facilitator } = await import("@coinbase/x402");

      const facilitatorClient = new HTTPFacilitatorClient(facilitator);

      const resourceServer = new x402ResourceServer(facilitatorClient)
        .register(X402_NETWORK, new ExactEvmScheme());

      const x402Mw = paymentMiddleware(
        {
          "POST /api/audit/micro": {
            accepts: {
              scheme: "exact",
              price: "$0.10",
              network: X402_NETWORK,
              payTo: TREASURY_WALLET,
            },
            description: "DJZS Micro-Zone: High-frequency operational ledger and sanity check",
          },
          "POST /api/audit/founder": {
            accepts: {
              scheme: "exact",
              price: "$1.00",
              network: X402_NETWORK,
              payTo: TREASURY_WALLET,
            },
            description: "DJZS Founder Zone: Strategic roadmap diligence and narrative drift detection",
          },
          "POST /api/audit/treasury": {
            accepts: {
              scheme: "exact",
              price: "$10.00",
              network: X402_NETWORK,
              payTo: TREASURY_WALLET,
            },
            description: "DJZS Treasury Zone: Exhaustive adversarial stress-test for capital deployment",
          },
          "POST /api/audit": {
            accepts: {
              scheme: "exact",
              price: "$0.10",
              network: X402_NETWORK,
              payTo: TREASURY_WALLET,
            },
            description: "DJZS Logic Audit (backward-compatible alias for Micro-Zone)",
          },
        },
        resourceServer,
      );

      app.use((req: any, res: any, next: any) => {
        if (req.directPaymentProof) {
          return next();
        }
        return x402Mw(req, res, next);
      });

      x402Initialized = true;
      console.log(`x402 payment middleware initialized for 3 Zone tiers on Base Mainnet via Coinbase CDP`);
      console.log(`  Micro-Zone:    POST /api/audit/micro    ($0.10 USDC)`);
      console.log(`  Founder Zone:  POST /api/audit/founder  ($1.00 USDC)`);
      console.log(`  Treasury Zone: POST /api/audit/treasury ($10.00 USDC)`);
      console.log(`  Direct USDC proof (x-payment-proof header) also accepted`);
    } catch (error) {
      console.warn("x402 middleware not initialized (non-blocking):", error instanceof Error ? error.message : error);
      console.warn("Audit endpoint will operate without payment gate");
    }
  } else {
    if (process.env.NODE_ENV === "production") {
      console.error("CRITICAL: CDP_API_KEY_ID and CDP_API_KEY_SECRET required in production — audit endpoint is unprotected!");
    }
    console.warn("CDP_API_KEY_ID and CDP_API_KEY_SECRET not set — x402 payment gate disabled");
    console.warn("Get your keys at https://portal.cdp.coinbase.com/projects");
  }

  const x402PaymentGate = (req: any, res: any, next: any) => {
    if (x402Initialized && !req.directPaymentProof) return next();

    const paymentProof = req.headers['x-payment-proof'];

    if (!paymentProof) {
      return res.status(402).json({
        error: "Payment Required. Provide Base Mainnet TX hash in 'x-payment-proof' header.",
        code: "DJZS-AUTH-402",
      });
    }

    req.paymentProof = paymentProof;
    next();
  };

  const createVerifiedPaymentGate = (tier: AuditTier) => async (req: any, res: any, next: any) => {
    const txHash = req.headers['x-payment-proof'] as string | undefined;

    if (x402Initialized && !txHash) {
      console.log(`[payment] x402 protocol verified payment for ${TIER_CONFIG[tier].name}`);
      return next();
    }

    if (x402Initialized && txHash) {
      console.log(`[payment] Direct USDC proof bypassing x402 for ${TIER_CONFIG[tier].name}: ${txHash}`);
    }

    if (!TREASURY_WALLET) {
      return res.status(503).json({
        error: "Payment verification not configured. TREASURY_WALLET_ADDRESS required.",
        code: "DJZS-AUTH-CONFIG",
      });
    }

    if (!txHash) {
      return res.status(402).json({
        error: "Payment Required. Provide Base Mainnet TX hash in 'x-payment-proof' header.",
        code: "DJZS-AUTH-402",
        tier: TIER_CONFIG[tier].name,
        price: TIER_CONFIG[tier].price,
      });
    }

    const existing = await storage.getPaymentReceiptByTxHash(txHash);
    if (existing) {
      return res.status(409).json({
        error: "Transaction hash already used for a previous audit.",
        code: "DJZS-AUTH-REPLAY",
      });
    }

    try {
      const result = await verifyUsdcPayment(txHash, tier, TREASURY_WALLET);

      if (!result.verified) {
        return res.status(402).json({
          error: result.error,
          code: "DJZS-AUTH-INVALID",
          tier: TIER_CONFIG[tier].name,
          expected_price: TIER_CONFIG[tier].price,
        });
      }

      await storage.createPaymentReceipt({
        chainId: 8453,
        tokenSymbol: "USDC",
        amount: result.amount || TIER_CONFIG[tier].price,
        fromAddress: result.from || "unknown",
        toAddress: result.to || TREASURY_WALLET,
        txHash,
        roomId: null,
        note: `${TIER_CONFIG[tier].name} audit payment`,
      });

      req.paymentProof = txHash;
      req.paymentVerified = true;
      next();
    } catch (error) {
      console.error("Payment verification error:", error);
      return res.status(500).json({
        error: "Payment verification failed. Please try again.",
        code: "DJZS-AUTH-ERROR",
      });
    }
  };

  const createTierHandler = (tier: AuditTier) => async (req: any, res: any) => {
    try {
      const userVeniceKey = req.headers['x-venice-api-key'] as string | undefined;
      const walletAddress = req.headers['x-wallet-address'] as string | undefined;
      const schema = createTieredRequestSchema(tier);
      const parsed = schema.safeParse(req.body);

      if (!parsed.success) {
        const config = TIER_CONFIG[tier];
        return res.status(400).json({
          error: "Invalid audit request",
          zone: config.name,
          details: parsed.error.errors,
          expected: {
            strategy_memo: `string (min 20 chars${config.maxMemoLength !== Infinity ? `, max ${config.maxMemoLength} chars` : ""})`,
            audit_type: "treasury | founder_drift | strategy | general (default: general)",
          },
        });
      }

      const audit = await executeAudit({
        strategy_memo: parsed.data.strategy_memo,
        audit_type: parsed.data.audit_type || "general",
        tier,
        intelligence_context: parsed.data.intelligence_context,
        trade_params: parsed.data.trade_params,
        agent_id: parsed.data.agent_id,
      });

      const irysPayload: Record<string, any> = {
        ...audit,
        audit_type: parsed.data.audit_type || "general",
        ...(parsed.data.agent_id && { agent_id: parsed.data.agent_id }),
        ...(parsed.data.trade_params && { trade_params: parsed.data.trade_params }),
      };
      const irysResult = await uploadAuditToIrys(irysPayload);

      const agentAddr = parsed.data.agent_id || walletAddress;
      const trustScoreResult = await postAuditChainWrite(audit, agentAddr, irysResult.irys_tx_id);

      try {
        const legacyLog = mapToLegacyAuditLog(audit, {
          strategyMemo: parsed.data.strategy_memo,
          auditType: parsed.data.audit_type || "general",
          walletAddress: walletAddress || null,
          irysTxId: irysResult.irys_tx_id,
        });
        await storage.createAuditLog({ ...legacyLog, strategyMemo: legacyLog.strategyMemo || parsed.data.strategy_memo });
      } catch (dbError) {
        console.error("Failed to persist audit log:", dbError);
      }

      // ─── ProofOfLogic NFT mint (PASS verdicts only) ───────────────
      let nftResult: { nft_tx_hash: string | null; nft_token_id: number | null; nft_error?: string } | null = null;
      if (
        audit.verdict === "PASS" &&
        process.env.NFT_CONTRACT_ADDRESS &&
        irysResult.irys_tx_id
      ) {
        const mintRecipient = walletAddress || agentAddr;
        if (mintRecipient && (tier === "founder" || tier === "treasury")) {
          // Auto-mint for Founder/Treasury — full certificate stored on-chain
          const mintInput = buildNftMintInput(
            audit,
            { irys_tx_id: irysResult.irys_tx_id, irys_url: irysResult.irys_url || `https://gateway.irys.xyz/${irysResult.irys_tx_id}` },
            tier,
            mintRecipient
          );
          nftResult = await mintProofOfLogicNft(mintInput);
        }
        // Micro tier: mint available via POST /api/audit/mint-nft
      }

      const response: Record<string, any> = {
        ...audit,
        provenance_provider: "IRYS_DATACHAIN",
        irys_tx_id: irysResult.irys_tx_id,
        irys_url: irysResult.irys_url,
        ...(trustScoreResult.trust_score_tx_hash && { trust_score_tx_hash: trustScoreResult.trust_score_tx_hash }),
        ...(trustScoreResult.trust_score_error && { trust_score_error: trustScoreResult.trust_score_error }),
      };
      if (irysResult.irys_error) {
        response.irys_error = irysResult.irys_error;
      }
      // NFT mint results
      if (nftResult?.nft_tx_hash) {
        response.nft_tx_hash = nftResult.nft_tx_hash;
        response.nft_token_id = nftResult.nft_token_id;
      }
      if (nftResult?.nft_error) {
        response.nft_error = nftResult.nft_error;
      }
      if (audit.verdict === "PASS" && tier === "micro" && process.env.NFT_CONTRACT_ADDRESS && irysResult.irys_tx_id && !nftResult) {
        response.nft_mint_available = true;
        response.nft_contract_address = process.env.NFT_CONTRACT_ADDRESS;
        const mintWallet = walletAddress || agentAddr;
        if (mintWallet && irysResult.irys_tx_id) {
          nftMintEligible.set(irysResult.irys_tx_id, { wallet: mintWallet.toLowerCase(), ts: Date.now() });
          for (const [k, v] of nftMintEligible) {
            if (Date.now() - v.ts > 3600000) nftMintEligible.delete(k);
          }
        }
      }

      res.json(response);
    } catch (error) {
      console.error(`${TIER_CONFIG[tier].name} Audit failed:`, error);
      if (error instanceof Error && error.message.includes("VENICE_API_KEY")) {
        return res.status(503).json({ error: "AI service not configured" });
      }
      res.status(500).json({
        error: "Audit execution failed",
        zone: TIER_CONFIG[tier].name,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const nftMintEligible = new Map<string, { wallet: string; ts: number }>();

  app.post("/api/audit/micro", createVerifiedPaymentGate("micro"), createTierHandler("micro"));
  app.post("/api/audit/founder", createVerifiedPaymentGate("founder"), createTierHandler("founder"));
  app.post("/api/audit/treasury", createVerifiedPaymentGate("treasury"), createTierHandler("treasury"));
  app.post("/api/audit", createVerifiedPaymentGate("micro"), createTierHandler("micro"));

  // ─── Micro-tier NFT Mint Endpoint ──────────────────────────────────
  // After a Micro PASS, the client calls this to mint the NFT.
  // Server relays the mint (treasury pays gas).
  const mintRateLimit = new Map<string, number>();
  app.post("/api/audit/mint-nft", async (req: any, res) => {
    try {
      if (!process.env.NFT_CONTRACT_ADDRESS) {
        return res.status(503).json({ error: "NFT minting not configured" });
      }

      const { irys_tx_id, wallet_address } = req.body;
      if (!irys_tx_id || !wallet_address) {
        return res.status(400).json({ error: "irys_tx_id and wallet_address required" });
      }

      if (typeof irys_tx_id !== "string" || irys_tx_id.length < 10 || irys_tx_id.length > 100) {
        return res.status(400).json({ error: "Invalid irys_tx_id format" });
      }
      if (typeof wallet_address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
        return res.status(400).json({ error: "Invalid wallet_address format" });
      }

      const rateLimitKey = `${wallet_address.toLowerCase()}`;
      const now = Date.now();
      const lastMint = mintRateLimit.get(rateLimitKey) || 0;
      if (now - lastMint < 30000) {
        return res.status(429).json({ error: "Rate limit: one mint request per 30 seconds per wallet", retry_after_ms: 30000 - (now - lastMint) });
      }
      mintRateLimit.set(rateLimitKey, now);
      for (const [key, ts] of mintRateLimit) {
        if (now - ts > 300000) mintRateLimit.delete(key);
      }

      const eligible = nftMintEligible.get(irys_tx_id);
      if (!eligible) {
        return res.status(403).json({ error: "No mint eligibility found for this certificate. Run a Micro audit with your wallet first." });
      }
      if (eligible.wallet !== wallet_address.toLowerCase()) {
        return res.status(403).json({ error: "Wallet address does not match the original audit requester" });
      }

      const irysResponse = await fetch(`https://gateway.irys.xyz/${irys_tx_id}`);
      if (!irysResponse.ok) {
        return res.status(404).json({ error: "Certificate not found on Irys Datachain" });
      }
      const certificate = await irysResponse.json();

      if (certificate.verdict !== "PASS") {
        return res.status(403).json({ error: "NFT minting is only available for PASS verdicts" });
      }

      // Check not already minted
      try {
        const { getTokenByIrys } = await import("./nftMinter");
        const existingToken = await getTokenByIrys(irys_tx_id);
        if (existingToken > 0) {
          return res.status(409).json({
            error: "NFT already minted for this certificate",
            nft_token_id: existingToken,
          });
        }
      } catch (_) {
        // getTokenByIrys may fail if contract not deployed yet — continue
      }

      const mintInput = buildNftMintInput(
        {
          audit_id: certificate.audit_id,
          timestamp: certificate.timestamp,
          verdict: certificate.verdict,
          risk_score: certificate.risk_score,
          flags: certificate.flags || [],
          cryptographic_hash: certificate.cryptographic_hash,
          ...(certificate.logic_flaws && { logic_flaws: certificate.logic_flaws }),
          ...(certificate.structural_recommendations && { structural_recommendations: certificate.structural_recommendations }),
          ...(certificate.primary_bias_detected && { primary_bias_detected: certificate.primary_bias_detected }),
        },
        { irys_tx_id, irys_url: `https://gateway.irys.xyz/${irys_tx_id}` },
        certificate.tier || "micro",
        wallet_address
      );

      const nftResult = await mintProofOfLogicNft(mintInput);

      if (nftResult.nft_error) {
        return res.status(500).json({ error: "NFT mint failed", nft_error: nftResult.nft_error });
      }

      nftMintEligible.delete(irys_tx_id);

      res.json({
        nft_tx_hash: nftResult.nft_tx_hash,
        nft_token_id: nftResult.nft_token_id,
        irys_tx_id,
        certificate_stored_on_chain: true,
      });
    } catch (error) {
      console.error("[mint-nft] Failed:", error);
      res.status(500).json({ error: "NFT mint failed", message: error instanceof Error ? error.message : "Unknown" });
    }
  });

  const demoRateLimit = new Map<string, number>();
  app.post("/api/audit/demo", async (req: any, res) => {
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    const now = Date.now();
    const lastRequest = demoRateLimit.get(ip) || 0;
    if (now - lastRequest < 15000) {
      return res.status(429).json({
        error: "Demo rate limit: one request per 15 seconds.",
        code: "DJZS-DEMO-RATE",
        retry_after_ms: 15000 - (now - lastRequest),
      });
    }
    demoRateLimit.set(ip, now);

    for (const [key, ts] of demoRateLimit) {
      if (now - ts > 300000) demoRateLimit.delete(key);
    }

    const DEMO_AGENT_ADDRESS = "0x000000000000000000000000000000000000dea0";
    if (!req.body.agent_id) {
      req.body.agent_id = DEMO_AGENT_ADDRESS;
    }

    const demoSchema = z.object({
      strategy_memo: z.string().min(20, "Strategy memo must be at least 20 characters"),
      audit_type: z.enum(["treasury", "founder_drift", "strategy", "general"]).default("general"),
      agent_id: z.string().optional(),
      tier: z.string().optional(),
    });

    const parsed = demoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid demo audit request",
        details: parsed.error.errors,
      });
    }

    try {
      const audit = await executeAudit({
        strategy_memo: parsed.data.strategy_memo,
        audit_type: parsed.data.audit_type || "general",
        tier: "treasury",
        agent_id: parsed.data.agent_id,
      });

      const irysResult = await uploadAuditToIrys(audit);
      const trustScoreResult = await postAuditChainWrite(audit, parsed.data.agent_id, irysResult.irys_tx_id);

      const response: any = {
        audit_id: audit.audit_id,
        timestamp: audit.timestamp,
        tier: "micro",
        cryptographic_hash: audit.cryptographic_hash,
        keccak256_hash: audit.keccak256_hash,
        should_abort: audit.should_abort,
        abort_reasons: audit.abort_reasons,
        verdict: audit.verdict,
        risk_score: audit.risk_score,
        flags: audit.flags,
        primary_flaw: audit.primary_flaw,
        summary: audit.summary,
        model_used: audit.model_used,
        persona_used: audit.persona_used,
        provenance_provider: "IRYS_DATACHAIN",
        irys_tx_id: irysResult.irys_tx_id,
        irys_url: irysResult.irys_url,
        ...(trustScoreResult.trust_score_tx_hash && { trust_score_tx_hash: trustScoreResult.trust_score_tx_hash }),
        ...(trustScoreResult.trust_score_error && { trust_score_error: trustScoreResult.trust_score_error }),
      };
      if (irysResult.irys_error) {
        response.irys_error = irysResult.irys_error;
      }

      res.json(response);
    } catch (error) {
      console.error("Demo audit failed:", error);
      if (error instanceof Error && error.message.includes("VENICE_API_KEY")) {
        return res.status(503).json({ error: "AI service not configured" });
      }
      res.status(500).json({
        error: "Audit execution failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.post("/api/audit/escrow", requireEscrowSignature(), async (req: any, res) => {
    try {
      const parsed = escrowAuditRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid escrow audit request",
          details: parsed.error.errors,
        });
      }

      const escrowData = req.escrowData;
      const tier: AuditTier = escrowData?.amount
        ? (Number(escrowData.amount) >= 10_000_000 ? "treasury" : Number(escrowData.amount) >= 1_000_000 ? "founder" : "micro")
        : "micro";

      const audit = await executeAudit({
        strategy_memo: parsed.data.strategy_memo,
        audit_type: parsed.data.audit_type || "general",
        tier,
        intelligence_context: parsed.data.intelligence_context,
        trade_params: parsed.data.trade_params,
        agent_id: parsed.data.agent_id,
        escrow_id: parsed.data.escrow_id,
        escrow_tx_hash: parsed.data.escrow_tx_hash,
      });

      const irysPayload: Record<string, any> = {
        ...audit,
        audit_type: parsed.data.audit_type || "general",
        escrow_id: parsed.data.escrow_id,
        ...(parsed.data.agent_id && { agent_id: parsed.data.agent_id }),
        ...(parsed.data.trade_params && { trade_params: parsed.data.trade_params }),
      };
      const irysResult = await uploadAuditToIrys(irysPayload);

      const escrowAgentAddr = parsed.data.agent_id || escrowData?.recipient;
      const escrowTrustScoreResult = await postAuditChainWrite(audit, escrowAgentAddr, irysResult.irys_tx_id);

      const gateResult = await evaluateEscrowGate({
        audit,
        irysResult,
        chainWriteResult: escrowTrustScoreResult,
        escrowContext: {
          escrowId: parsed.data.escrow_id,
          creator: escrowData?.creator,
          recipient: escrowData?.recipient,
          amount: escrowData?.amount,
        },
      });

      try {
        const legacyLog = mapToLegacyAuditLog(audit, {
          strategyMemo: parsed.data.strategy_memo,
          auditType: parsed.data.audit_type || "general",
          walletAddress: escrowData?.recipient || null,
          irysTxId: irysResult.irys_tx_id,
        });
        await storage.createAuditLog({ ...legacyLog, strategyMemo: legacyLog.strategyMemo || parsed.data.strategy_memo });
      } catch (dbError) {
        console.error("Failed to persist escrow audit log:", dbError);
      }

      const response: Record<string, any> = {
        ...audit,
        provenance_provider: "IRYS_DATACHAIN",
        irys_tx_id: irysResult.irys_tx_id,
        irys_url: irysResult.irys_url,
        escrow_id: parsed.data.escrow_id,
        escrow_action: gateResult.action,
        trust_score: gateResult.gate_event.trust_score,
        trust_threshold: gateResult.gate_event.threshold,
        ...(gateResult.settlement_tx_hash && { settlement_tx_hash: gateResult.settlement_tx_hash }),
        ...(gateResult.settlement_error && { settlement_error: gateResult.settlement_error }),
        ...(irysResult.irys_error && { irys_error: irysResult.irys_error }),
        ...(escrowTrustScoreResult.trust_score_tx_hash && { trust_score_tx_hash: escrowTrustScoreResult.trust_score_tx_hash }),
        ...(escrowTrustScoreResult.trust_score_error && { trust_score_error: escrowTrustScoreResult.trust_score_error }),
        ...(escrowData && {
          escrow_creator: escrowData.creator,
          escrow_recipient: escrowData.recipient,
        }),
      };

      res.json(response);
    } catch (error) {
      console.error("Escrow Audit failed:", error);
      if (error instanceof Error && error.message.includes("Hash mismatch")) {
        return res.status(409).json({
          error: "Hash verification failed",
          message: error.message,
          code: "DJZS-HASH-MISMATCH",
        });
      }
      if (error instanceof Error && error.message.includes("Escrow ID mismatch")) {
        return res.status(409).json({
          error: "Escrow ID mismatch",
          message: error.message,
          code: "DJZS-ESCROW-MISMATCH",
        });
      }
      if (error instanceof Error && (error.message.includes("ESCROW_CONTRACT_ADDRESS") || error.message.includes("SETTLEMENT_PRIVATE_KEY") || error.message.includes("BASE_RPC_URL"))) {
        return res.status(503).json({
          error: "Escrow service not configured",
          code: "DJZS-ESCROW-CONFIG",
        });
      }
      if (error instanceof Error && error.message.includes("VENICE_API_KEY")) {
        return res.status(503).json({ error: "AI service not configured" });
      }
      res.status(500).json({
        error: "Escrow audit execution failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/api/audit/verify/:txId", async (req, res) => {
    try {
      const { txId } = req.params;
      if (!txId || txId.length < 10) {
        return res.status(400).json({ error: "Invalid Irys transaction ID" });
      }

      const irysResponse = await fetch(`https://gateway.irys.xyz/${txId}`);
      if (!irysResponse.ok) {
        return res.status(404).json({
          error: "Certificate not found on Irys Datachain",
          irys_tx_id: txId,
          irys_url: `https://gateway.irys.xyz/${txId}`,
        });
      }

      const certificate = await irysResponse.json();
      res.json({
        verified: true,
        provenance_provider: "IRYS_DATACHAIN",
        irys_tx_id: txId,
        irys_url: `https://gateway.irys.xyz/${txId}`,
        certificate,
      });
    } catch (error) {
      console.error("Irys verification failed:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  app.get("/api/audit/logs", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const logs = await storage.getAuditLogs(limit);
      res.json(logs);
    } catch (error) {
      console.error("Failed to fetch audit logs:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.post("/api/intelligence/brief", (req, res) => {
    try {
      const parsed = intelligenceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid intelligence request",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const brief = generateServerIntelligenceBrief(parsed.data);
      res.json(brief);
    } catch (err) {
      console.error("Intelligence brief generation error:", err);
      res.status(500).json({ error: "Intelligence analysis failed" });
    }
  });

  app.get("/api/audit/schema", (_req, res) => {
    res.json({
      service: "DJZS - Decentralized Journaling Zone System",
      version: "2.0",
      discovery: "/.well-known/agent.json",
      payment: {
        protocol: "x402",
        facilitator: "Coinbase CDP (@coinbase/x402)",
        network: X402_NETWORK,
        chain: "Base Mainnet",
        payTo: TREASURY_WALLET,
        x402_enabled: x402Initialized,
      },
      zones: {
        micro: {
          endpoint: "POST /api/audit/micro",
          price: "$0.10 USDC",
          description: TIER_CONFIG.micro.description,
          memo_limit: "1000 chars",
        },
        founder: {
          endpoint: "POST /api/audit/founder",
          price: "$1.00 USDC",
          description: TIER_CONFIG.founder.description,
          memo_limit: "5000 chars",
        },
        treasury: {
          endpoint: "POST /api/audit/treasury",
          price: "$10.00 USDC",
          description: TIER_CONFIG.treasury.description,
          memo_limit: "unlimited",
        },
      },
      escrow: {
        endpoint: "POST /api/audit/escrow",
        price: "Escrow-funded (no x402 payment required)",
        description: "Escrow-aware audit flow. Requires on-chain escrow via DJZS Escrow Contract. Verifies caller signature (x-escrow-signature header), reads AuditPending event from escrow_tx_hash, verifies strategy_memo hash on-chain, runs adversarial audit, uploads to Irys, and settles escrow on Base Mainnet.",
        requires: ["x-escrow-signature header", "escrow_id", "escrow_tx_hash", "strategy_memo"],
        escrow_contract: process.env.ESCROW_CONTRACT_ADDRESS || "not configured",
        trust_score_contract: process.env.TRUST_SCORE_CONTRACT_ADDRESS || "not configured",
      },
      verification: {
        endpoint: "GET /api/audit/verify/:txId",
        price: "Free",
        description: "Verify a ProofOfLogic certificate stored on the Irys Datachain. Pass the irys_tx_id from any audit response to retrieve and verify the permanent certificate.",
      },
      intelligence: {
        endpoint: "POST /api/intelligence/brief",
        price: "Free",
        description: "Pre-flight intelligence analysis. Submit historical data to get a structured brief with 5 signals (bias patterns, narrative drift, assumptions, volatility stress tests, emotional spikes). Returns intelligence_context string for injection into audit requests.",
      },
      backward_compatible: {
        endpoint: "POST /api/audit",
        price: "$0.10 USDC",
        note: "Alias for Micro-Zone. Use tiered endpoints for full control.",
      },
      request: {
        strategy_memo: "string (required, min 20 chars) - The strategy, proposal, or thesis to audit",
        audit_type: "string (optional) - treasury | founder_drift | strategy | general",
      },
      response: {
        audit_id: "UUID - unique identifier for this audit",
        timestamp: "ISO 8601 datetime",
        tier: "micro | founder | treasury",
        risk_score: "number 0-100 (0 = flawless logic, 100 = critically compromised)",
        primary_bias_detected: "FOMO | Sunk_Cost | Narrative_Reaction | Authority_Bias | Confirmation_Bias | Recency_Bias | None",
        logic_flaws: "[{flaw_type, severity (low|medium|critical), explanation}]",
        structural_recommendations: "string[] - concrete steps to fix the logic",
        cryptographic_hash: "SHA-256 hash of the input memo (for ERC-8004 verification)",
        provenance_provider: "IRYS_DATACHAIN - permanent storage provider",
        irys_tx_id: "string | null - Irys Datachain transaction ID for permanent certificate",
        irys_url: "string | null - Direct gateway link to the permanent ProofOfLogic certificate",
        trust_score_tx_hash: "string | null - Base Mainnet transaction hash for on-chain trust score update (requires agent_id and TRUST_SCORE_CONTRACT_ADDRESS)",
      },
    });
  });

  // ─── Architecture C: deterministic audit route ──────────────────────────
  // POST /api/v2/audit  →  extraction-layer → deterministic-engine → PASS/WAIT/FAIL
  // This is the canonical Architecture C path. The old /api/audit/* tiers remain
  // unchanged (backward compat). WAIT is mapped to HALT explicitly — never silent.
  const v2AuditRequestSchema = z.object({
    intent: z.string().min(10, "Intent must be at least 10 characters"),
  });

  app.post("/api/v2/audit", createVerifiedPaymentGate("micro"), async (req: any, res: any) => {
    const parsed = v2AuditRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request",
        details: parsed.error.errors,
        expected: { intent: "string (min 10 chars) — free-text agent intent to audit" },
      });
    }

    try {
      const { input, raw, failsafe } = await extractAuditInputConsensus(parsed.data.intent);
      const result = runDeterministicAudit(input);

      // Explicit three-way action mapping — WAIT must never be silent.
      const action =
        result.verdict === "PASS" ? "PROCEED" :
        result.verdict === "FAIL" ? "FAIL" :
        "HALT";

      const response: Record<string, unknown> = {
        schema_version: "DJZS-ENGINE-V2",
        verdict: result.verdict,
        action,
        risk_score: result.risk_score,
        flags: result.flags,
        unknown_fields: result.unknown_fields,
        verdict_hash: result.verdict_hash,
        engine: result.engine,
        extraction_failsafe: failsafe,
      };

      // Surface WHY we're halting so the caller can resolve the unknowns.
      if (action === "HALT") {
        response.halt_reason =
          `WAIT: ${result.unknown_fields.length} field(s) unresolvable from intent — ` +
          `[${result.unknown_fields.join(", ")}]. Clarify intent and re-audit.`;
      }

      res.json(response);
    } catch (err) {
      console.error("[/api/v2/audit] extraction or engine error:", err);
      res.status(500).json({
        error: "Audit execution failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
