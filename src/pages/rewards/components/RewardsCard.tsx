import { CheckMark } from '@components/Icons';

interface RewardsCardProps {
  title: string;
  description: string;
}

export const RewardsCard = (props: RewardsCardProps) => {
  const { title, description } = props;

  return (
    <div className={'rewards-card'}>
      <div className={'rewards-card__inner'}>
        <CheckMark className={'rewards-card__checkmark '}/>
        <div>
          <h6 className={'rewards-card__title'}>{title}</h6>
          <p className={'rewards-card__text'}>{description}</p>
        </div>
      </div>
    </div>
  );
};