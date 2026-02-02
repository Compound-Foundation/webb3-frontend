import React, { ReactElement, useState, useEffect } from 'react';

import { getShortAddress } from '@helpers/address';
import { convertApiResponse, checkImageURL } from '@helpers/functions';
import { getGovernanceUrlForChain, getTallyProfileForChain } from '@helpers/urls';
import { DelegateTypeEnum, DisplayAccount } from '@types';

interface DelegateProfileProps {
  delegateType: DelegateTypeEnum;
  delegateAddress: string;
  chainId: number;
  chainKey: string;
  onChangeDelegate: () => void;
}

const ProfileLink = ({ name, url }: { name: string; url: string }) => (
  <a target="_blank" href={url} className="gov-profile__link">
    <h4 className="heading heading--emphasized L4">{name}</h4>
  </a>
);

const DelegateDetails = ({ delegate, chainId }: { delegate: DisplayAccount; chainId: number }) => {
  const { address, imageUrl, displayName } = delegate;
  const [profileImage, setProfileImage] = useState('');
  const displayAddress = getShortAddress(address);

  // only set the profile image if url provided successfully loads
  if (imageUrl) {
    checkImageURL(imageUrl).then(() => {
      setProfileImage(imageUrl);
    });
  }

  return (
    <div className="gov-profile icon-text-pair">
      <div className="gov-profile__image">
        {profileImage ? (
          <img
            src={profileImage}
            className="gov-profile__image gov-profile__image__raw-image"
            aria-label="Delegate profile image"
          />
        ) : (
          <span className="gov-profile__image gov-profile__image__svg"></span>
        )}
      </div>
      {displayName ? (
        <div className="gov-profile__display-name">
          <ProfileLink name={displayName} url={getTallyProfileForChain(chainId, address)} />
          <div className="meta text-color--3">{displayAddress}</div>
        </div>
      ) : (
        <ProfileLink name={displayAddress} url={getTallyProfileForChain(chainId, address)} />
      )}
    </div>
  );
};

// returns COMP account details from API
const getDisplayAccount = async (chainKey: string, address: string) => {
  const response = await fetch(`${getGovernanceUrlForChain(chainKey)}/comp/accounts?addresses=${address}`);
  if (!response.ok) {
    throw new Error(`Error fetching voting account info: ${response.status}`);
  }
  const result = await response.json();
  return result.accounts[0];
};

const DelegateProfile = (props: DelegateProfileProps) => {
  const { delegateAddress, delegateType, chainId, chainKey, onChangeDelegate } = props;
  const [delegate, setDelegate] = useState<DisplayAccount>({ address: delegateAddress });

  useEffect(() => {
    (async () => {
      if (delegateType === DelegateTypeEnum.Delegated) {
        let delegate = await getDisplayAccount(chainKey, delegateAddress);
        if (delegate) {
          delegate = convertApiResponse<DisplayAccount>(delegate);
          setDelegate(delegate);
        }
      }
    })();
  }, []);

  let UserDetail: ReactElement;
  if (delegateType === DelegateTypeEnum.Undelegated) {
    UserDetail = <h4 className="heading heading--emphasized L4 text-color--2">Undelegated</h4>;
  } else if (delegateType === DelegateTypeEnum.Self) {
    UserDetail = <ProfileLink name="Self" url={getTallyProfileForChain(chainId, delegateAddress)} />;
  } else {
    UserDetail = <DelegateDetails delegate={delegate} chainId={chainId} />;
  }

  return (
    <div className="delegate-row">
      <div className="delegate-row__info body">{UserDetail}</div>
      <button className="button button--small" aria-label="Change delegate" onClick={onChangeDelegate}>
        Change
      </button>
    </div>
  );
};

export default DelegateProfile;
