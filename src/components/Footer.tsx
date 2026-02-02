import { TALLY_GOV_URL, TERMS_URL } from '@helpers/urls';
import { Theme } from '@hooks/useThemeManager';

export type FooterProps = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const Footer = ({ theme, setTheme }: FooterProps) => {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__content">
          <div className="footer__content__left footer__links">
            <a href={TALLY_GOV_URL} target="_blank" rel="noreferrer">
              Governance
            </a>
            <a href={TERMS_URL} target="_blank" rel="noreferrer">
              Terms
            </a>
          </div>
          <div className="footer__content__right">
            <div className="footer__buttons">
              <span className={`theme-toggle theme-toggle--${theme === Theme.Dark && 'dark-mode'}`}>
                <label className="theme-toggle__label">
                  <span className="theme-toggle__bar">
                    <input
                      className="theme-toggle__input"
                      type="checkbox"
                      checked={theme === Theme.Dark}
                      onChange={() => {
                        theme === Theme.Dark ? setTheme(Theme.Light) : setTheme(Theme.Dark);
                      }}
                    />
                    <span className="theme-toggle__thumb"></span>
                  </span>
                </label>
              </span>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
