import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { queryClient } from './state/server';
import './index.css';

/*
 * yan serve's page. Three panes: the tasks on the left, one task's index in
 * the middle (its notes, its branch, its artifacts as a tree), and on the
 * right whatever was picked, shown as what it is. The route lives in the
 * URL's hash, so back, forward and a reload all land where they were.
 *
 * Text comes from /blob/<sha> on this origin. Images, pages, players and
 * downloads come from the files origin the index names, one port up, where
 * a page an agent wrote runs as itself and cannot reach this one.
 *
 * The server says when the vault moved through /api/events; the page then
 * fetches again only what moved (state/server.ts), and React keeps every
 * element that did not change, so a push leaves the reader where they were.
 */
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
