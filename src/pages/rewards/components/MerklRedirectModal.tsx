import { useEffect, createContext, useState, useContext, Dispatch, SetStateAction, ReactNode } from 'react';

import { CircleClose } from '@components/Icons';
import type { Web3 } from '@contexts/Web3Context';

interface MerklRedirectModalContextValue {
  isOpen: boolean;
  setIsOpen: Dispatch<SetStateAction<boolean>>;
}

const MerklRedirectModalContext = createContext<MerklRedirectModalContextValue>({
  isOpen: false,
  setIsOpen: () => {
    throw new Error('useMerklRedirectModal must be used within a MerklRedirectModalProvider');
  }
});

export const useMerklRedirectModal = (): MerklRedirectModalContextValue => {
  return useContext(MerklRedirectModalContext);
};

export const MerklRedirectModalProvider = ({ children }: { children: ReactNode }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <MerklRedirectModalContext.Provider value={{ isOpen, setIsOpen }}>
      {children}
    </MerklRedirectModalContext.Provider>
  );
};

interface MerklRedirectModalProps {
  web3: Web3;
}

export const MerklRedirectModal = ({ web3 }: MerklRedirectModalProps) => {
  const { account } = web3.write;
  const { isOpen, setIsOpen } = useMerklRedirectModal();

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, [isOpen, setIsOpen]);

  return (
    <div className={`modal${isOpen ? ' modal--active' : ''}`}>
      <div className="modal__backdrop" onClick={() => setIsOpen(false)} />
      <div className="modal__content L4">
        <div className="modal__content__header">
          <div className="modal__content__header__left"></div>
          <h4 className="heading heading--emphasized heading">You are about to leave Compound</h4>
          <div className="modal__content__header__right" onClick={() => setIsOpen(false)}>
            <CircleClose />
          </div>
        </div>
        <div className="modal__content__icons-holder">
          <div className={`asset asset--COMP`} />
          <div className="modal__content__icons-holder__arrows"></div>
          <div className={`asset asset--MERKL`} />
        </div>
        <div className="modal__content__paragraph">
          <p className="body">Your COMP rewards are available on Merkl. Log in to your Merkl account to claim them.</p>
        </div>
        <div className="modal__content__action-row">
          <a
            href={account ? `https://app.merkl.xyz/users/${account}` : `https://app.merkl.xyz/users/`}
            className="button button--x-large button--supply"
            onClick={() => setIsOpen(false)}
            target="_blank"
            rel="noreferrer"
          >
            Proceed
          </a>
        </div>
      </div>
    </div>
  );
};