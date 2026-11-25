import { initSentry } from '@helpers/sentry';

// Imported first by main.tsx, so that Sentry starts before any other module runs.
initSentry();
