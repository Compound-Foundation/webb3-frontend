import merklLogo from '../../../../public/images/merkl.png'

export const RewardsBanner = () => {
  return (
    <div className={'rewards-banner'}>
      <img className={'rewards-banner__logo'} src={merklLogo} alt="merkl" />
      <div className={'rewards-banner__content'}>
        <h6 className={'rewards-banner__title'}>Earn Rewards with Ecosystem partners</h6>
        <p className={'rewards-banner__text'}>View your rewards and explore new reward opportunities.</p>
      </div>
    </div>
  );
};