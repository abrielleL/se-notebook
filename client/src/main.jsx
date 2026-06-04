import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';
import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import 'react-datepicker/dist/react-datepicker.css';
import { OfflineProvider } from './lib/offline.jsx';
import { ToastProvider } from './components/Toast.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <OfflineProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </OfflineProvider>
    </BrowserRouter>
  </React.StrictMode>
);
