import { CSSProperties } from 'react';

const Hamburger = ({ className = '' }: { className?: string; style?: CSSProperties }) => {
  return (
    <div className={`hamburger${className !== '' ? ` ${className}` : ''}`}>
      <span></span>
      <span></span>
      <span></span>
    </div>
  );
};

export default Hamburger;
