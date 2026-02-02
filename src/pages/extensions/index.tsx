import { PropsWithChildren, useContext } from 'react';

import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import { StateType } from '@types';

import { LoadingExtensionListRow, ExtensionListRow } from './components/ExtensionListRow';
import { allExtensions } from './helpers/list';
import { useExtensionsEnableStateByMarket } from './hooks/useExtensionsEnableStateByMarket';

type ExtensionListProps = {
  web3: Web3;
};

const ExtensionList = ({ web3 }: ExtensionListProps) => {
  const { selectedMarket } = useContext(getSelectedMarketContext());
  const extensionsEnableState = useExtensionsEnableStateByMarket(web3, selectedMarket);

  // Initially (while market data, etc is being loaded), show placeholders.
  const extensionGroups: JSX.Element[] = [];
  if (extensionsEnableState[0] === StateType.Loading) {
    extensionGroups.push(
      <ExtensionsGroupedByEnableWrapper isEnabled={false}>
        <LoadingExtensionListRow />
        <LoadingExtensionListRow />
      </ExtensionsGroupedByEnableWrapper>
    );
  } else {
    // loadingState === StateType.Hydrated
    const ExtensionsEnableState = extensionsEnableState[1];

    // Filter out the sandbox extension since that is primarily for extension developers.
    const extensionsNoSandbox = allExtensions.filter((e) => e.id !== 'sandbox');
    // Organize which extensions (for this market) are enabled/not enabled for this account.
    const enabledExtensions = extensionsNoSandbox.filter((e) => ExtensionsEnableState.enabled.includes(e.id));
    const notEnabledExtensions = extensionsNoSandbox.filter((e) => ExtensionsEnableState.notEnabled.includes(e.id));

    // Group the extensions by whether they're enabled or not.
    if (enabledExtensions.length) {
      extensionGroups.push(
        <ExtensionsGroupedByEnableWrapper isEnabled={true}>
          {enabledExtensions.map((ext, i) => (
            <ExtensionListRow {...ext} key={i} />
          ))}
        </ExtensionsGroupedByEnableWrapper>
      );
    }
    if (notEnabledExtensions.length) {
      extensionGroups.push(
        <ExtensionsGroupedByEnableWrapper isEnabled={false}>
          {notEnabledExtensions.map((ext, i) => (
            <ExtensionListRow {...ext} key={i} />
          ))}
        </ExtensionsGroupedByEnableWrapper>
      );
    }
  }

  return (
    <div className="page extension-list">
      <section className="hero-panel extension-list__masthead">
        <h1 className="L1 heading heading--emphasized">Extensions</h1>
        <div className="L3 body">
          Extensions are optional add-ons, built by community developers, that enhance the Compound experience. Enabling
          extensions allows for new features to be added to your account–such as automation, composability with other
          DeFi protocols, or position management.
        </div>
      </section>
      {extensionGroups.reduce((result, item) => (
        <div className="extension-list__grouped-wrapper grid-container">
          {result}
          {item}
        </div>
      ))}
    </div>
  );
};

const ExtensionsGroupedByEnableWrapper = ({ children, isEnabled }: PropsWithChildren & { isEnabled: boolean }) => {
  return (
    <>
      <div
        className={`L1 label extension-list__grouped-wrapper__label__${
          isEnabled ? 'enabled' : 'not-enabled'
        } grid-column--2`}
      >
        {isEnabled ? 'Enabled' : 'All Extensions'}
      </div>
      <div className="extension-list__grouped-wrapper__content grid-column--10">{children}</div>
    </>
  );
};

export default ExtensionList;
