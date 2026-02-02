import { SVGProps } from 'react';

type LoadSpinnerProps = {
  size?: number;
  strokeWidth?: number;
};

const LoadSpinner = ({ size = 24, strokeWidth = 2 }: LoadSpinnerProps) => {
  return (
    <div
      className="load-spinner"
      style={{
        width: size + 'px',
        height: size + 'px',
        borderWidth: strokeWidth + 'px',
      }}
    ></div>
  );
};

export default LoadSpinner;

export const LoadSpinnerNew = (props: SVGProps<SVGSVGElement>) => {
  return (
    <svg className="load-spinner--new" viewBox="0 0 50 50" {...props}>
      <circle className="path" cx="25" cy="25" r="20" fill="none" strokeWidth="8"></circle>
    </svg>
  );
};
