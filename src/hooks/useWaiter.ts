import { useEffect, useState } from 'react';

/** useWaiter
 *  `useWaiter` is a simple system for waiting for a value to meet some condition before
 *  running a given function. This can be used to check other pieces of data and queue
 *  until they are met.
 *
 * ````ts
 * function MyApp(name: string) {
 *   let { waitFor } = useWaiter<string>(name);
 *
 *   ...
 *
 *   waitFor(
 *     (name) => name.toLowerCase() === name, // check name is lowercase
 *     (name) => console.log("hello " + name) // if so, run this. May be run multiple times if waitFor was called multiple times
 *   );
 * }
 */

interface Waiter<T> {
  check: (v: T) => boolean;
  run: (v: T) => Promise<void>;
}

export function useWaiter<T>(t: T) {
  const [waiters, setWaiters] = useState<Waiter<T>[]>([]);

  async function waitFor(check: (v: T) => boolean, run: (v: T) => Promise<void>, curr: T) {
    // Asked to be queued up until a given condition is met from input value `curr`
    if (check(curr)) {
      // Value is met immediately, no need to queue, just run
      await run(curr);
    } else {
      // Otherwise, add ourselves to the queue
      const waiter: Waiter<T> = {
        check,
        run,
      };
      setWaiters([...waiters, waiter]);
    }
  }

  // Actions migth be side-effecty if run, based on `t`
  useEffect(() => {
    setWaiters(
      waiters.filter((waiter) => {
        if (waiter.check(t)) {
          // This waiter is now valid, run it and remove from queue
          waiter.run(t);
          return false;
        } else {
          // This waiter still needs to wait
          return true;
        }
      })
    );
  }, [t]);

  return {
    waitFor,
  };
}
