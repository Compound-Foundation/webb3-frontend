import { useEffect, MutableRefObject } from 'react';

/*
useOnClickOutside is a hook that takes a ref and a callback function and calls
the callback whenever the user clicks outside the component. e.g.:

function MyComponent() {
  const ref = useRef(null);
  useOnClickOutside(ref, () => alert("clicked outside"));

  return (
    <div ref={ref}>
      Some content
    </div>
  );
}
*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function useOnClickOutside(ref: MutableRefObject<any>, callback: () => void) {
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target)) {
        callback();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [ref, callback]);
}
