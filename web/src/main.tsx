import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/red-hat-display';
import '@fontsource/b612/400.css';
import '@fontsource/b612/700.css';
import '@fontsource/b612-mono/400.css';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
