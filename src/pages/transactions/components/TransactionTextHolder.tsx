import { ReactNode } from 'react';

const TransactionTextHolder = ({ headerText, children }: { headerText: string; children?: ReactNode }) => {
  return (
    <div className="transaction__text-holder">
      <p className="L4 body--emphasized text-color--1">{headerText}</p>
      <p className="L4 meta text-color--2 ">{children}</p>
    </div>
  );
};

export default TransactionTextHolder;
