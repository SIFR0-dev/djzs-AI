#!/bin/zsh
BASE="https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"
OFFSET=0; PAGE=1; FOUND=0; TOTAL=1
while [ "$OFFSET" -lt "$TOTAL" ]; do
  RESP=$(curl -s "${BASE}?limit=1000&offset=${OFFSET}")
  TOTAL=$(printf '%s' "$RESP" | jq -r '.pagination.total // 0')
  N=$(printf '%s' "$RESP" | jq '.items|length')
  H=$(printf '%s' "$RESP" | grep -ci 'djzs')
  T=$(printf '%s' "$RESP" | grep -ci 'c1923748669dFC3a79497d0403A90a275161eCCA')
  echo "page $PAGE offset=$OFFSET/$TOTAL: items=$N djzs=$H treasury=$T"
  if [ "$H" -gt 0 ] || [ "$T" -gt 0 ]; then
    FOUND=1
    printf '%s' "$RESP" | jq '.items[] | select(tostring | ascii_downcase | (contains("djzs") or contains("c1923748669dfc3a79497d0403a90a275161ecca")))'
  fi
  OFFSET=$((OFFSET+1000)); PAGE=$((PAGE+1))
  [ "$PAGE" -gt 30 ] && { echo "SAFETY CAP"; break; }
  [ "$N" -eq 0 ] && break
done
echo "$(date -u +%FT%TZ) BAZAAR_SCAN total=$TOTAL listing_found=$FOUND" >> EVIDENCE.log
echo "DONE total=$TOTAL listing_found=$FOUND (logged)"
