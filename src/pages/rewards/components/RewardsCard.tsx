import { ReactNode } from 'react';

interface RewardsCardProps {
  title: string;
  description: string;
  icon: ReactNode;
}

export const RewardsCard = (props: RewardsCardProps) => {
  const { title, description, icon } = props;

  return (
    <div className={'rewards-card'}>
      <div className={'rewards-card__inner'}>
        <div className={'rewards-card__icon-container'}>
          {icon}
        </div>
        <div>
          <h6 className={'rewards-card__title'}>{title}</h6>
          <p className={'rewards-card__text'}>{description}</p>
        </div>
      </div>
    </div>
  );
};