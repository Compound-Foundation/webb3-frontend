export const MagnifyingGlass = ({ className = '' }: { className?: string }) => {
  return (
    <svg
      className={`svg ${className}`}
      width="30"
      height="30"
      viewBox="0 0 30 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        className="svg__path"
        fill="none"
        stroke="#000000"
        strokeMiterlimit="10"
        strokeWidth="2"
        d="M13 4A9 9 0 1 0 13 22A9 9 0 1 0 13 4Z"
      />
      <path
        className="svg__path"
        fill="none"
        stroke="#000000"
        strokeLinecap="round"
        strokeMiterlimit="10"
        strokeWidth="2"
        d="M26 26L19.437 19.437"
      />
    </svg>
  );
};
