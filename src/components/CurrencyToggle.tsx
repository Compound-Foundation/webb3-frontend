import { Currency } from '@types';

const CurrencyToggle = ({
  toggleCurrency,
  currency,
}: {
  currency: Currency;
  toggleCurrency: (currency: Currency) => void;
}) => {
  return (
    <div className="currency-toggle">
      <label
        className={`label L2 text-color--1 ${currency === Currency.USD ? 'active' : ''}`}
        onClick={() => {
          toggleCurrency(currency);
        }}
      >
        Fiat
      </label>
      <label
        className={`label L2 text-color--1 ${currency !== Currency.USD ? 'active' : ''}`}
        onClick={() => {
          toggleCurrency(currency);
        }}
      >
        Crypto
      </label>
    </div>
  );
};

export default CurrencyToggle;
