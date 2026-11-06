# Browser testing performance

The half-time goal remains **unproven**. The clean Vite 7 baseline took 177.55 seconds. The target from that observation is `177.55 / 2 = 88.775 seconds`. No measured full run reached that target.

The fastest Node 22 observation took 110.10 seconds. An isolated Node 26 trial took 106.09 seconds after the compiler-readiness fix. The [project pin](../package.json) remains Node 22.22.0. These are individual observations, not a repeated comparison or proof of a general optimum.

## Run the opt-in configuration

Follow the [browser runbook's prerequisites](browser-fork-wallet.md#prerequisites) on Node 22. The 12-worker setting below was exercised on the large Linux benchmark host. It is not a recommendation for smaller machines. The [automatic worker limit](../e2e/harness/concurrency.ts) remains four.

From the repository root, run:

```bash
env -u DEBUG -u PWDEBUG \
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

## The observations include the full command

The experiments used source base `2ce3b84f0d981a69f67d4e302750031c7c70dbd7`, Anvil 1.9.0, Playwright 1.64.1 and Chromium 156.0.8078.4. The fork used block 26244888 with its hash checked. Each comparison run received a fresh private copy of the same cache seed and account salt. The seed remained unchanged.

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

Only the reference row used a clean tree. Candidate manifests record the same base commit with a dirty tree containing the experiments. These runs do not establish that a final committed or pushed head passed. The implementer still owes a full run on the final clean commit under the [push-evidence rules](browser-fork-wallet.md#pushes-and-evidence).

## Readiness, isolation and diagnostics remain part of the workload

The [egress route](../e2e/harness/egress.ts) still checks the destination of each redirect, with a five-hop limit per guarded fetch chain. Lane headers, credential handling, the document Content Security Policy, popup restrictions and worker restrictions remain enforced. The [fixtures](../e2e/harness/fixtures.ts) still create a fresh context and reset the wallet and fork before each test.

The pool shares browser processes, not browser contexts or fork lanes. The [pool child](../e2e/harness/browserPoolWorker.mjs) trusts the run's TLS certificate beside Node's existing certificates. Cleanup stops the owned child processes and Chromium servers.

The parallel build workers still produce two production builds. The runner checks `DEV=false`, `PROD=true` and `isProduction=true` before serving them. The wrapped release-control override remains limited to development mode.

Bundled Vite can return a temporary `Bundling in progress` document while it regenerates output. Four security tests stalled on that document during the first Node 26 trial. A reload broadcast before the fallback page's WebSocket connects is a possible cause. The trace does not prove that ordering or establish Node 26 as the cause.

The readiness gate holds only a successful HTML document response from the bundled dev origin containing Vite's exact fallback markers. It polls through the guarded HTTP path for at most 240 seconds after the first confirmed fallback. Each poll starts a new guarded redirect chain within that deadline. A timeout aborts the request and records `compiler-readiness` in blocked requests. Other responses and errors retain their existing handling. This introduces no test retries, assertion changes or HMR suppression.

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
| Alternative browser engine                             | The examined engine lacked actual rendering, which the browser assertions require. Not a substitute for Chromium.                                                                               |
| Rsbuild                                                | A preliminary real-app bundle proof produced about 13.5 MB of JavaScript. It did not establish fork reads, app readiness or full test outcomes.                                                 |
| Another execution host                                 | The inspected remote Linux environment exposed two CPUs and about 3.8 GB of memory. A comparable native second-host run remains unmeasured and needs an explicit next-thread choice.            |

Compression needs care even with console calls and debugger statements preserved. The sentinel's deliberately annotated side-effect call disappeared when pure annotations were trusted. `annotations:false` preserved it. The [Oxc documentation](https://oxc.rs/docs/guide/usage/minifier/dead-code-elimination) describes these controls. [Rolldown documents the minification and name-preservation options](https://rolldown.rs/reference/Interface.OutputOptions).

## Repeatability and final-head evidence are still owed

Before making a durable speed claim:

1. Freeze the reference and candidate commits and record both inventories.
2. Run at least three matched reference/candidate pairs on the same quiet host, one command at a time.
3. Give each run a fresh private copy of the unchanged cache seed and account salt. Retain their existing permissions.
4. Keep Node, Anvil, Chromium, fork block/hash, endpoint choice, worker count and selected tests recorded for each pair.
5. Measure the complete command and report each duration, failure, skip, cleanup result and secret scan.
6. Report the median paired change and range. Compare candidate times with the 88.775-second target without discarding slower or failed runs.

This procedure is proposed validation, not completed evidence. The current measurements do not establish the fastest possible implementation or a 50% reduction.

Repository validation during the experiments passed type checking, ESLint and the production build. ESLint reported 22 existing warnings. The first concurrent check run had one Jest phase assertion fail (`checking` versus `awaiting-signature`). A complete rerun passed 96 suites and 2,004 tests, with one suite and one test skipped, without a product or test change. The isolated reference cases passed too. The transient failure's cause is unproven.
