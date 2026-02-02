import { ReactNode } from 'react';

type PanelWithHeaderProps = {
  header: string | ReactNode;
  children: ReactNode;
  className?: string;
  secondaryHeader?: string;
  actions?: Array<ReactNode>;
};

const PanelWithHeader = ({ header, className, secondaryHeader, children, actions }: PanelWithHeaderProps) => {
  const extraClassNameString = className ? className : '';
  return (
    <div className={`panel-with-header ${extraClassNameString}`}>
      <div className="panel-with-header__header">
        {typeof header === 'string' ? <label className="label L1 text-color--2">{header}</label> : header}
        {secondaryHeader && (
          <div className="panel-with-header__header__secondary-text">
            <label className="label text-color--3">{secondaryHeader}</label>
          </div>
        )}
        {actions}
      </div>
      <div className="panel-with-header__content">{children}</div>
    </div>
  );
};

export default PanelWithHeader;
