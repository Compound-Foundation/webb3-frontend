import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk';
import { useEffect } from 'react';
import { useConnect, useAccount } from 'wagmi';

export const SafeAutoConnect = () => {
  const { connectors, connect, status } = useConnect();
  const { isConnected, connector } = useAccount();
  const { connected: isSafeContext } = useSafeAppsSDK();

  useEffect(() => {
    if (!isSafeContext) return;
    if (isConnected && connector?.id === 'safe') return;
    if (status === 'pending') return;

    const safeConnector = connectors.find((c) => c.id === 'safe');
    if (!safeConnector) return;

    connect({ connector: safeConnector });
  }, [isSafeContext, isConnected, connector, connectors, connect, status]);

  return null;
};