import {
  buildSentryOptions,
  DEV_TRACES_SAMPLE_RATE,
  initSentry,
  isSentryEnabled,
  PRODUCTION_TRACES_SAMPLE_RATE,
  sentryRootOptions,
} from '../../src/helpers/sentry';

const DSN = 'https://public@o0.ingest.us.sentry.io/0';

describe('buildSentryOptions', () => {
  it('turns Sentry off without a DSN', () => {
    expect(buildSentryOptions({ isDev: false, environment: 'production' })).toBeUndefined();
    expect(buildSentryOptions({ dsn: '', isDev: true, environment: 'development' })).toBeUndefined();
  });

  it('samples every trace on a development build and 10% otherwise', () => {
    expect(buildSentryOptions({ dsn: DSN, isDev: true, environment: 'development' })?.tracesSampleRate).toBe(
      DEV_TRACES_SAMPLE_RATE
    );
    expect(buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production' })?.tracesSampleRate).toBe(
      PRODUCTION_TRACES_SAMPLE_RATE
    );
    expect(PRODUCTION_TRACES_SAMPLE_RATE).toBe(0.1);
  });

  it('collects no user, header, cookie, body or query data and propagates no trace headers', () => {
    const options = buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production', release: 'abc123' });
    expect(options).toMatchObject({
      dsn: DSN,
      environment: 'production',
      release: 'abc123',
      tracePropagationTargets: [],
      enhanceFetchErrorMessages: 'report-only',
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
      },
    });
  });

  it('removes the console integration and keeps the other default integrations', () => {
    const integrations = buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production' })?.integrations;
    const defaults = [{ name: 'Breadcrumbs' }, { name: 'Console' }, { name: 'GlobalHandlers' }];
    const names = typeof integrations === 'function' ? integrations(defaults).map(({ name }) => name) : [];
    expect(names).toEqual(['Breadcrumbs', 'GlobalHandlers', 'BrowserTracing']);
  });

  it('sets no hooks or transport, so reports are sent as the SDK builds them', () => {
    const options = buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production' });
    expect(options?.transport).toBeUndefined();
    expect(options?.beforeSend).toBeUndefined();
    expect(options?.beforeSendSpan).toBeUndefined();
    expect(options?.beforeBreadcrumb).toBeUndefined();
  });

  it('leaves the release unset when it is empty', () => {
    expect(buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production', release: '' })?.release).toBe(
      undefined
    );
  });
});

describe('initSentry', () => {
  it('stays off under Jest, whose import.meta sets no DSN, and adds no React error hooks', () => {
    initSentry();
    expect(isSentryEnabled()).toBe(false);
    expect(sentryRootOptions()).toBeUndefined();
  });
});
