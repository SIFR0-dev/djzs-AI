// Deploys DJZSVerdictRule and DJZSVerdictResolver on Base, then (with REGISTER_SCHEMA=1) registers
// EAS schema v3 with the resolver on the SchemaRegistry predeploy. Prints every address and the
// schema UID. Idempotent by inspection: rerun with RULE_ADDRESS set to reuse a deployed rule.
//
//   npx hardhat run scripts/deploy-verdict-rule.cjs --network base
//   REGISTER_SCHEMA=1 npx hardhat run scripts/deploy-verdict-rule.cjs --network base
//
// Keys come from hardhat.config.cjs (DEPLOYER_MNEMONIC, BASE_RPC_URL), never from this file.
// Deploy order matters: the resolver's address is part of the schema UID, so the schema is registered
// last, and the Worker's EAS_RESOLVER_ADDRESS is set only after the registration is mined.
const hre = require("hardhat");

const EAS = "0x4200000000000000000000000000000000000021";
const SCHEMA_REGISTRY = "0x4200000000000000000000000000000000000020";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  console.log(`chain ${net.chainId}, deployer ${deployer.address}`);
  if (Number(net.chainId) !== 8453 && Number(net.chainId) !== 84532) throw new Error(`not Base: chain ${net.chainId}`);

  let rule;
  if (process.env.RULE_ADDRESS) {
    rule = await hre.ethers.getContractAt("DJZSVerdictRule", process.env.RULE_ADDRESS);
    console.log("DJZSVerdictRule (existing):", await rule.getAddress(), await rule.VERSION());
  } else {
    const Rule = await hre.ethers.getContractFactory("DJZSVerdictRule");
    rule = await Rule.deploy();
    await rule.waitForDeployment();
    console.log("DJZSVerdictRule deployed to:", await rule.getAddress(), "version", await rule.VERSION());
  }
  // The constructor already refused a bad weight table; read the sums back anyway, for the log.
  console.log("  PM weight sum", (await rule.PM_WEIGHT_SUM()).toString(), "threshold", (await rule.PM_FAIL_THRESHOLD()).toString());
  console.log("  LF weight sum", (await rule.LF_WEIGHT_SUM()).toString(), "threshold", (await rule.LF_FAIL_THRESHOLD()).toString());

  const Resolver = await hre.ethers.getContractFactory("DJZSVerdictResolver");
  const resolver = await Resolver.deploy(EAS, await rule.getAddress());
  await resolver.waitForDeployment();
  const resolverAddress = await resolver.getAddress();
  const schema = await resolver.SCHEMA();
  const uid = await resolver.schemaUID();
  console.log("DJZSVerdictResolver deployed to:", resolverAddress);
  console.log("  schema v3:", schema);
  console.log("  schema v3 UID (once registered):", uid);

  if (process.env.REGISTER_SCHEMA === "1") {
    const registry = new hre.ethers.Contract(
      SCHEMA_REGISTRY,
      ["function register(string schema, address resolver, bool revocable) returns (bytes32)", "function getSchema(bytes32 uid) view returns ((bytes32 uid,address resolver,bool revocable,string schema))"],
      deployer,
    );
    const existing = await registry.getSchema(uid);
    if (existing.uid !== hre.ethers.ZeroHash) {
      console.log("schema v3 already registered:", uid);
    } else {
      const tx = await registry.register(schema, resolverAddress, false);
      console.log("register tx:", tx.hash);
      const rc = await tx.wait();
      console.log("registered in block", rc.blockNumber, "gas used", rc.gasUsed.toString());
      const after = await registry.getSchema(uid);
      if (after.resolver.toLowerCase() !== resolverAddress.toLowerCase()) throw new Error("registry resolver mismatch");
    }
  } else {
    console.log("schema NOT registered (set REGISTER_SCHEMA=1). The UID above is what the registry will assign.");
  }
  console.log("\nNext: set EAS_RESOLVER_ADDRESS =", resolverAddress, "in djzs-trust-mcp/wrangler.toml [vars] and deploy the Worker.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => { console.error(error); process.exit(1); });
