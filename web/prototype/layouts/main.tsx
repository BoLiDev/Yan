/*
 * PROTOTYPE, throwaway. Three answers to "what do v2's two layouts look like,
 * how does one switch, and what is each called", switchable via ?variant=
 * (A, B, C) from the bar at the bottom or with ← and →. Everything is mock
 * data; nothing reads yan serve but the fonts.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import './proto.css';
import { Switcher, VARIANTS } from './Switcher';
import { useParam } from './params';
import { VariantA } from './VariantA';
import { VariantB } from './VariantB';
import { VariantC } from './VariantC';

function App() {
  const [variant] = useParam('variant', 'A');
  const v = VARIANTS.some(([k]) => k === variant) ? variant : 'A';
  return (
    <TooltipProvider delay={400}>
      {v === 'A' && <VariantA />}
      {v === 'B' && <VariantB />}
      {v === 'C' && <VariantC />}
      <Switcher current={v} />
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>);
