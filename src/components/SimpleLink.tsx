import { forwardRef, MouseEventHandler, PropsWithChildren } from 'react';
import { Link, NavLink, NavLinkProps } from 'react-router-dom';

type Props = PropsWithChildren & {
  to: string;
  className?: NavLinkProps['className'];
  onClick?: MouseEventHandler;
  style?: React.CSSProperties;
};
export const SimpleLink = forwardRef<HTMLAnchorElement | null, Props>(({ children, to, ...props }: Props, ref) => {
  // This is an external link, so just use a regular a-tag.
  if (to.startsWith('http')) {
    if (typeof props.className === 'function') {
      // An external link can never be active.
      props.className = props.className({ isActive: false, isPending: false, isTransitioning: false });
    }

    return (
      <a href={to} target="_blank" rel="noreferrer" {...(props as PropsWithChildren)}>
        {children}
      </a>
    );
  }

  // Nav links are special in that they support a function for the className,
  // to update which link is currently active.
  if (typeof props.className === 'function') {
    return (
      <NavLink
        to={{
          pathname: to,
          search: location.search,
          hash: location.hash,
        }}
        {...(!!ref && { ref })}
        {...props}
      >
        {children}
      </NavLink>
    );
  }

  // In all other situations, use a regular Link
  return (
    <Link
      to={{
        pathname: to,
        search: location.search,
        hash: location.hash,
      }}
      {...(props as PropsWithChildren)}
    >
      {children}
    </Link>
  );
});
