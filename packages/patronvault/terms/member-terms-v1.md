PatronVault member terms, version 1

What you are doing

You deposit USDC into the PatronVault contract on Base. The contract places your deposit in one yield source, a lending vault named in the contract and fixed at deployment. It pays only the interest your deposit earns, and only to the creators you choose, at the amount per 30 days you set for each one.

What the contract enforces

1. We never spend your deposit. No function in the contract pays a creator, or anyone else, out of the shares that back your deposit.

2. Only the interest your deposit earns is paid out, and only to creators you have routed it to yourself, at the amounts you set. Interest beyond what you route stays in the contract as a buffer for your routes. You never receive interest: when you leave, any buffer goes to the creators you were routing to, or to the vault's named fallback address if you had no routes.

3. You can withdraw your deposit at any time, in part or in full. There is no lock, no notice period and no exit fee. A withdrawal that leaves less than the minimum deposit must take the whole deposit.

4. Nobody can change the rules after deployment. The contract has no owner, no pause switch, no upgrade path and no way to move your funds.

5. Your position is separate from every other member's. Another member's payouts never come out of your deposit or your interest.

What the contract cannot promise

6. The yield source is a third-party lending protocol. If it loses money, every depositor in it loses the same share, and that loss is yours. The contract does not insure it and cannot undo it. Interest rates change every day and can fall to zero.

7. If your deposit does not earn enough to cover the amounts you routed, the creators receive less and your patron status with them lapses until it is covered again. The shortfall is not a debt. Nothing is ever taken from your deposit to make it up.

8. When the yield source cannot pay out on a given day, what is owed to a creator waits in the contract until it can. Your own withdrawals and claims can also be delayed while the source is illiquid.

9. USDC is issued by Circle. Circle can freeze any address, including yours, a creator's or the yield source's. The contract cannot override that.

10. This is not a bank deposit, an investment product, insurance or a guarantee of any return. Nothing here is investment, legal or tax advice.

Consent and control

11. Joining is your consent to these terms. Your join transaction records the hash of this exact text. Every change to your routes, every claim and every withdrawal is a transaction signed only by you.

12. You set, change or remove each creator's amount per 30 days yourself, at any time. A creator can only set the smallest amount they accept for new routes. No creator can raise what you already route, and no one else can add a route to your deposit.
