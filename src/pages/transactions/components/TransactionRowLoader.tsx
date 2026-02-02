const TransactionRowLoader = ({ count }: { count: number }) => {
  return (
    <div className="transaction-history__month grid-container grid-container--7">
      <label className="transaction-history__month__date-label label L2 text-color--1 grid-column--1">
        <span className="placeholder-content"></span>
      </label>
      <div className="transaction-history__month__content grid-column--6">
        {[...Array(count).keys()].map((_, index) => (
          <div className="unit-transaction" key={`transaction-loading-item-${index}`} aria-label="Transaction loader">
            <div className="unit-transaction__info">
              <div className="unit-transaction__info__icon-holder">
                <span className="asset">
                  <span className="placeholder-content placeholder-content--circle"></span>
                </span>
              </div>
              <div className="transaction__text-holder">
                <p className="L4 body--emphasized text-color--1">
                  <span
                    className="placeholder-content placeholder-content__title"
                    aria-label="Transaction title loader"
                  ></span>
                </p>
                <p className="L4 meta text-color--2 ">
                  <span
                    className="placeholder-content placeholder-content__description"
                    aria-label="Transaction description loader"
                  ></span>
                </p>
              </div>
            </div>
            <div className="transaction__date-holder">
              <span className="L4 meta text-color--2 transaction__date-holder__text">
                <span className="placeholder-content"></span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TransactionRowLoader;
