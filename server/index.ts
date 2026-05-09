import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { registerStreamRoutes } from "./stream-routes";
import { setupVite, serveStatic, log } from "./vite";
import { seedDefaultRooms } from "./storage";

const app = express();

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Payment-Proof, X-Payment, X-Wallet-Address, X-Venice-Api-Key');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  try {
    await seedDefaultRooms();
  } catch (e) {
    console.warn("[startup] Database seeding failed (non-fatal):", (e as Error).message);
    console.warn("[startup] A2A audit endpoints will still work without database");
  }
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasVeniceKey = !!process.env.VENICE_API_KEY;
  if (hasAnthropicKey) {
    log("[prediction] ANTHROPIC_API_KEY configured — Claude engine available");
  } else {
    console.warn("[prediction] ANTHROPIC_API_KEY not set — Claude engine will return 503. Venice fallback available if VENICE_API_KEY is set.");
  }
  if (hasVeniceKey) {
    log("[prediction] VENICE_API_KEY configured — Venice engine available");
  }
  if (!hasAnthropicKey && !hasVeniceKey) {
    console.warn("[prediction] WARNING: Neither ANTHROPIC_API_KEY nor VENICE_API_KEY is set. Prediction audits will return 503 for all engines.");
  }

  const server = await registerRoutes(app);
  registerStreamRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = parseInt(process.env.PORT || '5000', 10);
  const listenOptions: { port: number; host: string; reusePort?: boolean } = {
    port,
    host: "0.0.0.0",
  };
  if (process.platform === "linux") {
    listenOptions.reusePort = true;
  }

  server.listen(listenOptions, () => {
    log(`serving on port ${port}`);
  });
})();
