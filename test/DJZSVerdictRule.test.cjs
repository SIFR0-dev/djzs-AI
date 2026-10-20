// DJZS-VR-v1.0: the on-chain rule against the engine's full input space.
// The fixture is written by `npx tsx tests/verdict-rule-fixtures.ts` from the deterministic engine;
// every distinct tally it produces (267 rows, 59,157 inputs) must score identically here.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const FIXTURE = path.join(__dirname, "..", "tests", "fixtures", "verdict-rule.json");
const PM = "DJZS-PM-v1.0";
const LF = "DJZS-LF-v1.2";

const tally = (rulesetVersion, codes, unknownCount = 0, bounded = true, thesisPresent = true) => ({
  rulesetVersion, codes, unknownCount, bounded, thesisPresent,
});

describe("DJZSVerdictRule", function () {
  let rule;

  before(async function () {
    const Factory = await ethers.getContractFactory("DJZSVerdictRule");
    rule = await Factory.deploy();
    await rule.waitForDeployment();
  });

  it("states its version, rulesets, thresholds and the governed weight sums", async function () {
    expect(await rule.VERSION()).to.equal("DJZS-VR-v1.0");
    expect(await rule.PM_RULESET()).to.equal(PM);
    expect(await rule.LF_RULESET()).to.equal(LF);
    expect(await rule.PM_FAIL_THRESHOLD()).to.equal(25n);
    expect(await rule.LF_FAIL_THRESHOLD()).to.equal(50n);
    expect(await rule.PM_WEIGHT_SUM()).to.equal(100n);
    expect(await rule.LF_WEIGHT_SUM()).to.equal(200n);
    expect(await rule.PASS()).to.equal(1n);
    expect(await rule.WAIT()).to.equal(2n);
    expect(await rule.FAIL()).to.equal(3n);
  });

  it("replays every distinct tally of the engine's input space from the fixture", async function () {
    const doc = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(doc.rule).to.equal("DJZS-VR-v1.0");
    expect(doc.rows.length).to.equal(doc.count);
    expect(doc.count).to.be.greaterThan(200);
    const rulesets = new Set(doc.rows.map((r) => r.ruleset));
    expect([...rulesets].sort()).to.deep.equal([LF, PM]);
    let inputs = 0;
    for (const row of doc.rows) {
      const [risk, code] = await rule.score(tally(row.ruleset, row.codes, row.unknown_count, row.bounded, row.thesis_present));
      const label = `${row.ruleset} ${row.codes.join("+") || "(no codes)"} u${row.unknown_count} b${row.bounded} t${row.thesis_present}`;
      expect(Number(risk), `risk of ${label}`).to.equal(row.risk_score);
      expect(Number(code), `verdict of ${label}`).to.equal(row.verdict_code);
      expect(await rule.verdictString(code), `verdict string of ${label}`).to.equal(row.verdict);
      inputs += row.inputs;
    }
    expect(inputs).to.equal(doc.rulesets[PM].inputs + doc.rulesets[LF].inputs);
    expect(inputs).to.equal(59157);
  });

  it("agrees with the hand-checked cases the integrity tests pin", async function () {
    // Solo M04 rides a PASS at 15 (tests/pm-engine-integrity.ts).
    let [risk, code] = await rule.score(tally(PM, ["DJZS-M04"]));
    expect([Number(risk), Number(code)]).to.deep.equal([15, 1]);
    // M03 + M04 FAIL at 40.
    [risk, code] = await rule.score(tally(PM, ["DJZS-M03", "DJZS-M04"]));
    expect([Number(risk), Number(code)]).to.deep.equal([40, 3]);
    // M03 alone reaches the PM threshold exactly: FAIL at 25.
    [risk, code] = await rule.score(tally(PM, ["DJZS-M03"]));
    expect([Number(risk), Number(code)]).to.deep.equal([25, 3]);
    // A CRITICAL code condemns below the threshold: X01 alone is 15, FAIL.
    [risk, code] = await rule.score(tally(LF, ["DJZS-X01"]));
    expect([Number(risk), Number(code)]).to.deep.equal([15, 3]);
    // LF: no codes, bounded, thesis present, no unknowns: PASS.
    [risk, code] = await rule.score(tally(LF, [], 0, true, true));
    expect([Number(risk), Number(code)]).to.deep.equal([0, 1]);
    // LF: no codes, bounded, thesis unknown, one unknown field: WAIT (a stop alone buys no PASS).
    [risk, code] = await rule.score(tally(LF, [], 1, true, false));
    expect([Number(risk), Number(code)]).to.deep.equal([0, 2]);
    // LF: no codes, unbounded, nothing unknown: PASS (the engine's last rung).
    [risk, code] = await rule.score(tally(LF, [], 0, false, false));
    expect([Number(risk), Number(code)]).to.deep.equal([0, 1]);
    // LF: I01 alone is 16 MEDIUM, no unknowns: PASS with an advisory flag riding along.
    [risk, code] = await rule.score(tally(LF, ["DJZS-I01"], 0, true, true));
    expect([Number(risk), Number(code)]).to.deep.equal([16, 1]);
    // LF: E01 + I01 + I02 = 57 reaches 50: FAIL with no CRITICAL code.
    [risk, code] = await rule.score(tally(LF, ["DJZS-E01", "DJZS-I01", "DJZS-I02"]));
    expect([Number(risk), Number(code)]).to.deep.equal([57, 3]);
    // PM ignores thesisPresent.
    [risk, code] = await rule.score(tally(PM, [], 0, true, false));
    expect([Number(risk), Number(code)]).to.deep.equal([0, 1]);
  });

  it("refuses what it cannot read: unknown ruleset, unknown code, duplicate code", async function () {
    await expect(rule.score(tally("DJZS-PM-v0.9", []))).to.be.revertedWithCustomError(rule, "UnknownRuleset").withArgs("DJZS-PM-v0.9");
    await expect(rule.score(tally(PM, ["DJZS-S01"]))).to.be.revertedWithCustomError(rule, "UnknownCode").withArgs(PM, "DJZS-S01");
    await expect(rule.score(tally(LF, ["DJZS-M01"]))).to.be.revertedWithCustomError(rule, "UnknownCode").withArgs(LF, "DJZS-M01");
    await expect(rule.score(tally(LF, ["DJZS-E01", "DJZS-E01"]))).to.be.revertedWithCustomError(rule, "DuplicateCode").withArgs("DJZS-E01");
    await expect(rule.score(tally(PM, ["djzs-m01"]))).to.be.revertedWithCustomError(rule, "UnknownCode");
    await expect(rule.verdictString(0)).to.be.revertedWithCustomError(rule, "InvalidVerdictCode").withArgs(0);
    await expect(rule.verdictString(4)).to.be.revertedWithCustomError(rule, "InvalidVerdictCode").withArgs(4);
  });

  it("weightOf never mistakes an unknown code for a zero weight", async function () {
    const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
    let [w, critical, known] = await rule.weightOf(id(PM), id("DJZS-M01"));
    expect([Number(w), critical, known]).to.deep.equal([30, true, true]);
    [w, critical, known] = await rule.weightOf(id(LF), id("DJZS-T01"));
    expect([Number(w), critical, known]).to.deep.equal([12, false, true]);
    [w, critical, known] = await rule.weightOf(id(LF), id("DJZS-M01"));
    expect([Number(w), critical, known]).to.deep.equal([0, false, false]);
    [w, critical, known] = await rule.weightOf(id("other"), id("DJZS-M01"));
    expect([Number(w), critical, known]).to.deep.equal([0, false, false]);
  });

  it("isConsistent is exact on both fields", async function () {
    const t = tally(PM, ["DJZS-M03", "DJZS-M04"]);
    expect(await rule.isConsistent(t, 40, "FAIL")).to.equal(true);
    expect(await rule.isConsistent(t, 40, "PASS")).to.equal(false);
    expect(await rule.isConsistent(t, 39, "FAIL")).to.equal(false);
    expect(await rule.isConsistent(t, 40, "fail")).to.equal(false);
  });
});
