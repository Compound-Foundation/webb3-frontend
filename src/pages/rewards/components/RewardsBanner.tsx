import merklLogo from '../../../../public/images/merkl.png'

export const RewardsBanner = () => {
  return (
    <div className={'rewards-banner'}>
      <img className={'rewards-banner__logo'} src={merklLogo} alt="merkl" />
      <div className={'rewards-banner__content'}>
        <h6 className={'rewards-banner__title'}>Earn and Claim your COMP Rewards via Merkl</h6>
        <p className={'rewards-banner__text'}>How you earn hasn't changed – Compound calculates rewards, Merkl is for claiming</p>
      </div>
    </div>
  );
};