import { Hono } from "hono"
import { TERMS_HASH, TERMS_TEXT } from "./terms"
import { type Env, isAddress, json, payeeMin, payeeOf, publicClient, readBalance, readMember, readSource, readVaultConfig, vaultAddress } from "./chain"
import { erc20Abi } from "./abi"
import { readLastRun, readRegistry, runKeeper } from "./run"

const app = new Hono<{ Bindings: Env }>()

app.get("/patron/terms", (c) => c.body(TERMS_TEXT, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-terms-keccak256": TERMS_HASH }))
app.get("/patron/terms.md", (c) => c.body(TERMS_TEXT, 200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "x-terms-keccak256": TERMS_HASH }))

/** Liveness plus the two things that must never drift: the served terms against the contract's hash,
 *  and the keeper's balance against its floor. */
app.get("/patron/health", async (c) => {
  const env = c.env
  const vault = vaultAddress(env)
  const out: Record<string, unknown> = {
    ok: true,
    chainId: Number(env.CHAIN_ID),
    vault,
    servedTermsHash: TERMS_HASH,
    dryRun: env.DRY_RUN !== "false",
    keeperKeySet: Boolean(env.KEEPER_KEY),
  }
  if (!vault) {
    out.ok = false
    out.problem = "VAULT_ADDRESS not set"
    return json(out, 503)
  }
  try {
    const client = publicClient(env)
    const [cfg, block] = await Promise.all([readVaultConfig(client, vault), client.getBlockNumber()])
    out.block = block
    out.vaultTermsHash = cfg.termsHash
    out.termsMatch = cfg.termsHash.toLowerCase() === TERMS_HASH.toLowerCase()
    out.memberCount = cfg.memberCount
    out.totalPrincipal = cfg.totalPrincipal
    out.sinkShares = cfg.sinkShares
    const last = await readLastRun(env)
    out.lastRun = last
    out.registry = (await readRegistry(env)).length
    out.lowBalance = last?.lowBalance ?? null
    if (!out.termsMatch) {
      out.ok = false
      out.problem = "served terms do not hash to the vault's termsHash; joins from this page would revert BadTerms"
    }
    if (last?.lowBalance) {
      out.ok = false
      out.problem = (out.problem ? out.problem + "; " : "") + "keeper balance under MIN_KEEPER_BALANCE_WEI"
    }
    return json(out, out.ok ? 200 : 503)
  } catch (e) {
    out.ok = false
    out.problem = "rpc: " + (e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e))
    return json(out, 503)
  }
})

/** What the page shows before any wallet connects. */
app.get("/patron/api/status", async (c) => {
  const env = c.env
  const vault = vaultAddress(env)
  if (!vault) return json({ error: "VAULT_ADDRESS not set" }, 503)
  try {
    const client = publicClient(env)
    const [cfg, block] = await Promise.all([readVaultConfig(client, vault), client.getBlock()])
    const source = await readSource(client, cfg.source, vault)
    return json({
      chainId: Number(env.CHAIN_ID),
      rpcUrl: env.RPC_URL,
      block: block.number,
      now: block.timestamp,
      vault,
      ...cfg,
      servedTermsHash: TERMS_HASH,
      termsMatch: cfg.termsHash.toLowerCase() === TERMS_HASH.toLowerCase(),
      payee: payeeOf(env),
      payeeMin: payeeMin(env),
      source: { address: cfg.source, ...source },
    })
  } catch (e) {
    return json({ error: "rpc: " + (e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e)) }, 502)
  }
})

/** One member's position, routes, preview of the next settle, and their USDC balance and allowance. */
app.get("/patron/api/member/:address", async (c) => {
  const env = c.env
  const vault = vaultAddress(env)
  if (!vault) return json({ error: "VAULT_ADDRESS not set" }, 503)
  const who = c.req.param("address")
  if (!isAddress(who)) return json({ error: "not an address" }, 400)
  try {
    const client = publicClient(env)
    const cfg = await readVaultConfig(client, vault)
    const [m, balance, allowance] = await Promise.all([
      readMember(client, vault, who, payeeOf(env), payeeMin(env)),
      readBalance(client, cfg.asset, who),
      client.readContract({ address: cfg.asset, abi: erc20Abi, functionName: "allowance", args: [who, vault] }),
    ])
    return json({ address: who, ...m, usdcBalance: balance, allowance })
  } catch (e) {
    return json({ error: "rpc: " + (e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e)) }, 502)
  }
})

/** Anything else under /patron that the Worker sees (run_worker_first) is not an API route. */
app.notFound((c) => json({ error: "not found", path: new URL(c.req.url).pathname }, 404))

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runKeeper(env))
  },
}
