// The acceptance cases the suite must hold, kept apart from the specs so that deleting a spec cannot also
// delete the knowledge that it is required. The summary reporter checks each against the full suite's
// inventory: a case missing from it makes its criterion, and the acceptance, INCOMPLETE. A case can be in
// the suite as a `test.fixme` until it can run, which reports INCOMPLETE too.

export type RequiredCase = {
  /** The acceptance criterion, as the specs tag it: `AC7`. */
  criterion: string;
  /** The test's identity in the full suite, as `testId` in `summaryReporter.ts` names it. */
  id: string;
  /** Why the criterion needs it. */
  why: string;
};

export const REQUIRED_ACCEPTANCE_CASES: readonly RequiredCase[] = [
  {
    criterion: 'AC7',
    id: 'prod-build › prod-build.spec.ts › production build with NODE_ENV=development › cannot use the dev-only screening bypass',
    why:
      'AC7 requires that a production build cannot use the dev screening bypass, and a build run with ' +
      'NODE_ENV=development compiles DEV=true. It stays a test.fixme until the product fix to envVars.ts lands.',
  },
];
