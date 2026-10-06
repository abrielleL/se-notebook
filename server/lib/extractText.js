const path = require('path');
const mammoth = require('mammoth');

// Text out of an uploaded call file (.txt, .md, .docx, .pdf). Shared by the
// customer-transcript and internal-call uploads so both accept the same files.
// Throws an Error with .status = 400 for anything it can't read.
async function extractUploadText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  let content;
  if (ext === '.docx') {
    content = (await mammoth.extractRawText({ buffer: file.buffer })).value;
  } else if (ext === '.txt' || ext === '.md') {
    content = file.buffer.toString('utf8');
  } else if (ext === '.pdf') {
    // pdf-parse is required lazily so a missing optional dependency never
    // blocks server startup or the .txt/.md/.docx paths.
    try {
      const pdfParse = require('pdf-parse');
      content = (await pdfParse(file.buffer)).text || '';
    } catch (e) {
      const err = new Error('PDF parsing unavailable: ' + e.message);
      err.status = 400;
      throw err;
    }
  } else {
    const err = new Error('Unsupported file type. Use .txt, .md, .pdf or .docx');
    err.status = 400;
    throw err;
  }
  return { content, title: path.basename(file.originalname, ext) };
}

module.exports = { extractUploadText };
