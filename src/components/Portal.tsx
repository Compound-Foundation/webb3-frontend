import { ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const Portal = ({ children }: { children: ReactNode }) => {
  const [mounted, setMounted] = useState<boolean>(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const overlayElement = document.getElementById('overlay');
  return mounted && overlayElement ? createPortal(children, overlayElement) : null;
};

export default Portal;
