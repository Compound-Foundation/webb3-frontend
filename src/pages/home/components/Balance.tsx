import MarketNetworkIcon from '@components/MarketNetworkIcon';
import { useCurrencyContext } from '@contexts/CurrencyContext';

export const Balance = ({
  wholeNumberBalance,
  fractionalNumberBalance,
}: {
  wholeNumberBalance: string;
  fractionalNumberBalance: string;
}) => {
  const { counterCurrency } = useCurrencyContext();
  return (
    <div className="meta">
      {counterCurrency !== 'USD' && <MarketNetworkIcon icon={counterCurrency as string} />}
      {wholeNumberBalance}
      <span className={`text-color--${counterCurrency === 'USD' ? '1' : '2'}`}>{`.${fractionalNumberBalance.replace(
        counterCurrency as string,
        ''
      )}`}</span>
    </div>
  );
};
