import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api.js';

export const jobKey = (accountId) => `pending_pov_job_${accountId}`;

// Tracks a background POV generation job for an account by polling
// GET /api/pov-jobs/:id every 3s. The job id is persisted in localStorage so
// the indicator/polling resumes automatically when the user navigates away and
// returns — the generation itself runs server-side and is unaffected.
//
//   enabled  — when false, don't auto-resume on mount (start() still works).
//   onComplete(resultPovId) / onError(message) — fired once, then localStorage
//   is cleared.
export function usePovJob(accountId, { onComplete, onError, enabled = true } = {}) {
  const [generating, setGenerating] = useState(false);
  const timer = useRef(null);
  const cbs = useRef({});
  cbs.current = { onComplete, onError };

  const clearTimer = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
  }, []);

  const poll = useCallback((jobId) => {
    setGenerating(true);
    const tick = async () => {
      let job;
      try { job = await api.povJob(jobId); }
      catch { return; } // transient (offline / restart) — keep polling
      if (job.status === 'complete') {
        localStorage.removeItem(jobKey(accountId));
        clearTimer();
        setGenerating(false);
        cbs.current.onComplete && cbs.current.onComplete(job.result_pov_id);
      } else if (job.status === 'error') {
        localStorage.removeItem(jobKey(accountId));
        clearTimer();
        setGenerating(false);
        cbs.current.onError && cbs.current.onError(job.error_message || 'Generation failed');
      }
    };
    tick();
    clearTimer();
    timer.current = setInterval(tick, 3000);
  }, [accountId, clearTimer]);

  const start = useCallback((jobId) => {
    localStorage.setItem(jobKey(accountId), jobId);
    poll(jobId);
  }, [accountId, poll]);

  // Resume on mount if a job is pending for this account.
  useEffect(() => {
    if (!accountId) return undefined;
    if (enabled) {
      const pending = localStorage.getItem(jobKey(accountId));
      if (pending) poll(pending);
    }
    return clearTimer; // stop polling on unmount; leave localStorage intact
  }, [accountId, enabled, poll, clearTimer]);

  return { generating, start };
}
