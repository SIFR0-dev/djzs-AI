// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title DJZSProofOfLogicNFT
 * @notice Fully on-chain ERC721. The complete ProofOfLogic certificate from Irys
 *         is stored in contract storage and returned as a base64 data-URI in tokenURI().
 *         The NFT IS the certificate — not a pointer to it.
 *         Minted only on PASS verdicts.
 */
contract DJZSProofOfLogicNFT is ERC721, Ownable {
    using Strings for uint256;

    uint256 private _nextTokenId;

    struct Certificate {
        string auditId;
        string timestamp;
        string tier;
        uint256 riskScore;
        string verdict;
        string flagsJson;        // JSON array string, e.g. '["DJZS-I01","DJZS-X01"]'
        string cryptographicHash;
        string irysTxId;
        string irysUrl;
        string certificateJson;  // Full raw certificate JSON from Irys
        uint256 mintedAt;
    }

    /// @dev tokenId → full certificate
    mapping(uint256 => Certificate) public certificates;

    /// @dev irysTxId → tokenId (prevents double-mint)
    mapping(string => uint256) public irysToToken;

    /// @dev Authorized minters (server wallet)
    mapping(address => bool) public authorizedMinters;

    event ProofMinted(
        uint256 indexed tokenId,
        address indexed recipient,
        string auditId,
        string irysTxId,
        string tier,
        uint256 riskScore
    );

    event MinterAuthorized(address indexed minter);
    event MinterRevoked(address indexed minter);

    error AlreadyMinted(string irysTxId);
    error NotAuthorizedMinter();
    error EmptyField();
    error VerdictNotPass();

    modifier onlyMinter() {
        if (!authorizedMinters[msg.sender] && msg.sender != owner()) {
            revert NotAuthorizedMinter();
        }
        _;
    }

    constructor() ERC721("DJZS ProofOfLogic", "DJZS-POL") Ownable(msg.sender) {
        authorizedMinters[msg.sender] = true;
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function authorizeMinter(address minter) external onlyOwner {
        authorizedMinters[minter] = true;
        emit MinterAuthorized(minter);
    }

    function revokeMinter(address minter) external onlyOwner {
        authorizedMinters[minter] = false;
        emit MinterRevoked(minter);
    }

    // ─── Mint ────────────────────────────────────────────────────────

    /**
     * @notice Mint with the full certificate JSON stored on-chain.
     * @param recipient       Wallet receiving the NFT
     * @param auditId         Audit UUID
     * @param timestamp       ISO 8601 timestamp
     * @param tier            "micro" | "founder" | "treasury"
     * @param riskScore       0-100
     * @param verdict         "PASS" (only PASS gets minted)
     * @param flagsJson       JSON array of flag codes (empty array "[]" for PASS)
     * @param cryptographicHash  SHA-256 of the strategy memo
     * @param irysTxId        Irys Datachain transaction ID
     * @param irysUrl         Full Irys gateway URL
     * @param certificateJson Full raw certificate JSON blob from Irys
     */
    function mint(
        address recipient,
        string calldata auditId,
        string calldata timestamp,
        string calldata tier,
        uint256 riskScore,
        string calldata verdict,
        string calldata flagsJson,
        string calldata cryptographicHash,
        string calldata irysTxId,
        string calldata irysUrl,
        string calldata certificateJson
    ) external onlyMinter returns (uint256 tokenId) {
        if (bytes(irysTxId).length == 0) revert EmptyField();
        if (bytes(auditId).length == 0) revert EmptyField();
        if (bytes(certificateJson).length == 0) revert EmptyField();
        if (keccak256(bytes(verdict)) != keccak256(bytes("PASS"))) revert VerdictNotPass();
        if (irysToToken[irysTxId] != 0) revert AlreadyMinted(irysTxId);

        tokenId = ++_nextTokenId;

        certificates[tokenId] = Certificate({
            auditId: auditId,
            timestamp: timestamp,
            tier: tier,
            riskScore: riskScore,
            verdict: verdict,
            flagsJson: flagsJson,
            cryptographicHash: cryptographicHash,
            irysTxId: irysTxId,
            irysUrl: irysUrl,
            certificateJson: certificateJson,
            mintedAt: block.timestamp
        });

        irysToToken[irysTxId] = tokenId;
        _safeMint(recipient, tokenId);

        emit ProofMinted(tokenId, recipient, auditId, irysTxId, tier, riskScore);
    }

    // ─── On-Chain Metadata ───────────────────────────────────────────

    /**
     * @notice Returns a fully on-chain ERC721 metadata JSON as a data-URI.
     *         The `certificate` attribute contains the entire ProofOfLogic
     *         certificate — the same data that lives on Irys, now also on Base.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Certificate storage cert = certificates[tokenId];

        // Build SVG image on-chain
        string memory svg = _generateSvg(cert);
        string memory svgBase64 = Base64.encode(bytes(svg));

        // Build ERC721 metadata JSON
        string memory json = string.concat(
            '{"name":"DJZS ProofOfLogic #', tokenId.toString(),
            '","description":"Adversarial logic audit certificate. Verdict: ', cert.verdict,
            '. Risk Score: ', cert.riskScore.toString(),
            '/100. Tier: ', cert.tier,
            '. Permanently anchored on Irys Datachain and Base Mainnet."',
            ',"image":"data:image/svg+xml;base64,', svgBase64, '"',
            ',"external_url":"', cert.irysUrl, '"',
            ',"attributes":[',
                '{"trait_type":"Verdict","value":"', cert.verdict, '"},',
                '{"trait_type":"Risk Score","display_type":"number","value":', cert.riskScore.toString(), '},',
                '{"trait_type":"Tier","value":"', cert.tier, '"},',
                '{"trait_type":"Audit ID","value":"', cert.auditId, '"},',
                '{"trait_type":"Irys TX","value":"', cert.irysTxId, '"},',
                '{"trait_type":"Cryptographic Hash","value":"', cert.cryptographicHash, '"},',
                '{"trait_type":"Timestamp","value":"', cert.timestamp, '"}',
            ']',
            ',"certificate":', cert.certificateJson,
            '}'
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ─── On-Chain SVG ────────────────────────────────────────────────

    function _generateSvg(Certificate storage cert) internal view returns (string memory) {
        string memory verdictColor = keccak256(bytes(cert.verdict)) == keccak256(bytes("PASS"))
            ? "#4ade80"  // green-400
            : "#f87171"; // red-400

        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500" style="background:#0a0a0a">',
            '<style>text{font-family:monospace;fill:#a1a1aa}',
            '.h{fill:', verdictColor, '}.d{fill:#52525b;font-size:10px}',
            '.v{font-size:48px;fill:', verdictColor, '}.t{font-size:11px}</style>',

            // Header
            '<text x="20" y="30" class="d">// DJZS PROOF-OF-LOGIC CERTIFICATE</text>',
            '<text x="20" y="50" class="d">// BASE MAINNET | IRYS DATACHAIN</text>',
            '<line x1="20" y1="60" x2="380" y2="60" stroke="#27272a" stroke-width="1"/>',

            // Verdict
            '<text x="200" y="130" text-anchor="middle" class="v">', cert.verdict, '</text>',
            '<text x="200" y="160" text-anchor="middle" class="t" fill="#71717a">RISK SCORE: ', cert.riskScore.toString(), '/100</text>',

            // Divider
            '<line x1="20" y1="185" x2="380" y2="185" stroke="#27272a" stroke-width="1"/>',

            // Details
            '<text x="20" y="210" class="t">AUDIT ID</text>',
            '<text x="20" y="228" class="t" fill="#e4e4e7">', _truncate(cert.auditId, 36), '</text>',

            '<text x="20" y="258" class="t">TIER</text>',
            '<text x="20" y="276" class="t h">', _toUpper(cert.tier), '</text>',

            '<text x="200" y="258" class="t">TIMESTAMP</text>',
            '<text x="200" y="276" class="t" fill="#e4e4e7">', _truncate(cert.timestamp, 20), '</text>',

            '<text x="20" y="306" class="t">IRYS TX</text>',
            '<text x="20" y="324" class="t" fill="#e4e4e7">', _truncate(cert.irysTxId, 44), '</text>',

            '<text x="20" y="354" class="t">HASH</text>',
            '<text x="20" y="372" class="t" fill="#e4e4e7">', _truncate(cert.cryptographicHash, 44), '</text>',

            // Footer
            '<line x1="20" y1="410" x2="380" y2="410" stroke="#27272a" stroke-width="1"/>',
            '<text x="20" y="435" class="d">PROVENANCE: IRYS_DATACHAIN</text>',
            '<text x="20" y="455" class="d">PROTOCOL: DJZS ADVERSARIAL LOGIC FIREWALL</text>',
            '<text x="20" y="475" class="d">djzs.ai | No agent acts without audit.</text>',

            '</svg>'
        );
    }

    // ─── String Helpers ──────────────────────────────────────────────

    function _truncate(string memory s, uint256 maxLen) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length <= maxLen) return s;
        bytes memory result = new bytes(maxLen);
        for (uint256 i = 0; i < maxLen; i++) {
            result[i] = b[i];
        }
        return string(result);
    }

    function _toUpper(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x61 && b[i] <= 0x7a) {
                b[i] = bytes1(uint8(b[i]) - 32);
            }
        }
        return string(b);
    }

    // ─── Views ───────────────────────────────────────────────────────

    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    /**
     * @notice Returns the raw certificate JSON stored on-chain.
     *         This is the same data that was uploaded to Irys.
     */
    function getRawCertificate(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        return certificates[tokenId].certificateJson;
    }

    function getTokenByIrys(string calldata irysTxId) external view returns (uint256) {
        return irysToToken[irysTxId];
    }
}
