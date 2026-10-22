PatronVault member terms, version 1.1

What you are doing

You deposit USDC into the PatronVault contract on Base. The contract places your deposit in one yield source, a lending vault named in the contract and fixed at deployment. It pays only the interest your deposit earns, and only to the creators you choose, at the amount per 30 days you set for each one.

What the contract enforces

1. We never spend your deposit. No function in the contract pays a creator, or anyone else, out of the shares that back your deposit.

2. Only the interest your deposit earns is paid out, and only to creators you have routed it to yourself, at the amounts you set. Interest beyond what you route stays in the contract as a buffer for your routes. You never receive interest: when you leave, any buffer goes to the creators you were routing to, or to the vault's named fallback address if you had no routes. The yield source counts in whole millionths of a USDC and rounds; a withdrawal or an exit can leave a few such units with you or with a creator. That is rounding, not a payment of interest. This vault accepts routes only to creators listed in the registry named in the contract.

3. A protocol fee of 5% (500 basis points) of each payment made to a creator is kept by the contract for its named fee recipient, DJZS AI, LLC. The fee comes out of the interest being paid in that payment, never out of your deposit, never out of interest that was not paid, and never out of the buffer that goes to creators when you leave. The rate is fixed at deployment and can never rise. The contract refuses to be deployed with a rate above 10%.

4. You can withdraw your deposit at any time, in part or in full. There is no lock, no notice period and no exit fee. A withdrawal that leaves less than the minimum deposit must take the whole deposit. A partial withdrawal can arrive a few millionths of a USDC short of the amount asked, for the same rounding; what is short stays in your position and comes back when you leave.

5. Nobody can change the rules after deployment. The contract has no owner, no pause switch, no upgrade path and no way to move your funds. The yield source is a separate protocol with its own governance and can pause or change itself; the contract cannot stop that, and what it means for you is in the next section.

6. Your position is separate from every other member's. Another member's payouts never come out of your deposit or your interest.

What the contract cannot promise

7. The yield source is a third-party lending protocol. If it loses money, every depositor in it loses the same share, and that loss is yours. The contract does not insure it and cannot undo it. Interest rates change every day and can fall to zero.

8. If your deposit does not earn enough to cover the amounts you routed, the creators receive less and your patron status with them lapses until it is covered again. The shortfall is not a debt. Nothing is ever taken from your deposit to make it up.

9. When the yield source cannot pay out on a given day, what is owed to a creator waits in the contract until it can. Your own withdrawals can also be delayed while the source is illiquid. When you leave and the source can pay your deposit but not also the buffer owed to your creators, your deposit comes back first and the buffer waits in the contract for the fallback address.

10. USDC is issued by Circle. Circle can freeze any address, including yours, a creator's or the yield source's. The contract cannot override that.

11. This is not a bank deposit, an investment product, insurance or a guarantee of any return. Nothing here is investment, legal or tax advice.

Consent and control

12. Joining is your consent to these terms. Your join transaction records the hash of this exact text. Every change to your routes and every withdrawal is a transaction signed only by you.

13. You set, change or remove each creator's amount per 30 days yourself, at any time. A creator can only set the smallest amount they accept for new routes. No creator can raise what you already route, and no one else can add a route to your deposit.
