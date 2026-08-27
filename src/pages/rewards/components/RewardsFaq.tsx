import { clsx } from 'clsx';
import { ReactNode, useState } from 'react';

import { FaqCross } from '@components/Icons/FaqCross';
import { useMediaQuery } from '@hooks/useMediaQuery';

interface RewardsFaq {
  id: string;
  question: string;
  answer: ReactNode;
}

interface RewardsFaqProps {
  title: string;
  items: RewardsFaq[];
}

export const RewardsFaq = (props: RewardsFaqProps) => {
  const { title, items } = props;

  const [openedIds, setOpenedIds] = useState<Set<string>>(new Set());
  const isMobile = useMediaQuery('(min-width: 1121px)');

  const leftItems = items.filter((_, i) => i % 2 === 0);
  const rightItems = items.filter((_, i) => i % 2 === 1);

  const toggleItem = (id: string) => {
    setOpenedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const getColumn = (columnItems: RewardsFaq[]) => {
    return columnItems.map(({ id, question, answer }) => {
      const isOpen = openedIds.has(id);

      return (
        <div
          key={id}
          className="rewards-faq-details"
        >
          <input
            id={`rewards-faq-trigger-${id}`}
            className="rewards-faq-trigger-input"
            type="checkbox"
            checked={isOpen}
            onChange={() => toggleItem(id)}
          />

          <label
            htmlFor={`rewards-faq-trigger-${id}`}
            className={clsx('rewards-faq-summary', {
              'rewards-faq-summary__open': isOpen,
            })}
          >
            {question}
            <FaqCross
              className={clsx('rewards-faq-summary__icon', {
                'rewards-faq-summary__icon-open': isOpen,
              })}
            />
          </label>

          <section className="rewards-faq-animation-wrapper">
            <div className="rewards-faq-animation">
              <div className="rewards-faq-transform-wrapper">
                <p className="rewards-faq-text">{answer}</p>
              </div>
            </div>
          </section>
        </div>
      );
    });
  };

  return (
    <div className="rewards-faq">
      <h3 className="rewards-faq-title">{title}</h3>
      {isMobile
        ? (
          <div className="rewards-faq-content with-margin-bottom">
            <div className="rewards-faq-column">
              {getColumn(leftItems)}
            </div>

            <div className="rewards-faq-column">
              {getColumn(rightItems)}
            </div>
          </div>
        )
        : (
          <div className="rewards-faq-column with-margin-bottom">
            {getColumn(items)}
          </div>
        )
      }
    </div>
  );
};