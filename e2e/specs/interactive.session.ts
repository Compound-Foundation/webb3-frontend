// The interactive session: `yarn test:browser:open`. It opens the app with the harness wallet injected and
// waits until an agent or a person ends the session with `POST /v1/session/end`, or presses Ctrl-C. It
// connects nothing and approves nothing by itself. See docs/browser-fork-wallet.md for the control API.
import { openApp, test } from '../harness/fixtures';

test('interactive session', async ({ page, wallet, manifest }) => {
  test.setTimeout(0);
  // The token file path, never the token.
  process.stdout.write(
    [
      '',
      'Browser fork wallet: interactive session',
      `  App:           ${manifest.app.devOrigin}`,
      `  Control API:   ${manifest.services.wallet}`,
      `  Token file:    ${manifest.tokenFile}`,
      `  Manifest:      ${process.env.BROWSER_HARNESS_MANIFEST}`,
      '  End with:      POST /v1/session/end, or Ctrl-C',
      '',
    ].join('\n')
  );
  await openApp(page);
  while (!(await wallet.session()).hasEnded) await page.waitForTimeout(1_000);
});
