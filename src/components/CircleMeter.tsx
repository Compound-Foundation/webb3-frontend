type CircleMeterProps = {
  percentageFill: string;
};
// reference https://medium.com/@pppped/how-to-code-a-responsive-circular-percentage-chart-with-svg-and-css-3632f8cd7705
const CircleMeter = ({ percentageFill }: CircleMeterProps) => {
  // Stoke width is 3px as per design
  const box = 19;
  const diameter = 16;
  const radius = diameter / 2;
  const circumference = diameter * Math.PI;

  const circleFill = (circumference * parseFloat(percentageFill)) / 100;
  const x = box / 2;
  const y = (box - diameter) / 2;
  const d = `M${x} ${y} 
  a ${radius} ${radius} 0 0 1 0 ${diameter} 
  a ${radius} ${radius} 0 0 1 0 ${-diameter}`;
  return (
    <div className="circle-meter">
      <svg viewBox={`0 0 ${box} ${box}`}>
        <path className="circle-meter__bg" d={d} />
        <path className="circle-meter__circle" strokeDasharray={`${circleFill},${circumference}`} d={d} />
      </svg>
    </div>
  );
};

export default CircleMeter;
