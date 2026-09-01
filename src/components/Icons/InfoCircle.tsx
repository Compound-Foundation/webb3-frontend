// Lucide "info" icon, stroked with the current text color via the stylesheet
export const InfoCircle = ({ className = '' }: { className?: string }) => {
  return (
    <svg
      className={`svg ${className}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        className="svg__path"
        d="M7.99967 10.6663V7.99967M7.99967 5.33301H8.00634M14.6663 7.99967C14.6663 11.6816 11.6816 14.6663 7.99967 14.6663C4.31778 14.6663 1.33301 11.6816 1.33301 7.99967C1.33301 4.31778 4.31778 1.33301 7.99967 1.33301C11.6816 1.33301 14.6663 4.31778 14.6663 7.99967Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
