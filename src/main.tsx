import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';

import { Web3Provider } from '@contexts/Web3Context';

import App from './App';
import './init';
import { config } from './helpers/wagmiConfig';
import ExtensionList from './pages/extensions';
import Extension from './pages/extensions/Extension';
import Home from './pages/home';
import MarketOverview from './pages/markets';
import Market from './pages/markets/Market';
import TransactionHistory from './pages/transactions';
import Vote from './pages/vote';

const { pathname } = window.location;
const ipfsMatch = new RegExp('.*/Qm[a-zA-Z0-9]{44}/').exec(pathname);
const queryClient = new QueryClient();

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Router basename={ipfsMatch ? ipfsMatch[0] : '/'}>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <Web3Provider>
            <Routes>
              <Route path="/" element={<App Component={Home} pageProps={{}} />} />
              <Route path="/markets/:marketId" element={<App Component={Market} pageProps={{}} />} />
              <Route path="/markets" element={<App Component={MarketOverview} pageProps={{}} />} />
              <Route path="/extensions/:extensionId" element={<App Component={Extension} pageProps={{}} />} />
              <Route path="/extensions" element={<App Component={ExtensionList} pageProps={{}} />} />
              <Route path="/vote" element={<App Component={Vote} pageProps={{}} />} />
              <Route path="/transactions" element={<App Component={TransactionHistory} pageProps={{}} />} />
            </Routes>
          </Web3Provider>
        </QueryClientProvider>
      </WagmiProvider>
    </Router>
  </React.StrictMode>
);
