export const GraphStem = ({ className = '' }: { className?: string }) => {
  return (
    <svg
      className={`svg ${className}`}
      width="2"
      height="10"
      viewBox="0 0 2 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2 1C2 0.447715 1.55228 2.41411e-08 1 0C0.447715 -2.41411e-08 2.41411e-08 0.447715 0 1L2 1ZM-3.49691e-07 9L-3.93402e-07 10L2 10L2 9L-3.49691e-07 9ZM0 1L-3.49691e-07 9L2 9L2 1L0 1Z"
        fill="#2B3947"
      />
    </svg>
  );
};
