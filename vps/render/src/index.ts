/**
 * Entry point: bind the render service to loopback only.
 *
 * Nothing on this box has a public listener. Traffic arrives through a
 * Cloudflare Tunnel that connects OUT from the machine, so 127.0.0.1 is the
 * whole attack surface. The box is shared with other services, which is exactly
 * why this binds loopback and carries its own bearer token.
 */
import { createApp } from "./app.js";
import { CONFIG } from "./config.js";
import { shutdown } from "./sessions.js";

const app = createApp();

const server = app.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`jobarms-render listening on 127.0.0.1:${CONFIG.port}`);
});

/**
 * Close sessions on the way down so Chromium never outlives the service and
 * leaks memory on a 4GB box.
 */
async function stop(signal: string): Promise<void> {
  console.log(`jobarms-render received ${signal}, shutting down`);
  server.close();
  await shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
