type MeterProps = {
  barColor?: string;
  riskLevel?: string;
  className?: string;
  percentageFill: string;
};

const Meter = ({ barColor = 'light', riskLevel = 'low', percentageFill, className }: MeterProps) => {
  return (
    <div className={`meter meter--${className}`}>
      <div className={`meter__bar meter__bar--${barColor}`}>
        <div className={`meter__fill meter__fill--${riskLevel}`} style={{ width: percentageFill }}></div>
      </div>
    </div>
  );
};

export default Meter;
