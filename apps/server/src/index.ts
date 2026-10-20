import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgyServer } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const HOST = process.env.AGYCLIENT_HOST || '127.0.0.1';
const PORT = Number(process.env.AGYCLIENT_PORT || 3000);

const instance = createAgyServer({
  defaultWorkspacePath: repoRoot,
  staticDir: path.join(repoRoot, 'apps', 'web', 'dist'),
  apiToken: process.env.AGYCLIENT_TOKEN,
});

instance.server.listen(PORT, HOST, () => {
  console.log(`========================================================`);
  console.log(`  AgyClient Control Center running at http://${HOST}:${PORT}`);
  console.log(`  WebSocket live stream bound to ws://${HOST}:${PORT}/ws`);
  console.log(`========================================================`);
});

const shutdown = async () => {
  console.log('\nShutting down AgyClient server and active agent processes...');
  await instance.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
