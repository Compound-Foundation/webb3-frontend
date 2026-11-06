# Browser testing performance

Three matched Linux pairs measured a **28.7% median paired reduction**. The native Mac execution option completed three full commands at a **69.81-second median**.

The Linux reference and candidate medians were 155.78 and 110.66 seconds. Half the reference median is 77.89 seconds. The Linux configuration has not met that target.

The Mac median is 55.2% below the Linux reference median. That comparison changes the host and cache seed. It does not establish a same-host or code-only gain. The [project pin](../package.json) remains Node 22.22.0.

## Three matched pairs preserve the implemented inventory

The Linux host has an AMD Ryzen 9 3900X with 12 cores, 24 logical CPUs and about 32 GiB of memory. The reference used four workers at `2ce3b84`. The candidate used twelve workers and four Chromium servers at `a3a7989`. The candidate enabled the four options below. The measurements cover the combined configuration.

| Pair | Reference, seconds | Candidate, seconds | Reduction |
| ---- | -----------------: | -----------------: | --------: |
| 1    |             156.12 |             110.66 |     29.1% |
| 2    |             154.88 |             110.57 |     28.6% |
| 3    |             155.78 |             111.02 |     28.7% |

Paired reduction is `100 × (1 - candidateSeconds / referenceSeconds)`. The report takes the median of the three paired reductions.

Each reference passed 58 implemented tests. Each candidate passed 59 tests. The extra case is the dev-server security probe. The same unimplemented production-screening case kept acceptance **INCOMPLETE** in every run. The audit found no missing original test IDs, duplicates, cleanup errors or secret leaks. Both production variants resolved `DEV=false`, `PROD=true` and `isProduction=true`.

The six runs used the same tool versions, upstream selection and initial warm-cache contents. The order was reference/candidate, candidate/reference, reference/candidate. Both source trees remained clean. The [machine-readable audit](benchmarks/browser-testing-2026-11-06.json) records commits, timings, inventories and required summary lines.

## Run the opt-in configuration

Follow the [browser runbook's prerequisites](browser-fork-wallet.md#prerequisites) on Node 22. The 12-worker setting below was exercised on the large Linux benchmark host. It is not a recommendation for smaller machines. The [automatic worker limit](../e2e/harness/concurrency.ts) remains four.

From the repository root, run:

```bash
env -u DEBUG -u PWDEBUG -u NODE_OPTIONS -u BROWSER_HARNESS_CONCURRENCY \
  BROWSER_FORK_BLOCK=pinned \
  BROWSER_FORK_CACHE=on \
  BROWSER_TEST_SKIP_PROD=0 \
  BROWSER_TEST_WORKERS=12 \
  BROWSER_TEST_BUNDLED_DEV=1 \
  BROWSER_TEST_PARALLEL_BUILDS=1 \
  BROWSER_TEST_BROWSER_POOL=4 \
  BROWSER_TEST_MINIFY_DEV=1 \
  yarn test:browser
```

This command selects the full test inventory and both production builds. The existing production-screening `test.fixme` still makes acceptance **INCOMPLETE**, even when the summary reports `All implemented tests passed: yes`.

| Setting                                                              | Default             | Opt-in behavior                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`BROWSER_TEST_BUNDLED_DEV`](../e2e/harness/viteApp.ts)              | Unset, empty or `0` | `1` serves Vite's experimental bundled development output. React development checks and Refresh remain enabled.                                           |
| [`BROWSER_TEST_PARALLEL_BUILDS`](../e2e/harness/productionBuilds.ts) | Unset, empty or `0` | `1` runs the two real production builds in worker threads with separate environment variables.                                                            |
| [`BROWSER_TEST_BROWSER_POOL`](../e2e/harness/browserPool.ts)         | Unset, empty or `0` | A count from 1 to 16 shares Chromium servers across worker connections. The count cannot exceed the worker count.                                         |
| [`BROWSER_TEST_MINIFY_DEV`](../e2e/harness/devMinification.ts)       | Unset, empty or `0` | `1` requires bundled development mode. It removes whitespace and shortens local identifiers, with compression disabled and function/class names retained. |

