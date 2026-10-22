import { parseAbi } from "viem"

/** The subset of PatronVault v1.1 (src/PatronVault.sol) the keeper and the page use. Kept by hand; any
 *  signature here is verified against the compiled artifact by test/abi.test.ts. */
export const vaultAbi = parseAbi([
  // config
  "function asset() view returns (address)",
  "function source() view returns (address)",
  "function minDeposit() view returns (uint256)",
  "function period() view returns (uint256)",
  "function termsHash() view returns (bytes32)",
  "function maxTotalPrincipal() view returns (uint256)",
  "function joinDeadline() view returns (uint256)",
  "function yieldSink() view returns (address)",
  "function feeBps() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function creatorRegistry() view returns (address)",
  "function settleInterval() view returns (uint256)",
  "function FUNDED_BPS() view returns (uint256)",
  "function MAX_ROUTES() view returns (uint256)",
  "function PAYOUT_GAS() view returns (uint256)",
  // state
  "function totalPrincipal() view returns (uint256)",
  "function memberCount() view returns (uint256)",
  "function feeShares() view returns (uint256)",
  "function sinkShares() view returns (uint256)",
  "function creatorPaid(address) view returns (uint256)",
  "function creatorMin(address) view returns (uint256)",
  "function memberOf(address member) view returns ((uint128 principal, uint128 shares, uint64 joinedAt, uint64 lastSettled, bool funded))",
  "function routesOf(address member) view returns ((address creator, uint96 amountPerPeriod, uint256 carry)[])",
  "function isPatron(address creator, address member) view returns (bool)",
  "function isPatronAtLeast(address creator, address member, uint256 minAmountPerPeriod) view returns (bool)",
  "function positionValue(address member) view returns (uint256)",
  "function inShortfall(address member) view returns (bool)",
  "function previewSettle(address member) view returns (uint256 owed, uint256 fromYield, uint256 pay)",
  // member actions
  "function join(uint256 amount, bytes32 terms)",
  "function joinAndRoute(uint256 amount, bytes32 terms, (address creator, uint96 amountPerPeriod)[] routes)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function leave()",
  "function setRoute(address creator, uint96 amountPerPeriod)",
  // keeper
  "function settle(address member)",
  "function settleMany(address[] members)",
  "function forwardSink() returns (uint256)",
  // events
  "event Joined(address indexed member, uint256 principal, uint256 shares, bytes32 termsHash)",
  "event Left(address indexed member, uint256 principal, uint256 received)",
  "event Settled(address indexed member, uint256 owed, uint256 fromYield, uint256 paid, bool funded)",
  "event CreatorPaid(address indexed creator, address indexed member, uint256 amount)",
  // errors the page decodes
  "error BadTerms()",
  "error AlreadyMember()",
  "error NotMember()",
  "error BelowMinimum()",
  "error ExceedsPrincipal()",
  "error ExceedsYield()",
  "error TooManyRoutes()",
  "error BelowCreatorMinimum()",
  "error ZeroAddress()",
  "error SelfRoute()",
  "error OwedButIlliquid()",
  "error CapReached()",
  "error JoinClosed()",
  "error YieldNotClaimable()",
  "error Reentrancy()",
  "error TransferFailed()",
  "error Overflow()",
  "error InvalidRecipient()",
  "error SettleTooSoon()",
  "error InsufficientGas()",
  "error SourceOutOfGas()",
  "error CreatorNotAllowed()",
  "error NothingParked()",
])

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
])

export const erc4626Abi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
])
