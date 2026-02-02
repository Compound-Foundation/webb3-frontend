// Compared to ArrowRight, which looks like '->', this component looks like '>'.
export const ArrowRightNoDash = ({ className = '' }: { className?: string }) => {
  return (
    <svg
      className={`svg ${className}`}
      width="24"
      height="24"
      viewBox="0 0 10 16"
      fill="none"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        className="svg__path"
        d="M0.757324 13.6568L2.17154 15.071L9.24263 7.99999L2.17157 0.928925L0.757353 2.34314L6.41419 7.99997L0.757324 13.6568Z"
      />
    </svg>
  );
};
