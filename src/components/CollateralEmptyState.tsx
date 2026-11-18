type CollateralEmptyStateProps = {
  isFiltered: boolean;
  className?: string;
};

const CollateralEmptyState = (props: CollateralEmptyStateProps) => {
  const { isFiltered, className = '' } = props;

  return (
    <div className={`collateral-empty-state ${className}`}>
      <p className="L3 text-color--1">
        {isFiltered ? 'No top collateral assets found' : 'No collateral assets found'}
      </p>
      {isFiltered && <p className="L3 text-color--2">Turn off the filter to view all assets.</p>}
    </div>
  );
};

export default CollateralEmptyState;
