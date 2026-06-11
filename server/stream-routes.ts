import type { Express, Request, Response as ExpressResponse, NextFunction } from "express";
import crypto from "crypto";
import { executeAudit } from "./audit-agent";
import { uploadAuditToIrys } from "./irys";

const SYS_ID = "DJZS-VIDEO-AUDIT-001";
const VIDEO_AUDIT_PRICE = "$0.25";
const DEFAULT_ALLOWED_ORIGINS = ["djzs.ai", "www.djzs.ai", "djzs.io", "www.djzs.io"];
const VIDEO_UID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

type VideoAuditModule = "dst_claim" | "prediction_market" | "perp_trade" | "journal_reflection";

type StreamUploadRequest = {
  title?: string;
  creator?: string;
  auditId?: string;
  maxDurationSeconds?: number;
};

type VideoAuditRequest = {
  thesis: string;
  videoUid?: string;
  module?: VideoAuditModule;
  title?: string;
  context?: string;
  creator?: string;
};

function json(res: ExpressResponse, status: number, body: unknown) {
  return res.status(status).json(body);
}

function getStreamConfig() {
  return {
    accountId: process.env.CF_STREAM_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CF_STREAM_API_TOKEN || process.env.CLOUDFLARE_STREAM_API_TOKEN,
    customerSubdomain: process.env.CF_STREAM_CUSTOMER_SUBDOMAIN,
  };
}

function requireStreamConfig(res: ExpressResponse) {
  const config = getStreamConfig();
  if (!config.accountId || !config.apiToken) {
    json(res, 503, {
      error: "Cloudflare Stream is not configured.",
      code: "DJZS-STREAM-CONFIG",
      required_env: ["CF_STREAM_ACCOUNT_ID", "CF_STREAM_API_TOKEN", "CF_STREAM_CUSTOMER_SUBDOMAIN"],
    });
    return null;
  }
  return config;
}

function allowedOrigins() {
  const fromEnv = process.env.CF_STREAM_ALLOWED_ORIGINS;
  if (!fromEnv) return DEFAULT_ALLOWED_ORIGINS;
  return fromEnv.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function normalizeDuration(input: unknown) {
  const n = Number(input);
  if (!Number.isFinite(n)) return 600;
  return Math.min(Math.max(Math.floor(n), 30), 1800);
}

function shouldRequirePayment() {
  if (process.env.DJZS_DISABLE_PAYMENT_GATE === "true") return false;
  if (process.env.NODE_ENV !== "production") return false;
  return true;
}

function requirePayment(req: Request, res: ExpressResponse, next: NextFunction) {
  if (!shouldRequirePayment()) return next();

  const proof = req.headers["x-payment-proof"] || req.headers["x-payment"] || req.headers["authorization"];
  if (proof) return next();

  return json(res, 402, {
    error: "Payment Required. Provide an MPP/x402 payment proof before creating a video audit receipt.",
    code: "DJZS-VIDEO-AUDIT-402",
    price: VIDEO_AUDIT_PRICE,
    route: "/api/dst/video-audit",
    payment_header: "x-payment-proof",
  });
}

async function readCloudflareJson(response: globalThis.Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    const message = data?.errors?.[0]?.message || data?.error || response.statusText;
    throw new Error(message || "Cloudflare Stream request failed");
  }
  return data.result;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}

