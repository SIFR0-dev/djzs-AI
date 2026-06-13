import { Link } from "wouter";
import { C, MONO, TerminalPage, TerminalHeading, TerminalFooter } from "@/lib/terminal-theme";

export default function Security() {
  return (
    <TerminalPage>
      <header style={{ padding: "60px 0 40px", borderBottom: `1px solid ${C.border}`, marginBottom: 48 }}>
        <div
          style={{
            display: "inline-block", fontFamily: MONO, fontSize: 11, letterSpacing: "0.12em",
            textTransform: "uppercase", color: C.green, border: `1px solid ${C.green}33`,
            background: C.greenGlow, padding: "4px 12px", borderRadius: 2, marginBottom: 24,
          }}
          data-testid="tag-security-header"
        >
          DJZS Protocol — Security
        </div>
        <h1 style={{ fontSize: "clamp(28px, 5vw, 44px)", fontWeight: 700, lineHeight: 1.2, letterSpacing: "-0.02em", marginBottom: 12, color: C.white }}>
          Security
        </h1>
        <p style={{ fontSize: 14, color: C.textDim, maxWidth: 720 }}>
          How DJ-Z-S.box protects your privacy and keeps you in control.
        </p>
      </header>

      <div style={{ padding: "16px 20px", background: `${C.green}10`, border: `1px solid ${C.green}33`, borderLeft: `3px solid ${C.green}`, borderRadius: 4, marginBottom: 48, fontSize: 13, lineHeight: 1.8 }}>
        <strong style={{ color: C.white }}>Our Security Commitment:</strong>{" "}
        <span style={{ color: C.text }}>DJ-Z-S.box does not store private keys, custody assets, or initiate transactions on behalf of users. Wallet connections are used only with explicit user consent for authentication purposes.</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 40, marginBottom: 64 }}>
        <section>
          <TerminalHeading num="01">No Custody, No Risk</TerminalHeading>
          <p style={{ color: C.text, fontSize: 14, lineHeight: 1.8, marginBottom: 12 }}>
            DJ-Z-S.box is a <strong style={{ color: C.white }}>non-custodial</strong> application. This means:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              ["never", "have access to your private keys or seed phrases"],
              ["cannot", "move, transfer, or access your funds"],
              ["do not", "initiate any transactions automatically"],
              ["only", "use your wallet for authentication (signing messages)"],
            ].map(([verb, rest]) => (
              <div key={verb} style={{ display: "flex", gap: 8, fontSize: 13, color: C.text }}>
                <span style={{ color: C.green, flexShrink: 0 }}>✓</span>
                <span>We <strong style={{ color: C.white }}>{verb}</strong> {rest}</span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <TerminalHeading num="02">Local-First Architecture</TerminalHeading>
          <div style={{ display: "grid", gap: 8 }}>
            {[
              { title: "Data Stays on Your Device", desc: "All audit records, research notes, and memories are stored in your browser's IndexedDB. This data never leaves your device unless you explicitly deploy an audit or export it.", color: C.green },
              { title: "Works Offline", desc: "The core Architect Console functionality works without an internet connection. Your reasoning doesn't depend on our servers being online.", color: C.green },
              { title: "No Server-Side Storage", desc: "We do not permanently store your personal data, audit records, or research on any server. When you deploy an audit, your reasoning trace is sent to Venice AI over HTTPS/TLS (not E2E encrypted). Venice claims no data retention.", color: C.amber },
            ].map((item) => (
              <div key={item.title} style={{ padding: "14px 18px", background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${item.color}`, borderRadius: 4 }}>
                <h3 style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.white, marginBottom: 6 }}>{item.title}</h3>
                <p style={{ fontSize: 12, color: C.text, lineHeight: 1.7 }}>{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <TerminalHeading num="03">User-Initiated Actions Only</TerminalHeading>
          <p style={{ color: C.text, fontSize: 14, lineHeight: 1.8, marginBottom: 12 }}>
            Every action in DJ-Z-S.box requires your explicit consent:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              ["Wallet connection", "Only happens when you click \"Connect Wallet\""],
              ["AI queries", "Only sent when you explicitly ask for insights"],
              ["Web searches", "Only performed when you initiate a research query"],
              ["No background requests", "Nothing happens without visible user action"],
            ].map(([label, desc]) => (
              <div key={label} style={{ display: "flex", gap: 8, fontSize: 13, color: C.text }}>
                <span style={{ color: C.amber, flexShrink: 0 }}>▸</span>
                <span><strong style={{ color: C.white }}>{label}</strong> — {desc}</span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <TerminalHeading num="04">Wallet Security</TerminalHeading>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ padding: "14px 18px", background: C.surface, border: `1px solid ${C.green}33`, borderLeft: `3px solid ${C.green}`, borderRadius: 4 }}>
              <h3 style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 8 }}>What Wallet Connection Does</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {[
                  "Reads your public address (already public on the blockchain)",
                  "May request message signing for authentication (requires your approval)",
                  "Resolves your ENS name for display (if you have one)",
                ].map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: C.text }}>
                    <span style={{ color: C.green, flexShrink: 0 }}>▸</span>
                    {item}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: "14px 18px", background: C.surface, border: `1px solid ${C.red}33`, borderLeft: `3px solid ${C.red}`, borderRadius: 4 }}>
              <h3 style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.red, marginBottom: 8 }}>What Wallet Connection Does NOT Do</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {[
                  "Does not access your private keys",
                  "Does not request transaction permissions",
                  "Does not approve any token spending",
                  "Does not interact with smart contracts automatically",
                ].map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: C.text }}>
                    <span style={{ color: C.red, flexShrink: 0 }}>✗</span>
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section>
          <TerminalHeading num="05">Two Communication Channels</TerminalHeading>
          <p style={{ color: C.text, fontSize: 14, lineHeight: 1.8, marginBottom: 16 }}>
            DJZS uses two distinct communication channels with different security properties.
          </p>
          <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
            <div style={{ padding: "16px 20px", background: C.surface, border: `1px solid ${C.green}33`, borderLeft: `3px solid ${C.green}`, borderRadius: 4 }}>
              <h3 style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 8 }}>Channel A: XMTP Messaging (E2E Encrypted)</h3>
              <p style={{ fontSize: 12, color: C.text, lineHeight: 1.7, marginBottom: 8 }}>Communication between you and the DJZS agent uses the XMTP network.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {[
                  "Messages are encrypted client-side — only you and the recipient can read them",
                  "MLS protocol with forward secrecy and post-compromise security",
                  "XWING KEM quantum-resistant key encapsulation on Welcome messages",
                  "Distributed across a censorship-resistant network of nodes",
                ].map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: C.text }}>
                    <span style={{ color: C.green, flexShrink: 0 }}>✓</span>
                    {item}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: "16px 20px", background: C.surface, border: `1px solid ${C.amber}33`, borderLeft: `3px solid ${C.amber}`, borderRadius: 4 }}>
              <h3 style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.amber, marginBottom: 8 }}>Channel B: Venice AI Inference (HTTPS/TLS)</h3>
              <p style={{ fontSize: 12, color: C.text, lineHeight: 1.7, marginBottom: 8 }}>When you deploy an audit, the reasoning trace is sent to Venice for adversarial analysis.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {[
                  { text: "Data is encrypted in transit via HTTPS/TLS", ok: true },
                  { text: "Venice claims no data retention and no training on your inputs", ok: true },
                  { text: "This is not end-to-end encrypted — Venice must see your plaintext prompt", ok: false },
                  { text: "Quantum resistance does not apply to Venice API calls", ok: false },
                ].map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: C.text }}>
                    <span style={{ color: item.ok ? C.green : C.amber, flexShrink: 0 }}>{item.ok ? "✓" : "⚠"}</span>
                    {item.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ padding: "12px 16px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, color: C.text }}>
            <strong style={{ color: C.white }}>In short:</strong> XMTP handles messaging with full E2E encryption. Venice handles AI inference over standard HTTPS — encrypted in transit but not end-to-end.
          </div>
        </section>

        <section>
          <TerminalHeading num="06">AI Provider Privacy</TerminalHeading>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              ["Venice AI", "Claims no data retention or training on your inputs. Prompt sent over HTTPS/TLS (not E2E encrypted)"],
              ["Irys Datachain", "Permanent, immutable audit provenance with public verification"],
              ["Minimal transmission", "Only the current entry + memory context is sent, not your entire history"],
              ["User-initiated only", "Nothing is sent unless you explicitly deploy an audit or run a research query"],
            ].map(([label, desc]) => (
              <div key={label} style={{ display: "flex", gap: 8, fontSize: 13, color: C.text }}>
                <span style={{ color: C.green, flexShrink: 0 }}>✓</span>
                <span><strong style={{ color: C.white }}>{label}</strong> — {desc}</span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <TerminalHeading num="07">A2A Audit API Security</TerminalHeading>
          <p style={{ color: C.text, fontSize: 14, lineHeight: 1.8, marginBottom: 12 }}>
            The DJZS audit API (<code style={{ fontFamily: MONO, fontSize: 12, color: C.green, background: `${C.green}15`, padding: "2px 6px", borderRadius: 2 }}>POST /api/audit</code>) security properties:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              ["x402 Payment Gate", "Every audit request must include a valid x402 payment header (USDC on Base). Requests without payment receive HTTP 402."],
              ["SHA-256 Cryptographic Hashing", "Every input memo is hashed. The hash is returned in the audit response for on-chain verification."],
              ["Zod Schema Validation", "All request inputs and audit outputs are validated against strict Zod schemas."],
              ["No Data Retention", "Strategy memos are processed in real-time and not stored."],
              ["Structured Output", "Audit responses are machine-readable JSON with typed fields."],
              ["EigenCompute TEE Hardware Enclave", "The Oracle runs inside an EigenCompute Intel TDX CVM. Private keys are isolated in hardware."],
              ["Irys Datachain Provenance", "Every audit certificate is permanently uploaded to Irys Datachain."],
            ].map(([label, desc]) => (
              <div key={label} style={{ display: "flex", gap: 8, fontSize: 13, color: C.text }}>
                <span style={{ color: C.green, flexShrink: 0 }}>✓</span>
                <span><strong style={{ color: C.white }}>{label}</strong> — {desc}</span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <TerminalHeading num="07b">Trusted Execution Environment (TEE)</TerminalHeading>
          <p style={{ color: C.text, fontSize: 14, lineHeight: 1.8, marginBottom: 16 }}>
            The DJZS Oracle is deployed inside an <strong style={{ color: C.white }}>EigenCompute Intel TDX Confidential Virtual Machine (CVM)</strong> — a hardware-isolated enclave:
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ padding: "16px 20px", background: C.surface, border: `1px solid ${C.green}33`, borderLeft: `3px solid ${C.green}`, borderRadius: 4 }}>
              <h3 style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 8 }}>Hardware-Isolated Secret Management</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {[
                  "Venice AI API key — Stored inside the TEE, never exposed to the host",
                  "Irys wallet private key — Used to sign and upload certificates, isolated in hardware",
                  "x402 payment verification keys — Payment gate secrets never touch disk",
                  "Remote attestation — CVM produces cryptographic attestation proving code integrity",
                ].map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: C.text }}>
                    <span style={{ color: C.green, flexShrink: 0 }}>✓</span>
                    {item}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: "16px 20px", background: C.surface, border: `1px solid ${C.amber}33`, borderLeft: `3px solid ${C.amber}`, borderRadius: 4 }}>
              <h3 style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.amber, marginBottom: 8 }}>Irys Datachain: Immutable Certificate Storage</h3>
              <p style={{ fontSize: 12, color: C.text, lineHeight: 1.7, marginBottom: 8 }}>After the Oracle completes an audit, the ProofOfLogic certificate is permanently uploaded to Irys Datachain.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {[
                  "Permanent storage — Certificates cannot be deleted or modified after upload",
                  "Public verification — Anyone can verify via the Irys gateway URL",
                  "Provenance chain — Each certificate includes irys_tx_id, irys_url, input hash, and timestamp",
                ].map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: C.text }}>
                    <span style={{ color: C.green, flexShrink: 0 }}>✓</span>
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ padding: "12px 16px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, color: C.text, marginTop: 12 }}>
            <strong style={{ color: C.white }}>Security guarantee:</strong> The TEE ensures that even the DJZS operator cannot extract private keys or tamper with the audit pipeline. Combined with Irys immutability, this creates a verifiable trust chain from audit request → AI inference → permanent certificate.
          </div>
        </section>

        <section>
          <TerminalHeading num="09">Security Best Practices</TerminalHeading>
          <p style={{ color: C.text, fontSize: 14, lineHeight: 1.8, marginBottom: 12 }}>
            To maximize your security while using DJ-Z-S.box:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              "Use a hardware wallet for the strongest protection",
              "Never share your seed phrase with anyone",
              "Verify the URL is dj-z-s.box before connecting",
              "Keep your browser and wallet software updated",
              "Disconnect your wallet when not actively using the app",
            ].map((item, i) => (
              <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, color: C.text }}>
                <span style={{ color: C.green, flexShrink: 0 }}>▸</span>
                {item}
              </div>
            ))}
          </div>
        </section>

        <section>
          <TerminalHeading num="10">Report a Vulnerability</TerminalHeading>
          <p style={{ color: C.text, fontSize: 14, lineHeight: 1.8 }}>
            If you discover a security vulnerability, please report it responsibly through our
            official channels. We take all security reports seriously and will respond promptly.
          </p>
        </section>
      </div>

      <div style={{ textAlign: "center", padding: "24px 0 40px", borderTop: `1px solid ${C.border}` }}>
        <p style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: C.textMuted }}>
          © 2026 DJZS SYSTEM / SECURITY THROUGH SIMPLICITY
        </p>
      </div>

      <TerminalFooter />
    </TerminalPage>
  );
}
