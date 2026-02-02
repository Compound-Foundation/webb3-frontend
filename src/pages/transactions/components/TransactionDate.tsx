import { format } from 'date-fns';

import { ExternalLink } from '@components/Icons';

const TransactionDate = ({ timestamp }: { timestamp: number }) => {
  return (
    <div className="transaction__date-holder">
      <span className="L4 meta text-color--2 transaction__date-holder__text">
        {format(new Date(timestamp * 1000), 'MMM dd')}
      </span>
      <ExternalLink className="svg--icon--3 transaction__date-holder__external-link" />
    </div>
  );
};

export default TransactionDate;