function sha256Hex(value: unknown) {
  return "0x" + crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function assertVideoUid(videoUid: string | undefined) {
  if (!videoUid || !VIDEO_UID_RE.test(videoUid)) {
    throw new Error("Invalid or missing Cloudflare Stream video UID");
  }
}

export function registerStreamRoutes(app: Express) {
  app.get("/api/stream/config", (_req, res) => {
    const config = getStreamConfig();
    res.json({
      configured: !!(config.accountId && config.apiToken),
      customerSubdomain: config.customerSubdomain || null,
      requirePayment: shouldRequirePayment(),
      sys_id: SYS_ID,
    });
  });

  app.get("/api/dst/video-audit/schema", (_req, res) => {
    res.json({
      sys_id: SYS_ID,
      price: VIDEO_AUDIT_PRICE,
      description: "Upload a thesis explanation video, audit the claim against DJZS logic, and return JSON plus a receipt.",
      routes: {
        create_upload_url: "POST /api/stream/upload-url",
        video_status: "GET /api/stream/status/:videoUid",
        playback_token: "POST /api/stream/playback-token",
        video_audit: "POST /api/dst/video-audit",
      },
      request: {
        thesis: "string, min 20 characters",
        videoUid: "optional Cloudflare Stream UID",
        module: "dst_claim | prediction_market | perp_trade | journal_reflection",
        title: "optional string",
        context: "optional string",
      },
    });
  });

  app.post("/api/stream/upload-url", requirePayment, async (req: Request<{}, {}, StreamUploadRequest>, res: ExpressResponse) => {
    try {
      const config = requireStreamConfig(res);
      if (!config) return;

      const title = typeof req.body.title === "string" && req.body.title.trim()
        ? req.body.title.trim().slice(0, 140)
        : "DJZS thesis audit video";

      const maxDurationSeconds = normalizeDuration(req.body.maxDurationSeconds);
      const creator = typeof req.body.creator === "string" && req.body.creator.trim()
        ? req.body.creator.trim().slice(0, 80)
        : "djzs-user";

      const cloudflare = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/direct_upload`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            maxDurationSeconds,
            allowedOrigins: allowedOrigins(),
            creator,
            meta: {
              name: title,
              auditId: req.body.auditId || crypto.randomUUID(),
              sys_id: SYS_ID,
            },
            requireSignedURLs: true,
          }),
        },
      );

      const result = await readCloudflareJson(cloudflare);
      res.json({
        sys_id: SYS_ID,
        videoUid: result.uid,
        uploadURL: result.uploadURL,
        maxDurationSeconds,
        requireSignedURLs: true,
      });
    } catch (error) {
      console.error("[stream] upload-url failed:", error);
      json(res, 502, {
        error: "Could not create Cloudflare Stream upload URL.",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/api/stream/status/:videoUid", async (req, res) => {
    try {
      const config = requireStreamConfig(res);
      if (!config) return;
      const videoUid = req.params.videoUid;
      assertVideoUid(videoUid);

      const cloudflare = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${videoUid}`,
        { headers: { Authorization: `Bearer ${config.apiToken}` } },
      );

      const result = await readCloudflareJson(cloudflare);
      res.json({
        uid: result.uid,
        readyToStream: result.readyToStream,
        readyToStreamAt: result.readyToStreamAt || null,
        status: result.status,
        duration: result.duration || null,
        thumbnail: result.thumbnail || null,
        meta: result.meta || {},
        requireSignedURLs: result.requireSignedURLs,
      });
    } catch (error) {
      json(res, 400, {
        error: "Could not fetch Cloudflare Stream status.",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.post("/api/stream/playback-token", requirePayment, async (req: Request, res: ExpressResponse) => {
    try {
      const config = requireStreamConfig(res);
      if (!config) return;
      const videoUid = req.body?.videoUid as string | undefined;
      assertVideoUid(videoUid);

      const expiresInSeconds = normalizeDuration(req.body?.expiresInSeconds || 3600);
      const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;

      const cloudflare = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${videoUid}/token`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ exp, downloadable: false }),
        },
      );

      const result = await readCloudflareJson(cloudflare);
      const base = config.customerSubdomain || "customer-REPLACE_ME.cloudflarestream.com";

      res.json({
        token: result.token,
        expiresInSeconds,
        iframeUrl: `https://${base}/${result.token}/iframe`,
      });
    } catch (error) {
      json(res, 400, {
        error: "Could not create signed Cloudflare Stream playback token.",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.post("/api/dst/video-audit", requirePayment, async (req: Request<{}, {}, VideoAuditRequest>, res: ExpressResponse) => {
    try {
      const thesis = typeof req.body.thesis === "string" ? req.body.thesis.trim() : "";
      if (thesis.length < 20) {
        return json(res, 400, {
          error: "Thesis must be at least 20 characters.",
          code: "DJZS-VIDEO-AUDIT-INPUT",
        });
      }

      const moduleName: VideoAuditModule = req.body.module || "dst_claim";
      const videoUid = req.body.videoUid?.trim();
      if (videoUid) assertVideoUid(videoUid);

      const context = typeof req.body.context === "string" && req.body.context.trim()
        ? `\n\nContext:\n${req.body.context.trim()}`
        : "";

      const certificate = await executeAudit({
        strategy_memo: `${thesis}${context}`,
        audit_type: moduleName === "journal_reflection" ? "general" : "strategy",
        target_system: "djzs-video-audit",
        tier: "micro",
        trade_params: {
          module: moduleName,
          video_uid: videoUid || null,
          title: req.body.title || null,
          media_layer: "cloudflare-stream",
        },
        agent_id: req.body.creator || "djzs-video-audit",
      });

      const receiptCore = {
        sys_id: SYS_ID,
        route: "/api/dst/video-audit",
        price: VIDEO_AUDIT_PRICE,
        audit_id: certificate.audit_id,
        timestamp: certificate.timestamp,
        module: moduleName,
        title: req.body.title || null,
        thesis,
        video: videoUid
          ? {
              provider: "cloudflare-stream",
              uid: videoUid,
              requireSignedURLs: true,
            }
          : null,
        verdict: certificate.verdict,
        risk_score: certificate.risk_score,
        flags: certificate.flags,
        logic_hash: certificate.logic_hash,
        audit_schema_version: certificate.audit_schema_version,
        weights_hash: certificate.weights_hash,
        deterministic_engine: certificate.scoring_engine,
      };

      const receipt_hash = sha256Hex(receiptCore);
      const receipt_id = `djzs_video_${receipt_hash.slice(2, 18)}`;

      const receipt = {
        ...receiptCore,
        receipt_id,
        receipt_hash,
        proof: {
          anchor_target: "irys-datachain",
          media_layer: "cloudflare-stream",
          verdict_owner: "djzs-deterministic-engine",
        },
      };

      const irys = await uploadAuditToIrys(receipt as Record<string, any>);

      res.json({
        ...receipt,
        irys_tx_id: irys.irys_tx_id,
        irys_url: irys.irys_url,
        irys_error: irys.irys_error,
        certificate,
      });
    } catch (error) {
      console.error("[video-audit] failed:", error);
      json(res, 500, {
        error: "Video audit failed.",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}
