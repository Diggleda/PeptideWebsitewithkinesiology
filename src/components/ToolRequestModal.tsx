import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { ModalSquircle } from './ui/modal-squircle';
import { api, usageTrackingAPI } from '../services/api';

type ToolRequestSource = 'research_tab';

const MODAL_FADE_MS = 65;
const TOOL_REQUEST_PORTAL_ROOT_ID = 'trufusion-tool-request-modal-root';

const normalizeToolRequestSource = (value: unknown): ToolRequestSource => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (raw === 'research' || raw === 'research_tab' || raw === 'account_research') {
    return 'research_tab';
  }
  return 'research_tab';
};

interface ToolRequestModalProps {
  open: boolean;
  source?: ToolRequestSource | string;
  onClose: () => void;
}

export function ToolRequestModal({ open, source = 'research_tab', onClose }: ToolRequestModalProps) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState('');
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSource = useMemo(() => normalizeToolRequestSource(source), [source]);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      if (!mounted) return undefined;
      setVisible(false);
      closeTimerRef.current = setTimeout(() => {
        setMounted(false);
        closeTimerRef.current = null;
      }, MODAL_FADE_MS);
      return () => clearCloseTimer();
    }

    clearCloseTimer();
    setMounted(true);
    setError('');
    setSuccess('');
    void usageTrackingAPI.track({
      event: 'tool_request_clicked',
      metadata: { source: activeSource },
    }).catch(() => {});
    const reveal = () => setVisible(true);
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(reveal);
    } else {
      reveal();
    }
    return undefined;
  }, [activeSource, clearCloseTimer, mounted, open]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  useEffect(() => {
    if (!mounted || typeof document === 'undefined') {
      setPortalRoot(null);
      return undefined;
    }
    let root = document.getElementById(TOOL_REQUEST_PORTAL_ROOT_ID) as HTMLElement | null;
    if (!root) {
      root = document.createElement('div');
      root.id = TOOL_REQUEST_PORTAL_ROOT_ID;
    }
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      isolation: 'isolate',
      pointerEvents: 'none',
    });
    document.body.appendChild(root);
    document.body.classList.add('tool-request-modal-open');
    setPortalRoot(root);
    return () => {
      document.body.classList.remove('tool-request-modal-open');
      setPortalRoot(null);
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted || typeof window === 'undefined') return undefined;
    window.dispatchEvent(new CustomEvent('trufusion:legal-state', { detail: { open: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent('trufusion:legal-state', { detail: { open: false } }));
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted || typeof document === 'undefined' || typeof window === 'undefined') return undefined;
    const body = document.body;
    const docEl = document.documentElement;
    const originalOverflow = body.style.overflow;
    const originalPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - docEl.clientWidth;
    if (!originalPaddingRight && scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = originalOverflow;
      body.style.paddingRight = originalPaddingRight;
    };
  }, [mounted]);

  const requestClose = useCallback(() => {
    if (!mounted) return;
    setVisible(false);
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, MODAL_FADE_MS);
  }, [clearCloseTimer, mounted, onClose]);

  useEffect(() => {
    if (!mounted || typeof window === 'undefined') return undefined;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        requestClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [mounted, requestClose]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    const trimmedReport = report.trim();
    if (!trimmedReport) {
      setError('Please describe the tool you want.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post('/tool-requests', { report: trimmedReport, source: activeSource });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Unable to submit tool request.');
      }
      setSuccess('Thanks. Your tool request has been submitted.');
      setReport('');
    } catch (submitError: any) {
      setError(submitError?.message || 'Unable to submit tool request. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!mounted || !portalRoot) {
    return null;
  }

  const panelStyle = {
    width: 'min(100%, 32rem)',
    maxWidth: '32rem',
    backgroundColor: 'rgba(245, 251, 255, 0.94)',
    borderColor: 'rgba(11, 6, 121, 0.65)',
  } as CSSProperties;

  return createPortal(
    <div
      className={clsx(
        'tool-request-modal-layer fixed inset-0 flex items-center justify-center p-6 sm:p-12 transition-opacity duration-[55ms] ease-out backdrop-blur-[16px] pointer-events-auto',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      style={{
        zIndex: 2147483647,
        willChange: 'opacity',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
      onClick={requestClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className={clsx(
          'absolute inset-0 bg-[rgba(4,14,21,0.55)] transition-opacity duration-[55ms] ease-out',
          visible ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden="true"
        style={{
          willChange: 'opacity',
          backdropFilter: 'blur(20px) saturate(1.55)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.55)',
        }}
      />
      <ModalSquircle
        className={clsx(
          'relative w-full flex flex-col overflow-hidden transition-[opacity,transform] duration-[55ms] ease-out',
          visible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-[0.97]',
        )}
        style={panelStyle}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="legal-modal-header flex items-center justify-between gap-4 px-6 sm:px-7 flex-shrink-0 border-b" style={{ borderColor: 'rgba(11, 6, 121, 0.2)', backgroundColor: 'rgb(255, 255, 255)' }}>
          <h2 className="flex-1 text-lg font-semibold text-[rgb(11,6,121)]">Tool Request</h2>
          <button
            type="button"
            onClick={requestClose}
            className="dialog-close-btn inline-flex h-9 w-9 min-h-9 min-w-9 shrink-0 items-center justify-center rounded-full p-0 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
            style={{ backgroundColor: 'rgb(11, 6, 121)', borderRadius: '50%' }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </button>
        </div>
        <form className="px-6 sm:px-7 py-6 pt-4 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700" htmlFor="header-tool-request">
              Tool request
            </label>
            <textarea
              id="header-tool-request"
              value={report}
              onChange={(event) => setReport(event.target.value)}
              required
              rows={6}
              className="w-full px-3 py-2 rounded-md border border-slate-400 bg-white text-sm focus:border-[rgb(11,6,121)] focus:outline-none focus:ring-2 focus:ring-[rgba(11,6,121,0.25)]"
              placeholder="Describe the research tool or resource you would like us to build."
            />
          </div>
          <div className="flex w-full items-center justify-between gap-4 pt-3 mb-4">
            <div className="text-sm">
              {error && <p className="text-red-600" role="alert">{error}</p>}
              {success && <p className="text-emerald-600" role="status">{success}</p>}
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center squircle-sm px-6 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(11,6,121,0.4)] transition duration-300 hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-60 disabled:cursor-not-allowed mb-[3px]"
              style={{ backgroundColor: 'rgb(11, 6, 121)' }}
            >
              {submitting ? 'Sending...' : 'Send'}
            </button>
          </div>
        </form>
      </ModalSquircle>
    </div>,
    portalRoot,
  );
}
