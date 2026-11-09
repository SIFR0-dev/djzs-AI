import { describe, it, expect } from "vitest";
import { lcrBlocked, quoteSpan, norm, capture } from "./source-capture";

describe("source-capture rails (offline)", () => {
  it("refuses LCR-prohibited hosts before any request", () => {
    expect(lcrBlocked("https://www.bls.gov/news.release/cpi.nr0.htm")).toMatch(/capture by hand/);
    expect(lcrBlocked("https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm")).toMatch(/451/);
    expect(lcrBlocked("https://polymarket.com/event/fed-decision")).toMatch(/prohibited/);
    expect(lcrBlocked("https://kalshi.com/markets/kxfed")).toMatch(/prohibited/);
    expect(lcrBlocked("https://news.google.com/rss/search?q=x")).toMatch(/prohibited/);
    expect(lcrBlocked("not a url")).toBe("not a URL");
  });
  it("allows ordinary news hosts", () => {
    expect(lcrBlocked("https://finance.yahoo.com/markets/crypto/articles/x.html")).toBeNull();
    expect(lcrBlocked("https://www.reuters.com/markets/x")).toBeNull();
    expect(lcrBlocked("https://sosovalue.com/news/x")).toBeNull();   // a .gov-looking token inside a path must not match
    expect(lcrBlocked("https://govtech.example.com/x")).toBeNull();  // "gov" as a host prefix is not the .gov TLD
  });
  it("quote gate: one contiguous span, whitespace and curly punctuation folded", () => {
    const page = "Fundstrat head of digital assets Sean Farrell called\n the move “important data worth respecting”, while noting Bitcoin — he said — has bucked the pattern.";
    expect(quoteSpan(page, 'called the move "important data worth respecting", while noting').found).toBe(true);
    expect(quoteSpan(page, "Bitcoin - he said - has bucked").found).toBe(true);
    expect(quoteSpan(page, "Sean Farrell has bucked the pattern").found).toBe(false); // two spans stitched = refused
    expect(norm("  a\t b ")).toBe("a b");
  });
  it("capture() refuses a blocked host without touching the network", async () => {
    await expect(capture("https://www.bls.gov/x", { key: "k" })).rejects.toThrow(/REFUSED/);
  });
});
