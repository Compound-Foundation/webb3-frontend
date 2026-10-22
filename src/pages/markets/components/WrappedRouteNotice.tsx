type WrappedRouteNoticeProps = {
  baseSymbol: string;
};

/**
 * Shown on a market's page when the connected wallet lends to it through the market's wrapper.
 * The page's rates and totals describe the whole market, so the notice says which of them apply.
 */
const WrappedRouteNotice = ({ baseSymbol }: WrappedRouteNoticeProps) => (
  <div className="wrapped-route-notice grid-column--12">
    <p className="L3 body body--emphasized">
      With this wallet, {baseSymbol} you supply to this market goes through its wrapper.
    </p>
    <p className="L4 body text-color--2">
      Wrapped {baseSymbol} earns the market&apos;s supply rate. Reward and boost rates do not apply to wrapped
      positions, and wrapped {baseSymbol} is not collateral.
    </p>
  </div>
);

export default WrappedRouteNotice;
