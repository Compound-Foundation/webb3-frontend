/* eslint-env node */
// This child owns one Chromium. Playwright clients get separate connections and contexts; closing a client
// disconnects that client. The child closes Chromium when the runner stops or its IPC channel disconnects.
import fs from 'node:fs';
import tls from 'node:tls';

import { chromium } from 'playwright-core';

let browserServer;
let isStopping = false;
let launch;

async function stop() {
  if (isStopping) return;
  isStopping = true;
  // A stop during launch still owns the browser as soon as launch completes.
  await launch?.catch(() => undefined);
  if (browserServer !== undefined) {
    const force = setTimeout(() => void browserServer.kill().catch(() => undefined), 3000);
    try {
      await browserServer.close();
    } catch {
      await browserServer.kill().catch(() => undefined);
    } finally {
      clearTimeout(force);
    }
  }
  process.exit(0);
}

process.on('message', (message) => {
  if (message?.kind === 'stop') void stop();
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

try {
  // Remote route.fetch runs in this child. Trust exactly the run's certificate beside Node's defaults.
  const certificatePem = fs.readFileSync(process.argv[2], 'utf8');
  const certificates = tls.getCACertificates('default');
  if (!certificates.includes(certificatePem)) tls.setDefaultCACertificates([...certificates, certificatePem]);
  launch = chromium.launchServer({ headless: true, host: '127.0.0.1', timeout: 15_000 });
  browserServer = await launch;
  browserServer.on('close', () => {
    if (!isStopping) process.exit(1);
  });
  if (isStopping || !process.connected) await stop();
  else {
    process.send(
      {
        kind: 'ready',
        endpoint: browserServer.wsEndpoint(),
        browserPid: browserServer.process().pid,
      },
      () => undefined
    );
  }
} catch {
  // Errors from Playwright can contain the capability URL. The parent reports a fixed startup error.
  if (process.connected) process.send({ kind: 'failed' }, () => undefined);
  await stop();
}
