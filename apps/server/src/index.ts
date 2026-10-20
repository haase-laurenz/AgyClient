import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgyServer } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const HOST = process.env.AGYCLIENT_HOST || '127.0.0.1';
const INITIAL_PORT = Number(process.env.AGYCLIENT_PORT || 3000);

const instance = createAgyServer({
  defaultWorkspacePath: repoRoot,
  staticDir: path.join(repoRoot, 'apps', 'web', 'dist'),
  apiToken: process.env.AGYCLIENT_TOKEN,
});

function startListening(port: number, maxRetries = 10): void {
  const onError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && maxRetries > 0) {
      console.warn(`Port ${port} is in use on ${HOST}, trying port ${port + 1}...`);
      instance.server.removeListener('error', onError);
      startListening(port + 1, maxRetries - 1);
      return;
    }
    console.error('Failed to start AgyClient server:', err);
    process.exit(1);
  };

  instance.server.once('error', onError);
  instance.server.listen(port, HOST, () => {
    instance.server.removeListener('error', onError);
    console.log(`========================================================`);
    console.log(`  AgyClient Control Center running at http://${HOST}:${port}`);
    console.log(`  WebSocket live stream bound to ws://${HOST}:${port}/ws`);
    console.log(`========================================================`);
  });
}

// Prevent WebSocketServer from throwing unhandled error when http.Server emits EADDRINUSE
instance.wss.on('error', () => {
  // Handled by instance.server error listener
});

startListening(INITIAL_PORT);

const shutdown = async () => {
  console.log('\nShutting down AgyClient server and active agent processes...');
  await instance.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
