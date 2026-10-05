import { createContext } from 'react';

import { RewardsState, StateType } from '@types';

export default createContext<RewardsState>([StateType.Loading]);
