import { Context, createContext } from 'react';

import { ActionQueue } from '@types';

let ActionQueueContext: Context<ActionQueue>;

export function initializeContext(actionQueue: ActionQueue) {
  if (ActionQueueContext === undefined) {
    ActionQueueContext = createContext<ActionQueue>(actionQueue);
  }
}

export function getActionQueueContext(): Context<ActionQueue> {
  if (ActionQueueContext === undefined) {
    throw 'Must initialize context!';
  }

  return ActionQueueContext;
}
