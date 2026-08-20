import { useEffect, useState, useRef } from 'react';
import { api } from '../lib/api.js';
import TablerIcon from '../components/TablerIcon.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate } from '../lib/stage.js';

const CATEGORIES = ['diagram', 'document', 'screenshot', 'proposal', 'contract', 'other'];
const CATEGORY_LABELS = {
  diagram: 'Diagram',
  document: 'Document',
  screenshot: 'Screenshot',
  proposal: 'Proposal',
  contract: 'Contract',
  other: 'Other',
};

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isImage(file) {
  if (file.mime_type && file.mime_type.startsWith('image/')) return true;
  const imageTypes = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  return imageTypes.includes((file.file_type || '').toLowerCase());
}

function detectCategory(file) {
  const mime = file.type || '';
  const name = (file.name || '').toLowerCase();
  if (mime.startsWith('image/')) return 'screenshot';
  if (mime === 'application/pdf') return 'document';
  if (name.endsWith('.pptx') || name.endsWith('.ppt')) return 'proposal';
  if (name.endsWith('.docx') || name.endsWith('.doc')) return 'document';
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return 'document';
  return 'other';
}

function fileIcon(file) {
  const mime = (file.mime_type || '').toLowerCase();
  const ft = (file.file_type || '').toLowerCase();
  if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg'].includes(ft)) return 'ti-photo';
  if (mime === 'application/pdf' || ft === 'pdf') return 'ti-file-type-pdf';
  if (mime.includes('wordprocessingml') || mime.includes('msword') || ['doc','docx'].includes(ft)) return 'ti-file-type-doc';
  if (mime.includes('spreadsheetml') || mime.includes('excel') || ['xls','xlsx'].includes(ft)) return 'ti-file-type-xls';
  if (mime.includes('presentationml') || mime.includes('powerpoint') || ['ppt','pptx'].includes(ft)) return 'ti-presentation';
  return 'ti-file';
}

function groupByCategory(files) {
  const groups = {};
  for (const f of files) {
    const cat = f.category || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(f);
  }
  return groups;
}

