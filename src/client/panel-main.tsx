import { createRoot } from 'react-dom/client';
import { Panel } from './panel.tsx';
import './dsh/design-platform.css';
import './app.css';

createRoot(document.getElementById('root')!).render(<Panel />);
