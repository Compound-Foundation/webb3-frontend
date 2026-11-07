// AC8 and AC9: the dev server serves no private file through its lazy endpoint or its HMR socket.
//
// The probe asks the dev server for private files on purpose.
// Vite broadcasts each refused module's error to every connected dev client, whose overlay then covers that page.
// The `dev-server-security` project
// therefore runs this file after the `dev` project, once every other dev page has closed.
import fs from 'node:fs';

import { expect, openApp, test } from '../harness/fixtures';

test.describe('harness boundaries', { tag: ['@AC8', '@AC9'] }, () => {
  test('the page cannot compile or fetch a private file through the lazy endpoint or the HMR socket', async ({
    page,
    manifest,
  }) => {
    // Vite 8's bundled dev answers `/@vite/lazy?id=<module>&clientId=<any>` with that module compiled. Rolldown
    // compiles only a module already in the app's graph, and the client ID is no credential. The unbundled
    // server has no such endpoint. The HMR socket's `fetchModule` call is off for the browser's environment.
    // The probe asks anyway, with the socket token that the page's own HMR client holds.
    const privateFiles = [manifest.tokenFile, `${manifest.privateDir}/tls-key.pem`];
    const secrets = [
      fs.readFileSync(manifest.tokenFile, 'utf8').trim(),
      ...fs
        .readFileSync(privateFiles[1], 'utf8')
        .split('\n')
        .filter((line) => /^[A-Za-z0-9+/=]{16,}$/.test(line)),
    ];
    expect(secrets.length).toBeGreaterThan(1);
    await openApp(page);
    const answers = await page.evaluate(
      async ({ files, hmrOrigin }) => {
        const lazy = [];
        for (const file of files) {
          const response = await fetch(`/@vite/lazy?id=${encodeURIComponent(file)}&clientId=harness-probe`);
          lazy.push({ type: response.headers.get('content-type') ?? '', body: await response.text() });
        }
        // The HMR client is `/@vite/client` on the unbundled server and `/bundledDevClient.mjs` in bundled dev.
        let token: string | undefined;
        for (const client of ['/@vite/client', '/bundledDevClient.mjs'])
          token ??= (await (await fetch(client)).text()).match(/const wsToken = "([^"]+)"/)?.[1];
        const invoked: string[] = [];
        if (token !== undefined) {
          const socket = new WebSocket(`${hmrOrigin}/?token=${token}`, 'vite-hmr');
          const replies = new Promise<void>((resolve) => {
            socket.onmessage = (event) => {
              if (String(event.data).includes('"vite:invoke"')) invoked.push(String(event.data));
              if (invoked.length === files.length) resolve();
            };
          });
          await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = reject)));
          files.forEach((file, index) =>
            socket.send(
              JSON.stringify({
                type: 'custom',
                event: 'vite:invoke',
                data: { name: 'fetchModule', id: `send:${index}`, data: [file] },
              })
            )
          );
          await replies;
          socket.close();
        }
        return { lazy, hasToken: token !== undefined, invoked };
      },
      { files: privateFiles, hmrOrigin: manifest.app.hmrOrigin }
    );
    // Only booleans and Vite's error message reach an assertion, so a failure never prints a secret.
    const leaks = (text: string) => secrets.some((secret) => text.includes(secret));
    expect(answers.lazy.map((each) => ({ isScript: /javascript/.test(each.type), leaks: leaks(each.body) }))).toEqual(
      privateFiles.map(() => ({ isScript: false, leaks: false }))
    );
    expect(answers.hasToken).toBe(true);
    expect(
      answers.invoked.map((each) => ({ leaks: leaks(each), error: JSON.parse(each).data?.data?.error?.message }))
    ).toEqual(privateFiles.map(() => ({ leaks: false, error: 'fetchModule is disabled in this environment' })));
  });
});
