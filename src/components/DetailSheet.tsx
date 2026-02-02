import { CSSProperties, ReactNode, useState, useRef, useLayoutEffect } from 'react';

import useDisableScroll from '@hooks/useDisableScroll';

import Portal from './Portal';

type DetailSheetProps = {
  active: boolean;
  children: ReactNode;
  className?: string;
  onClickOutside?: () => void;
  overlay?: boolean;
  style?: CSSProperties;
};

const DetailSheet = ({ active, className, children, onClickOutside, overlay = true, style }: DetailSheetProps) => {
  const [childrenHeight, setChildrenHeight] = useState(100);
  const childrenRef = useRef<HTMLDivElement>(null);
  const activeModifier = active ? ' detail-sheet--active' : '';

  useLayoutEffect(() => {
    setChildrenHeight(childrenRef.current?.clientHeight ?? 0);
  }, [childrenRef.current]);

  useDisableScroll(active && overlay);

  return (
    <Portal>
      <div className={`detail-sheet${activeModifier}${className !== undefined ? ` ${className}` : ''}`} style={style}>
        <div
          className={`detail-sheet__overlay${overlay ? '' : ' detail-sheet__overlay--hidden'}`}
          onClick={(e) => {
            if (active && !!onClickOutside) {
              e.stopPropagation();
              onClickOutside();
            }
          }}
        ></div>
        <div className={`detail-sheet__content`} ref={childrenRef}>
          {children}
        </div>
      </div>
      {/* There is a hack to allow the detail sheet scroll below the footer of the page */}
      {active && (
        <div className="mobile-only" style={{ opacity: '0' }}>
          <div style={{ height: `${childrenHeight.toString()}px` }}></div>
        </div>
      )}
    </Portal>
  );
};

export default DetailSheet;
