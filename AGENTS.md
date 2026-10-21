# webb3-frontend

The Compound web app: a React and TypeScript single-page app built with Vite and published to IPFS. `README.md` covers local setup, environment variables and running the backend; this file holds the rules for changing the repository. Claude Code and Codex both read it, and so do the automated PR reviewers.

## Agent setup

The repository uses the `cf-core` plugin from [dev-fleet](https://github.com/Compound-Foundation/dev-fleet).

- In Claude Code, the committed `.claude/settings.json` registers the dev-fleet marketplace and enables `cf-core` once you trust the folder. Keep personal settings in `.claude/settings.local.json`, which is ignored.
- In Codex, install it once per machine: `codex plugin marketplace add git@github.com:Compound-Foundation/dev-fleet.git --ref main`, then `codex plugin add cf-core@dev-fleet`, and start a new session.

No dev-fleet project plugin covers this repository, so agents and reviewers work from `cf-core` and this file.

## Develop

- Install with `yarn install`. The repository pins Yarn 1 (`packageManager` in `package.json`); with Node 24 or later, run `corepack enable` first. CI uses Node 25.
- `yarn dev` serves the app on `http://127.0.0.1:5173`. The dev and preview servers bind to loopback on purpose; do not add `--host` or `host: true`.
- Import through the path aliases in `tsconfig.json` (`@components`, `@helpers`, `@hooks` and the rest), and keep `jest.config.js`'s `moduleNameMapper` in step when adding one.
- Configuration comes from `VITE_*` variables, read in `envVars.ts`. Vite embeds them in the public bundle, so never add a secret as a `VITE_*` variable.

## Validate

Run all four before opening a PR:

```bash
npx tsc            # type check (CI: "Check types and linting")
yarn lint          # ESLint, including import order (CI)
yarn test          # Jest in UTC; CI does not run it, so run it locally
yarn build         # the production build CI publishes to IPFS
```

Format with Prettier under `.prettierrc`, as the README's editor setup does. Prettier is not a dependency and CI does not check formatting, so format the files you change. Tests live in `__tests__/` and beside components in `__tests__` directories, and mock API responses come from the `msw` handlers in `handlers/`. A change to behaviour gets a test, and a bugfix gets a regression test observed failing before the fix.

## Review standards

Code and reviews follow `cf-core`'s `code-review-checklist`, `naming-standards` and `writing-standards`. The frontend has no protocol spec; behaviour on-chain is the contracts' and the backend's.

Treat these as security-sensitive. `.github/CODEOWNERS` lists them between the `security-sensitive` markers, and a PR that changes one also gets a security review:

- Transactions: what the app asks a wallet to sign, built in `src/helpers/` (actions, bulker actions, contract addresses and ABIs) and queued through `src/contexts/` and `useActionQueue`. A wrong amount, token, market, chain or recipient loses users' funds.
- Wallet connection and framing: EIP-6963 discovery, WalletConnect and Ledger, the Safe App parent-frame check in `src/helpers/safe.ts`, and the extension frames and messages in `src/pages/extensions/`.
- Address screening and sanctions: screening fails closed in a deployed build. A change must not let a blocked or unscreened address reach a signing flow, and the dev-server bypass must never apply to `vite build`.
- Build and release: `envVars.ts`, `vite.config.js`, the HTML entry points, dependencies, CI workflows and the IPFS build, preview and release scripts. Fork PRs build without publishing credentials, and that separation must hold.

## Automated PR reviews

dev-fleet's PR-agent service reviews this repository's PRs. When a PR is opened ready for review, or a draft is marked ready, it runs `code-reviewer`, and `security-reviewer` as well when the PR changes a security-sensitive path, and posts one PR review on the head commit. It never pushes to the branch. Reviewers follow this file as it is on the base branch; a PR that changes `AGENTS.md` has the change reviewed, not followed. The [pr-agents README](https://github.com/Compound-Foundation/dev-fleet/blob/main/services/pr-agents/README.md) explains how to re-run a review, pause the service or turn reviews off for this repository.

## Git

Branch from `main` and open a PR; do not push to `main`.