export default function AccountFiles({ accountId }) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [staged, setStaged] = useState(null); // { file, category, description }
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [flashId, setFlashId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // file id
  const [lightbox, setLightbox] = useState(null); // file object
  const fileInputRef = useRef(null);

  const fetchFiles = async () => {
    try {
      const data = await api.listFiles(accountId);
      setFiles(data);
    } catch (e) {
      toast('Failed to load files', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, [accountId]);

  // Escape key closes lightbox
  useEffect(() => {
    if (!lightbox) return;
    const handler = (e) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightbox]);

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) stageFile(file);
  };

  const handleFileInput = (e) => {
    const file = e.target.files[0];
    if (file) stageFile(file);
    e.target.value = '';
  };

  const stageFile = (file) => {
    setUploadError('');
    setStaged({ file, category: detectCategory(file), description: '' });
  };

  const handleUpload = async () => {
    if (!staged) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError('');
    const fd = new FormData();
    fd.append('file', staged.file);
    fd.append('category', staged.category);
    if (staged.description) fd.append('description', staged.description);
    try {
      const newFile = await api.uploadFile(accountId, fd, (pct) => setUploadProgress(pct));
      setStaged(null);
      setUploading(false);
      setUploadProgress(0);
      await fetchFiles();
      setFlashId(newFile.id);
      setTimeout(() => setFlashId(null), 1500);
      toast('File uploaded', 'success');
    } catch (e) {
      setUploading(false);
      setUploadError(e?.message || 'Upload failed');
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.deleteFile(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
      setConfirmDelete(null);
      toast('File deleted', 'success');
    } catch (e) {
      toast('Delete failed', 'error');
      setConfirmDelete(null);
    }
  };

  const handleDownload = (file) => {
    const a = document.createElement('a');
    a.href = api.fileDownloadUrl(file.id);
    a.download = file.original_name || file.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handlePreview = (file) => {
    if (isImage(file)) {
      setLightbox(file);
    } else if ((file.mime_type || '').includes('pdf') || (file.file_type || '').toLowerCase() === 'pdf') {
      window.open(api.fileDownloadUrl(file.id), '_blank');
    }
  };

  const groups = groupByCategory(files);
  const orderedCats = CATEGORIES.filter((c) => groups[c] && groups[c].length > 0);

  return (
    <div className="bg-card border border-border rounded-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[11px] font-medium text-text-primary">
          Files ({files.length})
        </span>
      </div>

      <div className="p-3 flex flex-col gap-3">
        {/* Drop Zone */}
        <div
          className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
            dragOver
              ? 'border-accent-blue bg-accent-blue/10'
              : 'border-border hover:border-text-dim'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => !uploading && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileInput}
          />
          <div className="flex flex-col items-center gap-1">
            <TablerIcon name="ti-cloud-upload" className="text-[24px] text-text-muted" />
            <span className="text-[11px] text-text-secondary">
              Drop files here or click to browse
            </span>
            <span className="text-[10px] text-text-muted">
              Diagrams, docs, screenshots, PDFs up to 25MB
            </span>
          </div>
        </div>

        {/* Upload Progress */}
        {uploading && staged && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-text-secondary truncate max-w-[80%]">
                {staged.file.name}
              </span>
              <span className="text-[10px] text-text-muted">
                {uploadProgress}%
              </span>
            </div>
            <div className="w-full bg-border rounded-full h-1">
              <div
                className="bg-accent-blue h-1 rounded-full transition-all"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Staging Panel */}
        {staged && !uploading && (
          <div className="border border-border rounded-lg p-3 flex flex-col gap-2 bg-bg-app">
            <span className="text-[11px] text-text-secondary truncate">
              {staged.file.name}
            </span>

            {/* Category chips */}
            <div className="flex flex-wrap gap-1">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setStaged((s) => ({ ...s, category: cat }))}
                  className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                    staged.category === cat
                      ? 'bg-accent-blue text-white'
                      : 'border border-border text-text-muted hover:border-text-dim'
                  }`}
                >
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>

            {/* Description */}
            <input
              type="text"
              placeholder="Description (optional)"
              value={staged.description}
              onChange={(e) => setStaged((s) => ({ ...s, description: e.target.value }))}
              className="bg-transparent border border-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-dim outline-none focus:border-accent-blue transition-colors"
            />

            {/* Upload error */}
            {uploadError && (
              <span className="text-[10px] text-accent-red">
                {uploadError}
              </span>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onClick={handleUpload}
                className="px-3 py-1 bg-accent-blue text-white rounded text-[11px] hover:opacity-90 transition-opacity"
              >
                Upload
              </button>
              <button
                onClick={() => { setStaged(null); setUploadError(''); }}
                className="px-3 py-1 border border-border text-text-muted rounded text-[11px] hover:border-text-dim transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* File List */}
        {!loading && files.length === 0 && (
          <p className="text-[11px] text-text-muted text-center py-2">
            No files attached yet
          </p>
        )}

        {orderedCats.map((cat) => (
          <div key={cat} className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-text-dim px-1">
              {CATEGORY_LABELS[cat]}
            </span>
            {groups[cat].map((file) => {
              const isFlashing = flashId === file.id;
              const isPreviewing = isImage(file) || (file.mime_type || '').includes('pdf') || (file.file_type || '').toLowerCase() === 'pdf';
              const isConfirming = confirmDelete === file.id;

              return (
                <div
                  key={file.id}
                  className={`flex items-start gap-2 px-2 py-1.5 rounded transition-all ${
                    isFlashing ? 'ring-1 ring-accent-green bg-accent-green/5' : 'hover:bg-border/30'
                  }`}
                >
                  {/* Icon */}
                  <TablerIcon
                    name={fileIcon(file)}
                    className="text-[16px] text-text-muted mt-0.5 shrink-0"
                  />

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <span className="text-[11px] text-text-primary truncate block">
                      {file.original_name || file.filename}
                    </span>
                    <span className="text-[10px] text-text-muted">
                      {formatBytes(file.file_size)} · {formatDate(file.uploaded_at)}
                    </span>
                    {file.description && (
                      <span className="text-[10px] text-text-muted italic block truncate">
                        {file.description}
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {isConfirming ? (
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-text-muted">Delete?</span>
                        <button
                          onClick={() => handleDelete(file.id)}
                          className="text-[10px] text-accent-red hover:underline"
                        >
                          Yes
                        </button>
                        <span className="text-[10px] text-text-dim">/</span>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="text-[10px] text-text-muted hover:underline"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <>
                        {isPreviewing && (
                          <button
                            onClick={() => handlePreview(file)}
                            className="text-text-dim hover:text-accent-blue transition-colors"
                            title="Preview"
                          >
                            <TablerIcon name="ti-eye" className="text-[13px]" />
                          </button>
                        )}
                        <button
                          onClick={() => handleDownload(file)}
                          className="text-text-dim hover:text-accent-blue transition-colors"
                          title="Download"
                        >
                          <TablerIcon name="ti-download" className="text-[13px]" />
                        </button>
                        <button
                          onClick={() => setConfirmDelete(file.id)}
                          className="text-text-dim hover:text-accent-red transition-colors"
                          title="Delete"
                        >
                          <TablerIcon name="ti-trash" className="text-[13px]" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Image Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[200] bg-black/85 flex items-center justify-center"
          onClick={() => setLightbox(null)}
        >
          {/* X button */}
          <button
            className="absolute top-4 right-4 text-white hover:text-text-muted transition-colors"
            onClick={() => setLightbox(null)}
          >
            <TablerIcon name="ti-x" className="text-[20px]" />
          </button>

          <div
            className="flex flex-col items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={api.fileDownloadUrl(lightbox.id)}
              alt={lightbox.original_name || lightbox.filename}
              className="max-w-[90vw] max-h-[90vh] object-contain rounded"
            />
            <span className="text-[12px] text-white">
              {lightbox.original_name || lightbox.filename}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
