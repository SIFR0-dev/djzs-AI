---
# perp memo template for `node agent/refusal-agent.mjs --tool perp --intent <copy> --mode dry`
# Copy this file, fill every <placeholder>, dry-run, then carry the printed sha into --mode paid.
# The placeholders are not numbers, so this file itself always fails the field gate: it cannot be paid on.
# Field contract (see renderPerpWire): side is long|short; leverage and size_usd are bare numbers;
# entry/stop_loss/take_profit are prices ($ and thousands commas allowed); thesis, invalidation and
# data_sources must NOT end with '.', the render appends it. A stop is required: an unbounded memo is
# a defect you can see before paying, and this agent refuses to spend on what it can already see.
instrument: <BTC-PERP>
side: <long|short>
venue: <Hyperliquid>
leverage: <3>
size_usd: <300>
entry: <mark at run time, as read from the venue>
stop_loss: <level on the correct side of entry>
take_profit: <level, optional>
thesis: <why the price moves this way, over what horizon, on what evidence you read>
invalidation: <the observable condition that proves the thesis wrong, optional>
data_sources: <where each number above came from, with timestamps, optional>
---
Notes below the fence never reach the wire.
