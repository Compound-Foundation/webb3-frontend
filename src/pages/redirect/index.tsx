import { useEffect, useState } from 'react';

import Logo from '@components/Logo';

// Where the "Continue" button and the automatic redirect send the visitor.
export const REDIRECT_TARGET_URL = 'https://app.compound.xyz/';

// Seconds shown on the countdown before the automatic redirect fires.
export const REDIRECT_COUNTDOWN_SECONDS = 10;

const FONTS_LINK_ID = 'redirect-page-fonts';
const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Asta+Sans:wght@300;400&family=Rethink+Sans:wght@600&display=swap';

// The page is served from redirect/index.html in production, which already links the
// fonts. The dev server and in-app navigation render it from the root index.html, so
// make sure the stylesheet is present either way.
const ensureFontsLoaded = () => {
  if (document.getElementById(FONTS_LINK_ID)) {
    return;
  }
  const link = document.createElement('link');
  link.id = FONTS_LINK_ID;
  link.rel = 'stylesheet';
  link.href = FONTS_HREF;
  document.head.appendChild(link);
};

type Props = {
  // How the automatic redirect navigates. Defaults to a full page load of the target;
  // injectable because jsdom does not allow window.location to be replaced in tests.
  navigate?: (url: string) => void;
};

const defaultNavigate = (url: string) => window.location.assign(url);

const Redirect = ({ navigate = defaultNavigate }: Props) => {
  const [secondsLeft, setSecondsLeft] = useState(REDIRECT_COUNTDOWN_SECONDS);

  useEffect(() => {
    document.title = 'Compound Finance';
    ensureFontsLoaded();
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) {
      navigate(REDIRECT_TARGET_URL);
      return;
    }
    const timer = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [secondsLeft, navigate]);

  return (
    <div className="redirect-page">
      <div className="redirect-page__card">
        <Logo className="redirect-page__logo" />

        <h1 className="redirect-page__title">
          <span>Compound.finance is now</span>
          <br />
          <span className="redirect-page__title-accent">Compound.xyz</span>
        </h1>

        <div className="redirect-page__preview">
          <img
            className="redirect-page__preview-image"
            src="/images/redirect-page-ui.png"
            width={802}
            height={500}
            alt="The new Compound.xyz homepage"
          />
        </div>

        <p className="redirect-page__note">Your positions stay the same. No migration required.</p>

        <div className="redirect-page__actions">
          <a className="redirect-page__button" href={REDIRECT_TARGET_URL}>
            Continue to Compound.xyz
          </a>
          <p className="redirect-page__countdown" aria-live="polite">
            You will be automatically redirected in <span>{secondsLeft}</span>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Redirect;
