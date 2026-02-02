import { useEffect, useState } from 'react';

export default function usePoll(timeout: number) {
  const [timer, setTimer] = useState(0);

  useEffect(() => {
    let t: NodeJS.Timeout;
    function loop(x: number, delay: number) {
      t = setTimeout(() => {
        requestAnimationFrame(() => {
          setTimer(x);
          loop(x + 1, delay);
        });
      }, delay);
    }
    loop(1, timeout);
    return () => clearTimeout(t);
  }, []);

  return timer;
}
