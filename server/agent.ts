import { Agent } from "@xmtp/agent-sdk";
import {
  runAgent,
  extractContent,
  formatJournalReply,
  type JournalInsightPayload,
  type JournalInsightOutput,
} from "./openclaw";
import { handleXMTPMessage } from "./audit-agent";

const AUDIT_PREFIXES = ["Risk:", "Backtest:", "Regime:", "Logic:", "Thinking:", "Audit:"];

const HELP_TEXT = [
  "DJZS Oracle — Adversarial Logic Auditor",
  "",
  "Audit Prefixes:",
  "  Thinking: <memo>   → General audit (llama-3.3-70b)",
  "  Audit: <memo>      → General audit (llama-3.3-70b)",
  "  Logic: <memo>      → Logic flaw detection (llama-3.3-70b)",
  "  Risk: <memo>       → Risk management gaps (llama-3.3-70b)",
  "  Backtest: <memo>   → Overfitting detection (deepseek-r1)",
  "  Regime: <memo>     → Regime stress-test (qwen3-235b)",
  "",
  "Journal:",
  "  Journal: <entry>   → Reasoning trace analysis",
  "",
  "Commands:",
  "  /help or Help:     → Show this guide",
  "  /zones             → List available zones",
].join("\n");

function djzsReply(text: string): string | null {
  const t = (text || "").trim();

  if (t.startsWith("/help") || t.startsWith("Help:")) {
    return HELP_TEXT;
  }

  if (t.startsWith("/zones")) {
    return [
      "DJZS Zones (v2):",
      "01 Journal      — Reasoning trace analysis with adversarial oracle",
      "02 Logic Audit   — Detect circular reasoning, missing falsifiability",
      "03 Risk Hunter   — Find risk management gaps and tail risks",
      "04 Backtest Skeptic — Detect overfitting and data snooping",
      "05 Regime Detector  — Stress-test against regime changes",
    ].join("\n");
  }

  return null;
}

function isAuditPrefix(text: string): boolean {
  return AUDIT_PREFIXES.some(p => text.startsWith(p));
}

async function handleAgentMessage(sender: string, text: string): Promise<string> {
  const t = text.trim();

  if (isAuditPrefix(t)) {
    try {
      return await handleXMTPMessage(t);
    } catch (err) {
      console.error(`[XMTP] Audit error:`, err);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      return `Audit failed: ${errorMsg}`;
    }
  }

  if (t.toLowerCase().startsWith("journal:")) {
    const content = t.slice(8).trim();
    if (!content || content.length < 3) {
      return 'Please provide some content after the "Journal:" prefix.';
    }

    try {
      const payload: JournalInsightPayload = {
        type: "journal_entry",
        user_id: sender,
        content,
        timestamp: new Date().toISOString(),
        recentEntries: [],
        pinnedMemories: [],
      };
      const result = await runAgent("JournalInsight", payload) as JournalInsightOutput;
      return formatJournalReply(result);
    } catch (err) {
      console.error(`[XMTP] Journal error:`, err);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      if (errorMsg.includes("VENICE_API_KEY")) {
        return "AI processing is not configured. Please set up your Venice API key.";
      }
      return `Journal analysis failed: ${errorMsg}`;
    }
  }

  return "I'm DJZS Oracle Agent. Type /help or Help: for commands.\n\nPrefixes:\n- Thinking: <thesis to audit>\n- Risk: <strategy to stress-test>\n- Journal: <reasoning trace>";
}

async function main() {
  const agent = await Agent.createFromEnv({
    env: (process.env.XMTP_ENV as "dev" | "production") || "dev",
  });

  console.log("DJZS XMTP Agent online (persona-routed)");

  agent.on("start", (ctx: any) => {
    console.log("[XMTP] Streams active — ready to receive messages");
  });

  agent.on("conversation", (ctx: any) => {
    console.log(`[XMTP] New conversation detected: ${ctx?.conversation?.id}`);
  });

  agent.on("text", async (ctx: any) => {
    try {
      const incoming = ctx?.message?.content || "";
      const sender = ctx?.message?.senderInboxId || "unknown";

      console.log(`[XMTP] Message from ${sender}: ${incoming.slice(0, 80)}...`);

      const staticReply = djzsReply(incoming);
      if (staticReply) {
        await ctx.sendText(staticReply);
        return;
      }

      const reply = await handleAgentMessage(sender, incoming);
      await ctx.sendText(reply);
      console.log(`[XMTP] Reply sent (${reply.length} chars)`);
    } catch (err) {
      console.error("Agent error:", err);
    }
  });

  console.log(`DJZS Oracle address: ${agent.address}`);
  console.log("Listening for messages...");
  await agent.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
