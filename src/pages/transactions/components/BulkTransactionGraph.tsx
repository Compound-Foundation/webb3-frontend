const BulkTransactionGraph = ({ last }: { last: boolean }) => {
  return last ? (
    <svg
      className="graph-end"
      width="34"
      height="45"
      viewBox="0 0 34 45"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M1 1V7C1 15.8366 8.16344 23 17 23H33" stroke="#2B3947" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ) : (
    <svg
      className="graph-stem"
      width="34"
      height="38"
      viewBox="0 0 34 38"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M1 1L0.999998 37" stroke="#2B3947" strokeWidth="2" strokeLinecap="round" />
      <path d="M1 1V3C1 11.8366 8.16344 19 17 19H33" stroke="#2B3947" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
};

export default BulkTransactionGraph;