The pool requires headless, noninteractive operation. It refuses `DEBUG`, and refuses `PWDEBUG` unless unset, empty or `0`. Browser-control URLs remain in private files and are registered for the secret scan. The manifest records loopback origins and process IDs.

To disable these harness options, run:

```bash
BROWSER_TEST_WORKERS=auto \
BROWSER_TEST_BUNDLED_DEV=0 \
BROWSER_TEST_PARALLEL_BUILDS=0 \
BROWSER_TEST_BROWSER_POOL=0 \
BROWSER_TEST_MINIFY_DEV=0 \
yarn test:browser
```

These switches do not change dependency versions. The experimental branch uses Vite 8.3.6, React plugin 6.2.1 and esbuild 0.28.1, as recorded in `package.json`.

## Native Mac execution is a separate option

The native Mac Mini uses macOS 27.0.1, an Apple M6 and 32 GiB of memory. The three quiet repetitions used clean candidate `4b36046`, five workers, two Chromium servers and the four opt-in flags above. Tool versions matched the Linux runs. Each repetition started from a fresh private copy of the same Mac-local warm cache and salt.

| Repetition | Full command, seconds | Implemented tests passed |
| ---------- | --------------------: | -----------------------: |
| 1          |             67.944428 |                       59 |
| 2          |             71.379046 |                       59 |
| 3          |             69.811701 |                       59 |

The median is 69.811701 seconds. The range is 67.944428–71.379046 seconds. The [Mac audit](benchmarks/browser-testing-macos-2026-11-06.json) records the full inventory, tools, production flags, scans, cleanup and sampled resources. The same known fixme kept acceptance **INCOMPLETE**.

The three runs had normal memory pressure, no additional swap-ins or swap-outs, and no missing or duplicate inventory entries. Minimum sampled available memory was 7.62 GiB. Sampled process-tree resident set size peaked at 8.09 GiB.

These repetitions establish the observed Mac command times. They are not paired with the Linux reference. The comparison changes hardware and the operating system. Worker count and cache seed also differ. The 55.2% cross-host reduction is `100 × (1 - 69.811701 / 155.784786)`. The three matched Linux pairs remain the evidence for the 28.7% Linux improvement.

One later Mac reference run used original commit `2ce3b84`, four workers, a Chromium per worker and the four performance options unset. It passed the original 58 implemented tests with the same fixme in 89.903932 seconds. Both production builds, scans and cleanup passed. The reference used the same Mac seed and salt, matched its endpoint selection, and recorded normal pressure without additional swap-outs.

The Mac candidate median is about 22.3% below that single Mac reference observation. One reference run does not establish a paired median or a 50% same-host gain. The larger Linux-to-Mac difference therefore includes moving the execution host.

The real Mac failure proof used the original harness config, reporters and fixtures, plus one temporary synthetic spec. It reached the app and produced exactly the intended assertion failure. The artifacts retained the screenshot, assertion step, test sources, DOM snapshots, JavaScript and JSON bodies, and readable original sources. Five generated-code hashes matched retained JavaScript bytes. The checks correlated all 11 successful browser script responses and matched 225 app files to repository source. Cleanup and the scan of 302 files and trace members passed without a leak.

The diagnostic skipped production and selected one test. It supplies diagnostic evidence only. One script attempt was aborted, and its URL also had successful retained responses. The proof does not establish the aborted attempt's bytes or exhaustive HMR coverage. The first external-config attempt failed during reporter loading before setup.

Both attempts remain recorded in the Mac audit. The temporary spec was removed, and the Mac checkout returned clean to `4b36046`.

The Mac benchmark started only with normal operating-system memory pressure and at least 10 GiB available. Its monitor stopped on a pressure warning or less than 3 GiB available. The five-worker setting is an explicit override for this measured host. The automatic worker maximum remains four.

