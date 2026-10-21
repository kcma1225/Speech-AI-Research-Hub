// Docker HEALTHCHECK: exit 0 when the worker's loopback /health reports ok.
const port = process.env.HEALTH_PORT ?? "8080";
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
