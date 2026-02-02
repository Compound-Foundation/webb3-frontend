import { SwitchToggle } from '@components/Icons/SwitchToggle';
import MarketNetworkIcon from '@components/MarketNetworkIcon';
import { useCurrencyContext } from '@contexts/CurrencyContext';

export const BalanceValue = ({
  wholeNumberBalanceValue,
  fractionalNumberBalanceValue,
}: {
  wholeNumberBalanceValue: string;
  fractionalNumberBalanceValue: string;
}) => {
  const { currency, showCurrencyToggle } = useCurrencyContext();
  return (
    <h1 className="L0 heading heading--emphasized">
      {showCurrencyToggle && <SwitchToggle className="toggle" />}
      {currency !== 'USD' && (
        <span className="toggle-icon-wrapper">
          <MarketNetworkIcon icon={currency} />
        </span>
      )}
      <span style={{}}>{wholeNumberBalanceValue}</span>
      <span className={`text-color--${currency === 'USD' ? '1' : '2'}`}>{`.${fractionalNumberBalanceValue
        .replace('ETH', '')
        .replace('USDC', '')}`}</span>
    </h1>
  );
};
