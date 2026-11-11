import { useEffect, useRef, useState } from "react";

export function useDelayedFlag(active: boolean, delay = 200, minimum = 400): boolean {
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const shownAt = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (active && !visibleRef.current) {
      timer = setTimeout(() => {
        visibleRef.current = true;
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
    } else if (!active && visibleRef.current) {
      const wait = Math.max(0, minimum - (Date.now() - shownAt.current));
      timer = setTimeout(() => {
        visibleRef.current = false;
        setVisible(false);
      }, wait);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [active, delay, minimum]);

  return visible;
}

export function usePendingSurface(active: boolean): { loading: boolean; ready: boolean } {
  const loading = useDelayedFlag(active);
  return { loading, ready: !active && !loading };
}
