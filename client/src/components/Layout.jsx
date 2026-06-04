import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import Icon from './Icons.jsx';
import { hasApiKey } from '../lib/ai.js';
import { useOnline } from '../lib/offline.jsx';

const navItems = [
  { to: '/', label: 'Dashboard', icon: Icon.Home, end: true },
  { to: '/accounts', label: 'Accounts', icon: Icon.Folder },
  { to: '/calendar', label: 'POV Calendar', icon: Icon.Calendar },
  { to: '/next-steps', label: 'Next Steps Inbox', icon: Icon.Check },
  { to: '/pov-library', label: 'POV Library', icon: Icon.File },
  { to: '/stats', label: 'Stats', icon: Icon.Eye }
];

export default function Layout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef(null);
  const [showBanner, setShowBanner] = useState(false);
  const online = useOnline();

  useEffect(() => {
    setShowBanner(!hasApiKey() && location.pathname !== '/settings');
  }, [location.pathname]);

  useEffect(() => {
    function onKey(e) {
      const tag = (e.target?.tagName || '').toLowerCase();
      const inField = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
      if (inField && e.key !== 'Escape') return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); navigate('/new'); }
      else if (e.key === '?') { e.preventDefault(); navigate('/shortcuts'); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  function onSearchKey(e) {
    if (e.key === 'Enter') {
      const q = e.currentTarget.value.trim();
      if (q) navigate(`/accounts?q=${encodeURIComponent(q)}`);
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  }

  const navClass = ({ isActive }) =>
    `flex items-center gap-2.5 px-3 py-2 rounded text-[12px] transition ${
      isActive ? 'bg-[#1a2744] text-accent-blue' : 'text-text-muted hover:text-text-primary hover:bg-[#14181f]'
    }`;

  return (
    <div className="flex h-full">
      <aside className="w-[190px] shrink-0 bg-sidebar border-r border-border flex flex-col">
        <div className="px-5 py-5 border-b border-border">
          <div className="text-[15px] font-semibold tracking-tight text-text-primary">
            <span className="text-accent-blue">SE</span><span className="text-text-muted">/</span>notebook
          </div>
          <div className="text-[10px] text-text-dim mt-1">technical fieldbook</div>
        </div>
        <nav className="flex-1 px-2 py-3 flex flex-col gap-1">
          {navItems.map(item => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
              <item.icon width={14} height={14} />
              {item.label}
            </NavLink>
          ))}
          <button
            onClick={() => window.dispatchEvent(new Event('open-quick-capture'))}
            className="flex items-center gap-2.5 px-3 py-2 rounded text-[12px] text-text-muted hover:text-text-primary hover:bg-[#14181f] transition text-left"
          >
            <Icon.Plus width={14} height={14} />
            Quick capture
            <span className="kbd ml-auto">Q</span>
          </button>
        </nav>
        <div className="px-2 py-3 border-t border-border flex flex-col gap-1">
          {!online && (
            <div className="flex items-center gap-2 px-3 py-2 rounded text-[11px] text-accent-yellow bg-[#2d2200]/40 border border-[#3d2f00]">
              <span className="w-2 h-2 rounded-full bg-accent-yellow animate-pulse" />
              Working offline
            </div>
          )}
          <NavLink to="/settings" className={navClass}>
            <Icon.Gear width={14} height={14} />
            Settings
          </NavLink>
          <NavLink to="/shortcuts" className={navClass}>
            <Icon.Keyboard width={14} height={14} />
            Shortcuts
          </NavLink>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <div className="h-12 shrink-0 flex items-center gap-3 px-5 border-b border-border bg-app/80 backdrop-blur">
          <div className="flex-1 max-w-xl relative">
            <Icon.Search width={13} height={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-dim" />
            <input
              ref={searchRef}
              type="text"
              placeholder='Search accounts, notes, people…   press  /'
              onKeyDown={onSearchKey}
              className="w-full bg-[#0a0d11] border border-border rounded pl-8 pr-3 py-1.5 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50"
            />
          </div>
          {!online && <span className="text-[11px] text-accent-yellow">Offline</span>}
          <button
            onClick={() => navigate('/new')}
            className="flex items-center gap-1.5 bg-accent-blue/15 hover:bg-accent-blue/25 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium transition"
          >
            <Icon.Plus width={12} height={12} /> New Note
          </button>
        </div>

        {showBanner && (
          <div className="px-5 py-2 bg-[#2d2200]/40 border-b border-[#3d2f00] text-[12px] text-accent-yellow flex items-center justify-between">
            <div>
              Anthropic API key not set. AI features will be unavailable until you add it.{' '}
              <NavLink to="/settings" className="underline">Open Settings</NavLink>
            </div>
            <button onClick={() => setShowBanner(false)} className="text-text-muted hover:text-text-primary">
              <Icon.X width={12} height={12} />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
