# Summary

* [DJZS](README.md)
* [Quickstart](quickstart.md)

## For agents

* [Free check: one POST](agents/free-check.md)
* [MCP server](agents/mcp.md)
* [Paid check over HTTP](agents/paid-http.md)
* [Discovery](agents/discovery.md)

## How a verdict is made

* [Verdicts](concepts/verdicts.md)
* [Rulesets](concepts/rulesets.md)
* [Extraction](concepts/extraction.md)
* [Receipts and certificates](concepts/receipts.md)
* [Worked example: a perp trade, FAIL to PASS](examples/perp-worked-example.md)

## Reference

* [verify\_pm\_trade](reference/verify-pm-trade.md)
* [verify\_perp\_trade](reference/verify-perp-trade.md)
* [query\_agent\_trust and query\_pol\_certificates](reference/registry-tools.md)

## HTTP API

* ```yaml
  type: builtin:openapi
  props:
    models: false
    downloadLink: true
  dependencies:
    spec:
      ref:
        kind: openapi
        spec: djzs
  ```

## Evidence

* [What is measured](measured.md)
* [Disclosures and corrections](disclosures.md)
