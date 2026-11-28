/*
 * PROTOTYPE, throwaway. What v2's two layouts look like, how one switches,
 * and what each is called: one design, iterated on feedback (earlier takes
 * A, B and C are in this branch's history). Everything is mock data; nothing
 * reads yan serve but the fonts.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import './proto.css';
import { Layouts } from './Layouts';
import { Switcher } from './Switcher';

// Dark unless ?theme=light: the theme's own tokens, by the class v1's page sets.
const light = new URL(location.href).searchParams.get('theme') === 'light';
document.documentElement.classList.add(light ? 'light' : 'dark');

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode><TooltipProvider delay={400}><Layouts /><Switcher /></TooltipProvider></StrictMode>,
);
