import { useAccount } from 'wagmi';

import { SimpleLink } from '@components/SimpleLink';

import { RewardsBanner } from '../rewards/components/RewardsBanner';
import { RewardsCard } from '../rewards/components/RewardsCard';

const rewardsCard = [
  {
    title: 'Multiple Partners',
    description: 'Access rewards from various DeFi protocols'
  },
  {
    title: 'Competitive APYs',
    description: 'Higher earning potential across platforms'
  },
  {
    title: 'On chain',
    description: 'Transparent, verifiable distributions'
  }
];

const Rewards = () => {
  const { address } = useAccount();

  return (
    <main className={'rewards'}>
      <RewardsBanner/>
      <div className={'rewards-cards'}>
        {rewardsCard.map((card) => {
          const { title, description } = card;
          return (
            <RewardsCard
              key={title}
              title={title}
              description={description}
            />
          )
        })}
      </div>
      <div className={'rewards-links'}>
        <SimpleLink className={'button button-green'} to={`https://app.merkl.xyz/users/${address}`}>
          View your Rewards
        </SimpleLink>
        <SimpleLink className={'button'} to={`https://app.merkl.xyz/?search=syrup`}>
          View rewards opportunities
        </SimpleLink>
      </div>
      <p className={'rewards-bottom-text'}>
        Third-party protocols carry independent risks.
        Always research before depositing
      </p>
    </main>
  );
};

export default Rewards;