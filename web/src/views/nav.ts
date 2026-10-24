import { useEffect } from 'react';
import { useUI } from '../state/ui';

/** Where ← and → go from the view on the right, for as long as it is shown. */
export function useKeyNav(prev: string | null, next: string | null): void {
  useEffect(() => {
    useUI.setState({ keyNav: { prev, next } });
    return () => useUI.setState({ keyNav: { prev: null, next: null } });
  }, [prev, next]);
}
