import { DollarCircle } from '@components/Icons/DollarCircle';
import { Grid } from '@components/Icons/Grid';
import { Sparkle } from '@components/Icons/Sparkle';
import { SimpleLink } from '@components/SimpleLink';
import { Web3 } from '@contexts/Web3Context';

import { RewardsBanner } from '../rewards/components/RewardsBanner';
import { RewardsCard } from '../rewards/components/RewardsCard';

import { RewardsFaq } from './components/RewardsFaq';

const linkProps = {
  className: 'rewards-faq-link',
  target: '_blank',
  rel: 'noopener noreferrer'
} as const;

const rewardsCards = [
  {
    title: 'See and claim your COMP rewards',
    description: (
      <>
        Connect your wallet in Merkl to see and claim in Merkl.
      </>
    ),
    icon: <DollarCircle />
  },
  {
    title: 'Competitive APYs',
    description: (
      <>
        Increase your earning potential by using Compound and follow the new{' '}
        <a href={'https://x.com/Compound_xyz'} {...linkProps}>
          Compound Foundation X
        </a>{' '}
        for the newest campaigns.
      </>
    ),
    icon: <Sparkle />
  },
  {
    title: 'Onchain',
    description: (
      <>
        All verifiable and transparent distributions to wallets.
      </>
    ),
    icon: <Grid />
  }
];

const rewardsFaq = [
  {
    id: '1',
    question: 'What is Merkl?',
    answer: (
      <>
        <a href={'https://app.merkl.xyz/'} {...linkProps}>Merkl</a> is an independent, third-party DeFi incentives
        platform — not operated by Compound Foundation or Compound DAO — that helps protocols distribute token rewards
        to users based on on-chain activity. Learn more in{' '}
        <a href={'https://docs.merkl.xyz/introduction'} {...linkProps}>
          Merkl's documentation
        </a>.
      </>
    )
  },
  {
    id: '2',
    question: 'How can I claim my COMP rewards?',
    answer: (
      <>
        Go to the official Merkl app at <a href={'https://app.merkl.xyz/'} {...linkProps}>app.merkl.xyz</a> (see "What's
        the official Merkl link, and what happens once I leave the Compound app?" on <a
        href={'https://www.comp.xyz/'} {...linkProps}>forum</a>), connect the wallet that holds or held your
        Compound position, and check whether you're eligible to claim. Always verify the URL before connecting your
        wallet.
      </>
    )
  },
  {
    id: '3',
    question: 'Do rewards expire?',
    answer: (
      <>
        Yes. Each campaign has a fixed claim window: 60 days for V2, 180 days for V3, and 30 days for Seasons. Details
        per campaign: V2 Compound protocol was deprecated, but previously-accrued rewards are still claimable via a
        dedicated Merkl V2 campaign. Claim deadline: 60 days from the campaign's snapshot end block (see "Snapshot
        blocks" on <a href={'https://www.comp.xyz/'} {...linkProps}>forum</a>); the claim window closes at the next block minted once that 30-day period has elapsed. Under the
        current program rules, claims are not possible after this period.
        V3 rewards covers rewards accrued from the start block through the end block of each chain where rewards accrual
        was enabled. Claim deadline: 180 days from each chain's snapshot end block; the claim window closes at the next
        block minted once that 180-day period has elapsed. Under the current program rules, claims are not possible
        after this period.
      </>
    )
  },
  {
    id: '4',
    question: 'Can I see my claimable rewards at app.compound.xyz?',
    answer: (
      <>
        No. You'll need to go to the Merkl app to see your claimable COMP amount (or check the relevant contract
        directly for Mantle/Linea; see "Have all V3 chains migrated to Merkl?" on <a
        href={'https://www.comp.xyz/'} {...linkProps}>forum</a>). Any estimated reward rates and/or
        amounts displayed at app.compound.xyz are estimates only, with final reward amounts and other details displayed
        on the Merkl app.
      </>
    )
  },
  {
    id: '5',
    question: 'Where can I find more information?',
    answer: (
      <>
        You can find the discussion about the migration to the Merkl distribution system on the <a
        href={'https://www.comp.xyz/'} {...linkProps}>Compound Community Forum</a>
      </>
    )
  }
];

interface RewardsProps {
  web3: Web3;
}

const Rewards = ({ web3 }: RewardsProps) => {
  const { account } = web3.write;

  return (
    <main className={'rewards'}>
      <RewardsBanner />
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
          );
        })}
      </section>
      <div className={'rewards-links'}>
        {!!account && (
          <SimpleLink className={'button button-green'} to={`https://app.merkl.xyz/users/${account}`}>
            View your Rewards
          </SimpleLink>
        )}
        <button disabled={true} className={'button'}>
          Claiming: Coming Soon
        </button>
      </div>
      <RewardsFaq
        title={'FAQ'}
        items={rewardsFaq}
      />
    </main>
  );
};

export default Rewards;