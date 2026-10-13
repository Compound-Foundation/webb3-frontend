import { CircleExclamation } from '@components/Icons';
import Tooltip from '@components/Tooltip';

interface UnavailableTooltipProps {
  className?: string;
}

export const UnavailableTooltip = (props: UnavailableTooltipProps) => {
 const { className = '' } = props;
  return (
    <Tooltip
      width={200}
      interactive={true}
      yOffset={12}
      content={
        <span className='unavailable__tooltip-text'>
          Market temporarily unavailable. Please check back shortly.
        </span>
      }
    >
      <span className={className}>
        <CircleExclamation className="svg--icon--3 unavailable__tooltip-icon" />
      </span>
    </Tooltip>
  );
};