After the [runbook prerequisites](browser-fork-wallet.md#prerequisites) and an initial cache-fill run, the Mac configuration is:

```bash
env -u DEBUG -u PWDEBUG -u NODE_OPTIONS -u BROWSER_HARNESS_CONCURRENCY \
  BROWSER_FORK_BLOCK=pinned \
  BROWSER_FORK_CACHE=on \
  BROWSER_TEST_SKIP_PROD=0 \
  BROWSER_TEST_WORKERS=5 \
  BROWSER_TEST_BUNDLED_DEV=1 \
  BROWSER_TEST_PARALLEL_BUILDS=1 \
  BROWSER_TEST_BROWSER_POOL=2 \
  BROWSER_TEST_MINIFY_DEV=1 \
  yarn test:browser
```

The first Mac cache-fill command used two workers and two Chromium servers. It passed the 59 implemented tests in 171.642828 seconds, in `mac-cold-feasibility-20261106T223308Z`. A later four-worker warm run passed in 79.573004 seconds, in `mac-warm-w4-p2-20261106T223905Z`. The first five-worker pilot passed in 69.617549 seconds, in `mac-warm-w5-p2-20261106T224411Z`. These exploratory observations precede the three quiet repetitions.

The six-worker, three-server trial stopped gracefully on a memory-pressure warning 22.85 seconds after launch. It reported 16 passes and 44 incomplete cases. Six tests were interrupted. Cleanup and secret scans passed. This resource failure is not a valid runtime observation. Its run ID is `mac-warm-w6-p3-20261106T224031Z`.

The Mac setup leaves the existing Docker/Colima environment and global tool defaults unchanged. Its private cache and salt remain on the Mac.

## Earlier exploratory observations include the full command

The experiments used source base `2ce3b84f0d981a69f67d4e302750031c7c70dbd7`, Anvil 1.9.0, Playwright 1.64.1 and Chromium 156.0.8078.4. The fork used block 26244888 with its hash checked. Each comparison run received a fresh private copy of the same cache seed and account salt. The seed remained unchanged.

The earlier single reference observation took 177.55 seconds. Its half-time target was 88.775 seconds. The repeated references above were faster. Use the paired measurements to assess repeatability.

The seconds below come from the outer command timer. They include startup, production builds, browser tests, teardown and output scans. The shorter duration at the top of `summary.md` is not the full command duration.

The run directories below live under `test-results/browser-fork/` and are Git-ignored. They contain `manifest.json`, `summary.md`, `stats.json` and test output. The reference run lives in the separate reference checkout. These local records establish the configuration and outcomes. They are not committed evidence.

| Configuration                                                | Node    | Workers / Chromium servers | Full command, seconds | Implemented tests passed | Run ID                                         |
| ------------------------------------------------------------ | ------- | -------------------------- | --------------------: | -----------------------: | ---------------------------------------------- |
| Clean Vite 7 reference                                       | 22.22.0 | 4 / per worker             |                177.55 |                       58 | `half-clean-reference-1`                       |
| Vite 8 bundled dev, parallel production builds               | 22.22.0 | 6 / per worker             |                120.18 |                       59 | `half-bundled-clean6`                          |
| Above, with browser pool                                     | 22.22.0 | 12 / 4                     |                115.09 |                       59 | `half-pool4-workers12`                         |
| Above, with development minification                         | 22.22.0 | 12 / 4                     |                110.10 |                       59 | `half-minify-pool4-workers12`                  |
| Minification and compiler-readiness gate                     | 22.22.0 | 16 / 4                     |                110.58 |                       59 | `half-readiness-minify-pool4-workers16-node22` |
| Isolated runtime trial, with readiness gate and minification | 26.13.0 | 12 / 4                     |                106.09 |                       59 | `half-readiness-minify-pool4-workers12-node26` |

Each row retains the same unimplemented production-screening case. The candidate adds one dev-server security probe, which accounts for the change from 58 to 59 implemented tests. No original assertion was removed to obtain these observations.

Only the reference row in this exploratory table used a clean tree. The candidate rows record a dirty tree containing the experiments. The later paired runs validate clean code commit `a3a7989` under the [push-evidence rules](browser-fork-wallet.md#pushes-and-evidence).

A later clean-tree default-mode run at `85b6cdf` failed in 150.08 seconds: `half-clean-head-default-node22` passed 57 tests and failed one. The known case remained skipped, and the dependent dev-server probe did not run. After a reload, 13 module requests failed with `ECONNRESET`. The app root remained empty. This failed run is not evidence of a speed improvement.

After the connection-lifetime fix, the default configuration passed 59 implemented tests on clean commit `a3a7989` in 146.86 seconds. The run ID is `half-clean-head-default-fixed-node22`. Both production builds ran, and cleanup and secret scans passed. The known fixme kept acceptance **INCOMPLETE**.

## Readiness, isolation and diagnostics remain part of the workload

The [egress route](../e2e/harness/egress.ts) still checks the destination of each redirect, with a five-hop limit per guarded fetch chain. Lane headers, credential handling, the document Content Security Policy, popup restrictions and worker restrictions remain enforced. The [fixtures](../e2e/harness/fixtures.ts) still create a fresh context and reset the wallet and fork before each test.

The pool shares browser processes, not browser contexts or fork lanes. The [pool child](../e2e/harness/browserPoolWorker.mjs) trusts the run's TLS certificate beside Node's existing certificates. Cleanup stops the owned child processes and Chromium servers.

The parallel build workers still produce two production builds. The runner checks `DEV=false`, `PROD=true` and `isProduction=true` before serving them. The wrapped release-control override remains limited to development mode.

Bundled Vite can return a temporary `Bundling in progress` document while it regenerates output. Four security tests stalled on that document during the first Node 26 trial. A reload broadcast before the fallback page's WebSocket connects is a possible cause. The trace does not prove that ordering or establish Node 26 as the cause.

The readiness gate holds only a successful HTML document response from the bundled dev origin containing Vite's exact fallback markers. It polls through the guarded HTTP path for at most 240 seconds after the first confirmed fallback. Each poll starts a new guarded redirect chain within that deadline. A timeout aborts the request and records `compiler-readiness` in blocked requests. Other responses and errors retain their existing handling. This introduces no test retries, assertion changes or HMR suppression.

The harness dev server now keeps idle HTTP connections open until cleanup. A controlled Node 22 probe reproduced idle-close resets with Playwright's public agent configuration: 14 reused requests reset under the default policy. With `keepAliveTimeout=0`, the 14 requests succeeded and shutdown completed promptly. [Node documents zero as disabling idle expiry](https://github.com/nodejs/node/blob/v22.22.0/doc/api/http.md#serverkeepalivetimeout).

The direct Playwright API-wrapper probe passed both configurations. The failed full trace lacks socket identity, so its connection to the controlled race remains an inference. The [server regression](../e2e/harness/__tests__/viteApp.test.ts) failed before the change because the connection closed during the idle window. It passes with connection reuse and prompt teardown after the change. Application polling and Playwright's retry policy retain their settings.

The [dev-server security project](../e2e/playwright.config.ts) runs after `dev`. Its private-file probes deliberately make Vite broadcast error overlays. The project order prevents those overlays from covering another test's app. A `--project dev` run excludes this probe and remains **INCOMPLETE**.

For a failed minified dev test, the fixture attaches `dev-source-maps.json.gz`. The archive retains original source contents and generated-code identifiers for successive bundle versions. Successful tests do not copy the archive into their reports. The [secret scanner](../e2e/harness/secrets.ts) expands gzip content in files, trace attachments and embedded HTML-report attachments.

The lexical-minification proof reduced loaded JavaScript from about 17 MB to 11.75 MB. The failure proof retained exact executed JavaScript bodies, assertions, a screenshot and readable original sources. A separate React fixture preserved counter state across component and imported-constant edits, without a document reload. Function names and dynamic imports also survived.

Lazy and HMR patch payloads bypass the bundle archive hook, but remain unminified. Compared with the unminified fixture, their code, source-map mappings and originals matched after normalizing temporary fixture paths. The absent additional archives for those readable payloads do not establish a loss relative to baseline diagnostics.

## Other investigated options did not establish the target

| Option                                                 | Observation and disposition                                                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Additional dependency prebundling                      | No retained full-command improvement.                                                                                                                                                           |
| Replacement asset fetching or native browser transport | Some variants lost executed JavaScript bodies in failure traces. Native continuation also needed a replacement for per-hop enforcement. The measured navigation saving was small. Not retained. |
| More workers                                           | Counts above 12 did not establish a durable improvement. The 16-worker result remains a separate observation, not evidence to raise the automatic limit.                                        |
| Two independent local shards                           | 131.41 seconds, with the new dev-server probe excluded. This is not valid full-suite evidence.                                                                                                  |
| Node 26 before the readiness fix                       | Four tests stalled on Vite's fallback HTML. The later full run passed the implemented inventory. The earlier failure does not prove a runtime incompatibility.                                  |
| Standard Oxc compression                               | Conservative compression saved another 345,170 bytes, or 3.26% of generated JavaScript. Sentinel and HMR checks passed, but the saving did not justify integration.                             |
| Anvil with one thread                                  | 112.50 seconds, with 59 implemented tests passing, in `half-threads1-minify-pool4-workers12-node22`. No speed option or Anvil source change was retained.                                       |
| Test scheduling                                        | The profile analysis estimated less than one second of realistic scheduling gain in the minified 12-worker run. This cannot explain the remaining gap.                                          |
| Earlier navigation completion                          | No retained full-command improvement.                                                                                                                                                           |
| Lightpanda                                             | It lacks the graphical rendering required by these assertions. Not a substitute for Chromium.                                                                                                   |
| Rsbuild                                                | A preliminary real-app bundle proof produced about 13.5 MB of JavaScript. It did not establish fork reads, app readiness or full test outcomes.                                                 |
| Another execution host                                 | Native Mac repetitions reached a 69.81-second median. This is a separate-host observation. See the Mac section above.                                                                           |

A later opt-in reorg-read prototype delayed the reloaded account balance query until the test's existing simulated reorg completed. The original amounts, assertions and timeouts remained. Its scoped case passed in 16.5 seconds, and the full-run second Add Action wait fell from 36–39 seconds to 1.97 seconds.

Full commands still took 112.61 seconds with twelve workers and 111.74 seconds with twenty workers. Both passed all 59 implemented tests, retained the known fixme, and passed cleanup and secret scans. Their run IDs are `half-canonical-reorg-full12` and `half-canonical-reorg-full20`. Other tests became the critical path. The prototype was removed because neither observation improved the complete command.

The twenty-worker trial used a transient 20 GiB memory limit with swap disabled. One sample showed about 15.5 GiB in use and no memory-limit or OOM events at that instant. Peak usage is unknown: the separate resource reporter failed after the suite because this kernel does not expose `memory.peak`. The outer command timer and harness reports completed.

Isolated Playwright 1.64.1 parity fixtures exercised Chromium, Firefox 157 and WebKit 27.2. The fixtures checked rendered interaction, HTTP and WebSocket boundaries, redirects, lane headers, exact-certificate trust, worker restrictions, popups and context isolation. A deliberate failure in each engine retained executed JavaScript and JSON bodies, assertion steps, test sources, DOM snapshots and screenshots. WebKit required a process-local library path and omission of its unsupported Local Network Access permission grant. These fixture results do not establish full application parity.

The Firefox twelve-worker full command took 141.58 seconds in `half-firefox-full12`. It passed 57 tests and failed the pending-screening case. The known case remained skipped, and the dependent security probe did not run. The expected error alert never appeared after screening was released as blocked.

The trace shows navigation aborting the held request before release, followed by disconnection and no new screening request. This supports the failure sequence but does not establish a general Firefox defect. Cleanup and secret scans passed. The resource sampler recorded no memory-limit or OOM events. Firefox was rejected as a speed option. Application assertions and timeouts retained their settings.

WebKit's twelve-worker full command took 162.26 seconds in `half-webkit-full12`. Its outcome matched Firefox: 57 passes, one failure, the known skip and the omitted dependent probe. Navigation cancelled the held browser request. Fail-closed handling ran before screening release. The routed Node request answered later, but no new browser screening request appeared.

Cleanup and secret scans passed, and no memory-limit or OOM event was recorded. Both engine prototypes were removed without changing the application or its existing assertions.

The pinned Rolldown 1.2.16 source [forces tree shaking and lazy barrel optimization off in development mode](https://github.com/rolldown/rolldown/blob/de6facf2228279718e042b801dd6b60dd6503918/crates/rolldown/src/utils/prepare_build_context.rs#L372-L380). A public tree-shaking setting cannot override that normalization. Vite 8.3.6 [disables constant inlining because of a known JSX development crash](https://github.com/vitejs/vite/blob/v8.3.6/packages/vite/src/node/server/bundledDev.ts#L441-L444). Neither setting provides an established safe optimization for this harness.

The [Playwright 1.65 release notes](https://playwright.dev/docs/release-notes#version-165) describe Bun-native TypeScript transformation. That mode omits test console output from traces and async stack frames, which conflicts with the diagnostic requirement. The [reused-TLS-socket fix](https://github.com/microsoft/playwright/pull/43729) handles a missing peer certificate while preserving normal connection-error rejection. It does not change the server idle-expiry policy. No upgrade trial was run, and Playwright 1.64.1 remains the benchmarked pin.

Full-config two-shard collection preserves the 60 cases but divides them 57/3. Playwright restores the complete `dev` dependency on the shard that receives the dependent security project. A balanced selection lists 30 dev cases, then 23 dev and six production cases, followed by a separate security probe. That arrangement needs a barrier after both main shards succeed and another harness startup. No timed distributed run established a complete-command benefit.

Compression needs care even with console calls and debugger statements preserved. The sentinel's deliberately annotated side-effect call disappeared when pure annotations were trusted. `annotations:false` preserved it. The [Oxc documentation](https://oxc.rs/docs/guide/usage/minifier/dead-code-elimination) describes these controls. [Rolldown documents the minification and name-preservation options](https://rolldown.rs/reference/Interface.OutputOptions).

## Repeat the comparison

To repeat the completed protocol:

1. Freeze the reference and candidate commits and record both inventories.
2. Run at least three matched reference/candidate pairs on the same quiet host, one command at a time.
3. Give each run a fresh private copy of the unchanged cache seed and account salt. Retain their existing permissions.
4. Keep Node, Anvil, Chromium, fork block/hash, endpoint choice, worker count and selected tests recorded for each pair.
5. Measure the complete command and report each duration, failure, skip, cleanup result and secret scan.
6. Report the median paired change and range. Derive the half-time target from the matched reference median and retain slower or failed runs.

The six matched runs completed this protocol. Their paired reductions range from 28.6% to 29.1%. The measurements do not establish the fastest possible implementation or a 50% Linux reduction.

Repository validation during the experiments passed type checking, ESLint and the production build. ESLint reported 22 existing warnings. The first concurrent check run had one Jest phase assertion fail (`checking` versus `awaiting-signature`). A complete rerun passed 96 suites and 2,004 tests, with one suite and one test skipped, without a product or test change. The isolated reference cases passed too. The transient failure's cause is unproven.

After the connection-lifetime change, Jest exposed a transaction-history fixture race. A delayed observer reset can replace the next test's mock. The fixture now unmounts its component before restoring the original observer immediately. The assertions retain their expected values. The full rerun passed 96 suites and 2,005 tests, with one suite and one test skipped.
