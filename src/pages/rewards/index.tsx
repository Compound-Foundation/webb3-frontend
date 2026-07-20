import { useAccount } from 'wagmi';

import { DollarCircle } from '@components/Icons/DollarCircle';
import { Grid } from '@components/Icons/Grid';
import { Sparkle } from '@components/Icons/Sparkle';
import { SimpleLink } from '@components/SimpleLink';

import { RewardsBanner } from '../rewards/components/RewardsBanner';
import { RewardsCard } from '../rewards/components/RewardsCard';

import { RewardsFaq } from './components/RewardsFaq';

const rewardsCards = [
  {
    title: 'See and claim your COMP rewards',
    description: 'Connect your wallet in Merkl to see and claim in Merkl.',
    icon: <DollarCircle />,
  },
  {
    title: 'Competitive APYs',
    description: 'Increase your earning potential by using Compound and follow the new Compound Foundation X for the newest campaigns.',
    icon: <Sparkle/>
  },
  {
    title: 'Onchain',
    description: 'All verifiable and transparent distributions to wallets.',
    icon: <Grid/>
  }
];

const rewardsFaq = [
  {
    id:'1',
    question: 'Why was claiming moved to Merkl?',
    answer: 'Increase your earning potential by using Compound and follow the new Compound Foundation X for the newest campaigns.'
  },
  {
    id:'2',
    question: 'Has my reward earning logic changed?',
    answer: 'No. Compound calculates your rewards exactly as before based on your supply and borrow positions. Merkl is used strictly for distribution and claiming.'
  },
  {
    id:'3',
    question: 'How do I claim my COMP rewards?',
    answer: '"View your Rewards" above, connect your active wallet on Merkl, and claim your available COMP tokens.'
  },
  {
    id:'4',
    question: 'Do rewards expire?',
    answer: 'Yes. Merkl reward distributions run on defined epoch schedules with expiration windows. Make sure to claim regularly before windows close.'
  }
]

const Rewards = () => {
  const { address, isConnected } = useAccount();

  return (
    <main className={'rewards'}>
      <RewardsBanner/>
      <section className={'rewards-cards'}>
        {rewardsCards.map((card) => {
          const { title, description, icon } = card;
          return (
            <RewardsCard
              icon={icon}
              key={title}
              title={title}
              description={description}
            />
          )
        })}
      </section>
      <div className={'rewards-links'}>
        {isConnected && (
          <SimpleLink className={'button button-green'} to={`https://app.merkl.xyz/users/${address}`}>
            View your Rewards
          </SimpleLink>
        )}
        <SimpleLink className={'button'} to={`https://app.merkl.xyz/?search=comp`}>
          View rewards opportunities
        </SimpleLink>
      </div>
      <RewardsFaq
        title={'FAQ'}
        items={rewardsFaq}
      />
    </main>
  );
};

export default Rewards;