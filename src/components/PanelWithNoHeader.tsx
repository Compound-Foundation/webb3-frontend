import { ReactNode } from 'react';

type PanelWithNoHeaderProps = {
  children: ReactNode;
  className?: string;
};

const PanelWithNoHeader = ({ className, children }: PanelWithNoHeaderProps) => {
  const extraClassNameString = className ? className : '';
  return (
    <div className={`panel-with-header ${extraClassNameString}`}>
      <div className="panel-with-no-header__content">{children}</div>
    </div>
  );
};

export default PanelWithNoHeader;
