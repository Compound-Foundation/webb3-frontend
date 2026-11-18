import { ReactNode } from 'react';

import CollateralEmptyState from '@components/CollateralEmptyState';
import PanelWithHeader from '@components/PanelWithHeader';
import TokenVisibilityToggle, { TokenVisibilityToggleProps } from '@components/TokenVisibilityToggle';

type CollateralAssetsPanelProps = {
  children: ReactNode[];
  isFiltered?: boolean;
} & TokenVisibilityToggleProps;

const CollateralAssetsPanel = ({ children, isFiltered = false, ...tokenVisibilityToggle }: CollateralAssetsPanelProps) => {
  return (
    <PanelWithHeader
      header={
        <>
          <label className="label L1 text-color--2">Collateral Assets</label>
          <TokenVisibilityToggle {...tokenVisibilityToggle} />
        </>
      }
      className="assets-table-panel grid-column--12"
    >
      <div className="panel panel--markets-assets L3">
        {children.length === 0 ? (
          <CollateralEmptyState isFiltered={isFiltered} />
        ) : (
          <div className="panel--markets-assets__content">
            <table className="assets-table">
              <thead>
                <tr className="assets-table__row assets-table__row--header L2">
                  <th className="label" colSpan={2}>
                    Asset
                  </th>
                  <th className="label assets-table__row__total-supply">Total Supply</th>
                  <th className="label assets-table__row__reserves">Reserves</th>
                  <th className="label assets-table__row__oracle-price">Oracle Price</th>
                  <th className="label assets-table__row__collateral-factor">
                    Collateral <br />
                    Factor
                  </th>
                  <th className="label assets-table__row__liquidation-factor">
                    Liquidation <br /> Factor
                  </th>
                  <th className="label assets-table__row__liquidation-penalty">
                    Liquidation <br /> Penalty
                  </th>
                </tr>
              </thead>
              <tbody>{children}</tbody>
            </table>
          </div>
        )}
      </div>
    </PanelWithHeader>
  );
};

export default CollateralAssetsPanel;
