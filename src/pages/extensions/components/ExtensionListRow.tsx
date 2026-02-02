import { Link } from 'react-router-dom';

import { ArrowRightNoDash } from '@components/Icons';

import { Extension } from '../helpers/core';

const ExtensionListRow = (extension: Extension) => {
  return (
    <Link
      className="extension-list-row__link"
      to={{
        pathname: `/extensions/${extension.id}`,
        search: location.search,
        hash: location.hash,
      }}
    >
      <div className="extension-list-row__wrapper">
        <div className="extension-list-row">
          <span className={`extension-icon extension-icon--${extension.id}`} />
          <div className="extension-list-row__info L4">
            <div className="extension-list-row__title heading heading--emphasized">{extension.name}</div>
            <div className="extension-list-row__subtitle meta">by {extension.developer}</div>
            <div className="extension-list-row__description body">{extension.description}</div>
          </div>
          <ArrowRightNoDash className="svg--icon--3 extension-list-row__arrow" />
        </div>
      </div>
    </Link>
  );
};

const LoadingExtensionListRow = () => {
  return (
    <div className="extension-list-row__link">
      <div className="extension-list-row__wrapper">
        <div className="extension-list-row">
          <div className="placeholder-content" style={{ width: '4rem', height: '4rem' }} />
          <div className="extension-list-row__info L4">
            <div className="placeholder-content" style={{ width: '40%', height: '1.5rem' }} />
            <div className="extension-list-row__subtitle meta">
              <span className="placeholder-content" style={{ width: '30%' }} />
            </div>
            <div className="placeholder-content" style={{ width: '100%', height: '2rem' }} />
          </div>
          <ArrowRightNoDash className="svg--icon--1 extension-list-row__arrow" />
        </div>
      </div>
    </div>
  );
};

export { ExtensionListRow, LoadingExtensionListRow };
