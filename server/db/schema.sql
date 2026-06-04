-- Core tables

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  account_executive TEXT,
  industry TEXT,
  opportunity_stage TEXT,
  ai_summary TEXT,
  ai_technical_drivers TEXT,
  ai_environment TEXT,
  ai_summary_updated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS next_steps (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  completed INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  completed INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  raw_notes TEXT,
  deleted_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS note_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT,
  source TEXT DEFAULT 'clari_copilot',
  content TEXT NOT NULL,
  duration_minutes INTEGER,
  call_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mimetype TEXT,
  size_bytes INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  snapshot_text TEXT NOT NULL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  outlook_event_id TEXT,
  title TEXT NOT NULL,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  attendees TEXT,
  meeting_url TEXT,
  has_note INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notes_account ON notes(account_id);
CREATE INDEX IF NOT EXISTS idx_notes_date ON notes(date);
CREATE INDEX IF NOT EXISTS idx_transcripts_account ON transcripts(account_id);
CREATE INDEX IF NOT EXISTS idx_next_steps_account ON next_steps(account_id);
CREATE INDEX IF NOT EXISTS idx_todos_account ON todos(account_id);
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_attachments_account ON attachments(account_id);
CREATE INDEX IF NOT EXISTS idx_meetings_account ON meetings(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_snapshots_account ON crm_snapshots(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_outlook ON meetings(outlook_event_id) WHERE outlook_event_id IS NOT NULL;

-- FTS5 virtual table for full text search
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  source_type UNINDEXED,
  source_id UNINDEXED,
  account_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);

-- Triggers to keep search_index in sync with notes
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO search_index(source_type, source_id, account_id, title, body)
  VALUES ('note', NEW.id, NEW.account_id, NEW.date, COALESCE(NEW.raw_notes, ''));
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  DELETE FROM search_index WHERE source_type = 'note' AND source_id = OLD.id;
  INSERT INTO search_index(source_type, source_id, account_id, title, body)
  VALUES ('note', NEW.id, NEW.account_id, NEW.date, COALESCE(NEW.raw_notes, ''));
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  DELETE FROM search_index WHERE source_type = 'note' AND source_id = OLD.id;
END;

-- Triggers to keep search_index in sync with transcripts
CREATE TRIGGER IF NOT EXISTS transcripts_ai AFTER INSERT ON transcripts BEGIN
  INSERT INTO search_index(source_type, source_id, account_id, title, body)
  VALUES ('transcript', NEW.id, NEW.account_id, COALESCE(NEW.title, ''), NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS transcripts_au AFTER UPDATE ON transcripts BEGIN
  DELETE FROM search_index WHERE source_type = 'transcript' AND source_id = OLD.id;
  INSERT INTO search_index(source_type, source_id, account_id, title, body)
  VALUES ('transcript', NEW.id, NEW.account_id, COALESCE(NEW.title, ''), NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS transcripts_ad AFTER DELETE ON transcripts BEGIN
  DELETE FROM search_index WHERE source_type = 'transcript' AND source_id = OLD.id;
END;
