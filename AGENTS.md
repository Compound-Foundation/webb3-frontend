# webb3-frontend

The Compound web app: a React and TypeScript single-page app built with Vite and published to IPFS. `README.md` covers local setup, environment variables and running the backend. This file holds the rules for changing the repository. Claude Code and Codex both read it, and so do the automated PR reviewers.

## Agent setup

The repository uses the `cf-core` plugin from [dev-fleet](https://github.com/Compound-Foundation/dev-fleet).

- In Claude Code, the committed `.claude/settings.json` registers the dev-fleet marketplace and enables `cf-core` once you trust the folder. Keep personal settings in `.claude/settings.local.json`, which is ignored.
- In Codex, install it once per machine: `codex plugin marketplace add git@github.com:Compound-Foundation/dev-fleet.git --ref main`, then `codex plugin add cf-core@dev-fleet`, and start a new session.

No dev-fleet project plugin covers this repository, so agents and reviewers work from `cf-core` and this file.

## Develop

- Install with `yarn install`. The repository pins Node 22 through Volta and Yarn 1 through `packageManager`, both in `package.json`. Run `corepack enable` first if `yarn` is missing. Node 25 no longer ships Corepack, so install it there with `npm install -g corepack`.
- `yarn dev` serves the app on `http://127.0.0.1:5173`. The dev and preview servers bind to loopback so that nobody else on the network can reach them. Do not add `--host` or `host: true`.
- Path aliases (`@components`, `@helpers`, `@hooks` and the rest) are defined three times: in `tsconfig.json`, in `jest.config.js`'s `moduleNameMapper` and in `vite.config.js`'s `resolve.alias`. Keep the three in step. `@pages` is missing from Vite, so only tests can use it.
- Configuration comes from `VITE_*` variables, read in `envVars.ts`, `src/init.ts`, `src/helpers/` and `src/pages/extensions/helpers/list.ts`. Vite embeds them in the public bundle, so never add a secret as a `VITE_*` variable.

## Validate

Run all four before opening a PR:

```bash
npx tsc            # type check (CI: "Check types and linting")
yarn lint          # ESLint, including import order (CI)
yarn test          # Jest in UTC; CI does not run it, so run it locally
yarn build         # the production build CI publishes to IPFS
```

Format with Prettier under `.prettierrc`, as the README's editor setup does. Prettier is not a dependency and CI does not check formatting, so format the files you change. Tests live in `__tests__/` and in `__tests__` directories beside the code. Mock API responses come from the `msw` handlers in `handlers/`. A change to behaviour gets a test, and a bugfix gets a regression test observed failing before the fix.

## Review standards

Code and reviews follow `cf-core`'s `code-review-checklist`, `naming-standards` and `writing-standards`. The frontend has no protocol spec. On-chain behaviour belongs to the contracts and the backend.

Treat these as security-sensitive. `.github/CODEOWNERS` lists them between the `security-sensitive` markers, and a PR that changes one also gets a security review:

- Transactions: what the app asks a wallet to sign. Actions, bulker actions, contract addresses and ABIs are in `src/helpers/` and `src/constants/`. `useWriteCometState` and `useWriteVoteState` build the approve, allow, supply, withdraw, bulker, delegate and vote transactions, and `useTransactionManager` submits them. The home page chooses the approval spender. A wrong amount, token, market, chain, spender or recipient loses users' funds.
- Wallet connection and framing: EIP-6963 discovery, WalletConnect and Ledger, the wallet modal, Safe auto-connect and the Safe App parent-frame check in `src/helpers/safe.ts`. `src/main.tsx` sets the allowed Safe domains and turns off Wagmi's own reconnect. Extensions in `src/pages/extensions/` run third-party apps in frames, exchange messages with them and can ask users to allow an operator.
- Sanctions and address checks: a deployed build screens every connected address and fails closed. A change must not let a blocked or unscreened address reach a signing flow, and the dev-server bypass must never apply to `vite build`.
- Build and release: `.env` files, `envVars.ts`, `vite.config.js`, the HTML entry points, dependencies, CI workflows and the IPFS build, preview and release scripts. A committed `.env` file reaches the production build and can change the extension operator and frame sources. Fork PRs build without publishing credentials, and that separation must hold.

## Automated PR workflows

dev-fleet's PR-agent service runs four workflows on this repository's PRs. Three of them push commits to PR branches:

- Review: when a PR is opened ready for review, or a draft is marked ready, the service runs `code-reviewer`. It adds `security-reviewer` when the PR changes a security-sensitive path, then posts one PR review on the head commit. Reviewers follow this file as it is on the base branch, so a PR that changes `AGENTS.md` has the change reviewed, not followed.
- Branch updates: when a PR's branch lacks the latest commit of its base, the service merges the base into it in a new merge commit.
- Merge conflicts: when a PR conflicts with its base, the service resolves mechanical conflicts in a new merge commit. Otherwise it comments the conflicting files and leaves the branch unchanged.
- Failed checks: when a required check fails, the service pushes a simple fix, such as formatting or lint, as a new commit. Otherwise it comments its assessment. It never edits CI, check configuration, `vite.config.js`, `.env` files, `yarn.lock`, the audit allowlist or tests beyond formatting, so it never changes dependencies. It acts only on required checks, so it does nothing until branch protection or a ruleset on `main` requires some.

The service skips PRs from forks and from authors outside the Compound-Foundation organisation, so those get no automated review. It adds commits to PR branches after the review has run, so pull before you push, and read its commits before merging. The [pr-agents README](https://github.com/Compound-Foundation/dev-fleet/blob/main/services/pr-agents/README.md) explains how to re-run a review, pause a workflow or turn one off for this repository.

## Git

Do each task in its own Git worktree on its own branch, cut from the latest `origin/main`, and open a PR. Do not push to `main`. A separate worktree keeps one task's branch switches and installs out of another session's checkout.

```bash
git fetch origin
git worktree add -b <branch> ../webb3-frontend-<branch-slug> origin/main
cd ../webb3-frontend-<branch-slug> && yarn install
```

- Put the worktree beside the main checkout, not inside it. `tsconfig.json` includes every `.ts` file below the root, and `yarn lint` lints `.`. A worktree inside the checkout is then type-checked and linted with it. Jest skips only `.claude/`.
- A new worktree holds tracked files only. Run `yarn install` in it, and copy any `.env.local` or `.env.stage.local` you need from the main checkout.
- Reuse the worktree when you return to the task. After the PR merges, remove it with `git worktree remove ../webb3-frontend-<branch-slug>` and delete the branch.
