const baseUrl = process.env.LOCAL_BASE_URL || "http://localhost:5050";

const checks = [
  ["/api/health", (body) => body?.ok === true],
  ["/api/audit/schema", (body) => body?.service && body?.version],
  ["/api/stream/config", (body) => typeof body?.configured === "boolean"],
];

for (const [path, validate] of checks) {
  const url = new URL(path, baseUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  const body = await response.json();
  if (!validate(body)) {
    throw new Error(`${path} returned an unexpected response shape`);
  }

  console.log(`ok ${path}`);
}
