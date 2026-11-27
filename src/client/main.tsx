import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme, initialTheme } from './theme.ts';
import './dsh/design-platform.css';
import './app.css';

applyTheme(initialTheme());

createRoot(document.getElementById('root')!).render(<App />);
