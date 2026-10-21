// The EAS schema resolver for DJZS verdict schema v3: the record cannot hold an inconsistent verdict.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const SCHEMA_V3 =
  "bytes32 intentHash,string verdict,uint8 riskScore,string[] flags,string rulesetVersion,uint8 unknownCount,bool bounded,bool thesisPresent";
const TYPES = ["bytes32", "string", "uint8", "string[]", "string", "uint8", "bool", "bool"];
const coder = ethers.AbiCoder.defaultAbiCoder();
const INTENT = ethers.keccak256(ethers.toUtf8Bytes("intent"));

function encode({ intentHash = INTENT, verdict, riskScore, flags, rulesetVersion, unknownCount = 0, bounded = true, thesisPresent = true }) {
  return coder.encode(TYPES, [intentHash, verdict, riskScore, flags, rulesetVersion, unknownCount, bounded, thesisPresent]);
}

function attestation(data, overrides = {}) {
  return {
    uid: ethers.keccak256(ethers.toUtf8Bytes("uid")),
    schema: ethers.ZeroHash,
    time: 0n,
    expirationTime: 0n,
    revocationTime: 0n,
    refUID: ethers.ZeroHash,
    recipient: ethers.ZeroAddress,
    attester: ethers.ZeroAddress,
    revocable: false,
    data,
    ...overrides,
  };
}

describe("DJZSVerdictResolver", function () {
  let rule, resolver, eas, stranger;

  before(async function () {
    [, stranger] = await ethers.getSigners();
    rule = await (await ethers.getContractFactory("DJZSVerdictRule")).deploy();
    eas = await (await ethers.getContractFactory("MockEAS")).deploy();
    resolver = await (await ethers.getContractFactory("DJZSVerdictResolver")).deploy(await eas.getAddress(), await rule.getAddress());
  });

  it("publishes schema v3 and derives the UID the SchemaRegistry will assign", async function () {
    expect(await resolver.SCHEMA()).to.equal(SCHEMA_V3);
    expect(await resolver.REVOCABLE()).to.equal(false);
    expect(await resolver.isPayable()).to.equal(false);
    expect(await resolver.version()).to.equal("1.0.0");
    const expected = ethers.keccak256(ethers.solidityPacked(["string", "address", "bool"], [SCHEMA_V3, await resolver.getAddress(), false]));
    expect(await resolver.schemaUID()).to.equal(expected);
    // The v2 schema is the first five fields of v3, verbatim.
    expect(SCHEMA_V3.startsWith("bytes32 intentHash,string verdict,uint8 riskScore,string[] flags,string rulesetVersion")).to.equal(true);
  });

  it("accepts an attestation whose verdict and risk are what the rule derives, and logs the check", async function () {
    const data = encode({ verdict: "FAIL", riskScore: 40, flags: ["DJZS-M03", "DJZS-M04"], rulesetVersion: "DJZS-PM-v1.0" });
    const a = attestation(data);
    expect(await eas.callAttest.staticCall(await resolver.getAddress(), a)).to.equal(true);
    await expect(eas.callAttest(await resolver.getAddress(), a))
      .to.emit(resolver, "VerdictChecked")
      .withArgs(a.uid, INTENT, "DJZS-PM-v1.0", 40, 3);
    const [ok, risk, code, intentHash] = await resolver.check(data);
    expect([ok, Number(risk), Number(code), intentHash]).to.deep.equal([true, 40, 3, INTENT]);
  });

  it("refuses a verdict the tally contradicts, and a risk score that is off by one", async function () {
    const flags = ["DJZS-M03", "DJZS-M04"];
    const lied = encode({ verdict: "PASS", riskScore: 40, flags, rulesetVersion: "DJZS-PM-v1.0" });
    expect(await eas.callAttest.staticCall(await resolver.getAddress(), attestation(lied))).to.equal(false);
    const shaved = encode({ verdict: "FAIL", riskScore: 39, flags, rulesetVersion: "DJZS-PM-v1.0" });
    expect(await eas.callAttest.staticCall(await resolver.getAddress(), attestation(shaved))).to.equal(false);
    // A WAIT claimed with nothing unknown and nothing fired is a PASS by the rule: refused.
    const waited = encode({ verdict: "WAIT", riskScore: 0, flags: [], rulesetVersion: "DJZS-LF-v1.2", unknownCount: 0, bounded: false });
    expect(await eas.callAttest.staticCall(await resolver.getAddress(), attestation(waited))).to.equal(false);
    // The same claim with one unknown field is honest.
    const honest = encode({ verdict: "WAIT", riskScore: 0, flags: [], rulesetVersion: "DJZS-LF-v1.2", unknownCount: 1, bounded: false });
    expect(await eas.callAttest.staticCall(await resolver.getAddress(), attestation(honest))).to.equal(true);
  });

  it("bubbles the rule's refusal of a tally it cannot read", async function () {
    const unknownCode = encode({ verdict: "FAIL", riskScore: 30, flags: ["DJZS-Z99"], rulesetVersion: "DJZS-PM-v1.0" });
    await expect(eas.callAttest.staticCall(await resolver.getAddress(), attestation(unknownCode)))
      .to.be.revertedWithCustomError(rule, "UnknownCode");
    const unknownRuleset = encode({ verdict: "PASS", riskScore: 0, flags: [], rulesetVersion: "DJZS-LF-v1.1" });
    await expect(eas.callAttest.staticCall(await resolver.getAddress(), attestation(unknownRuleset)))
      .to.be.revertedWithCustomError(rule, "UnknownRuleset");
  });

  it("answers only EAS, takes no value, and lets a non-revocable schema's revoke hooks pass", async function () {
    const data = encode({ verdict: "PASS", riskScore: 0, flags: [], rulesetVersion: "DJZS-PM-v1.0" });
    await expect(resolver.connect(stranger).attest(attestation(data))).to.be.revertedWithCustomError(resolver, "AccessDenied");
    await expect(eas.callAttest(await resolver.getAddress(), attestation(data), { value: 1n })).to.be.revertedWithCustomError(resolver, "NotPayable");
    expect(await eas.callRevoke.staticCall(await resolver.getAddress(), attestation(data))).to.equal(true);
  });

  it("multiAttest is all or nothing", async function () {
    const good = attestation(encode({ verdict: "PASS", riskScore: 0, flags: [], rulesetVersion: "DJZS-PM-v1.0" }));
    const bad = attestation(encode({ verdict: "PASS", riskScore: 30, flags: ["DJZS-M01"], rulesetVersion: "DJZS-PM-v1.0" }));
    expect(await eas.callMultiAttest.staticCall(await resolver.getAddress(), [good, good], [0, 0])).to.equal(true);
    expect(await eas.callMultiAttest.staticCall(await resolver.getAddress(), [good, bad], [0, 0])).to.equal(false);
  });

  it("refuses zero addresses at deployment", async function () {
    const Factory = await ethers.getContractFactory("DJZSVerdictResolver");
    await expect(Factory.deploy(ethers.ZeroAddress, await rule.getAddress())).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    await expect(Factory.deploy(await eas.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(Factory, "ZeroAddress");
  });
});
