import Logo from './Logo';

const GoToDesktop = () => {
  return (
    <div className="go-to-desktop">
      <Logo />
      <div className="message">
        <div className="message__content-wrapper">
          <img alt="Desktop icon" className="message__icon" src="./images/icn-desktop.svg" />
          <h2 className="message__header">View from a desktop device</h2>
          <p className="message__paragraph">
            Compond III is currently not available from a mobile device until mainnet launch.
          </p>
        </div>
      </div>
      <div className="bottom">
        <button
          className="button button--dark button--earn button--jumbo"
          onClick={() => (document.location.href = 'https://compound.finance')}
        >
          Go to marketing site
        </button>
      </div>
    </div>
  );
};

export default GoToDesktop;
