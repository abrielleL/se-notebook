import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import QuickCapture from './components/QuickCapture.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Accounts from './pages/Accounts.jsx';
import AccountDetail from './pages/AccountDetail.jsx';
import NewNote from './pages/NewNote.jsx';
import AddNote from './pages/AddNote.jsx';
import Settings from './pages/Settings.jsx';
import Shortcuts from './pages/Shortcuts.jsx';
import PovGenerator from './pages/PovGenerator.jsx';
import CalendarPage from './pages/CalendarPage.jsx';
import PovLibrary from './pages/PovLibrary.jsx';
import FileLibrary from './pages/FileLibrary.jsx';
import Contacts from './pages/Contacts.jsx';
import Drafts from './pages/Drafts.jsx';
import StatsPage from './pages/StatsPage.jsx';

export default function App() {
  return (
    <Layout>
      <QuickCapture />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/accounts/:id" element={<AccountDetail />} />
        <Route path="/accounts/:id/add-note" element={<AddNote />} />
        <Route path="/accounts/:id/pov-generator" element={<PovGenerator />} />
        <Route path="/accounts/:id/pov-generator/:povId" element={<PovGenerator />} />
        <Route path="/new" element={<NewNote />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/pov-library" element={<PovLibrary />} />
        <Route path="/files" element={<FileLibrary />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/drafts" element={<Drafts />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/shortcuts" element={<Shortcuts />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
