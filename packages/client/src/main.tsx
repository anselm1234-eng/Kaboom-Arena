import { createRoot } from 'react-dom/client';
import './index.css';
import { isTouchDevice } from './touch';
import { StorePage, storePagePath } from './pages/StorePages';

// Touch styling (virtual pad, HUD yield, rotate overlay) keys off this class.
if (isTouchDevice()) document.body.classList.add('touch');

const root = createRoot(document.getElementById('root')!);

const pagePath = storePagePath();
if (pagePath) {
  // Store / info pages: no game session, no websocket.
  root.render(<StorePage path={pagePath} />);
} else {
  // The game app; session boot (demo scenes, resume, invite links) runs after mount.
  void import('./ui/App').then(({ App }) => root.render(<App />));
}
