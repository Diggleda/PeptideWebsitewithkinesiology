import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react@0.487.0';
import clsx from 'clsx';
import termsHtml from '../content/legal/terms.html?raw';
import privacyHtml from '../content/legal/privacy.html?raw';
import shippingHtml from '../content/legal/shipping.html?raw';

type LegalDocumentKey = 'terms' | 'privacy' | 'shipping';

interface LegalDocumentContent {
  title: string;
  html: string;
}

const LEGAL_DOCUMENTS: Record<LegalDocumentKey, LegalDocumentContent> = {
  terms: {
    title: 'Terms of Service',
    html: termsHtml,
  },
  privacy: {
    title: 'Privacy Policy',
    html: privacyHtml,
  },
  shipping: {
    title: 'Shipping Policy',
    html: shippingHtml,
  },
};

interface LegalFooterProps {
  showContactCTA?: boolean;
}

export function LegalFooter({ showContactCTA = true }: LegalFooterProps) {
  const [activeDocument, setActiveDocument] = useState<LegalDocumentKey | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactVisible, setContactVisible] = useState(false);
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const [contactSuccess, setContactSuccess] = useState('');
  const [contactError, setContactError] = useState('');
  const [contactForm, setContactForm] = useState({ name: '', email: '', phone: '', source: '' });
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contactCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedDocument = activeDocument ? LEGAL_DOCUMENTS[activeDocument] : null;
  const MODAL_FADE_MS = 350;

  useEffect(() => {
    const body = document.body;
    const docEl = document.documentElement;
    const originalOverflow = body.style.overflow;
    const originalPaddingRight = body.style.paddingRight;

    if (activeDocument && !isClosing) {
      const scrollbarWidth = window.innerWidth - docEl.clientWidth;
      if (!originalPaddingRight && scrollbarWidth > 0) {
        body.style.paddingRight = `${scrollbarWidth}px`;
      }
      body.style.overflow = 'hidden';
      return () => {
        body.style.overflow = originalOverflow;
        body.style.paddingRight = originalPaddingRight;
      };
    }

    body.style.overflow = originalOverflow;
    body.style.paddingRight = originalPaddingRight;
    return undefined;
  }, [activeDocument, isClosing]);

  const legalLinks = useMemo(
    () => [
      { key: 'terms' as LegalDocumentKey, label: 'Terms of Service' },
      { key: 'privacy' as LegalDocumentKey, label: 'Privacy Policy' },
      { key: 'shipping' as LegalDocumentKey, label: 'Shipping Policy' },
    ],
    [],
  );

  const handleLinkClick = useCallback((key: LegalDocumentKey, options: { preserveDialogs?: boolean } = {}) => {
    console.debug('[LegalFooter] Link clicked', { key });
    if (!options.preserveDialogs) {
      window.dispatchEvent(new Event('peppro:close-dialogs'));
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsClosing(false);
    setIsVisible(false);
    setActiveDocument(key);
  }, []);

  const handleClose = () => {
    console.debug('[LegalFooter] Close requested', { activeDocument });
    if (!activeDocument || isClosing) {
      return;
    }
    setIsClosing(true);
    setIsVisible(false);
    closeTimerRef.current = setTimeout(() => {
      setActiveDocument(null);
      setIsClosing(false);
      closeTimerRef.current = null;
    }, MODAL_FADE_MS);
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    const handleExternalOpen = (event: Event) => {
      const custom = event as CustomEvent<{ key?: LegalDocumentKey; preserveDialogs?: boolean }>;
      const key = custom.detail?.key;
      if (!key) {
        return;
      }
      handleLinkClick(key, { preserveDialogs: Boolean(custom.detail?.preserveDialogs) });
    };
    window.addEventListener('peppro:open-legal', handleExternalOpen);
    return () => window.removeEventListener('peppro:open-legal', handleExternalOpen);
  }, [handleLinkClick]);

  useEffect(() => {
    if (selectedDocument && !isClosing) {
      const raf = requestAnimationFrame(() => setIsVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    if (!selectedDocument && !isClosing && isVisible) {
      setIsVisible(false);
    }
    return undefined;
  }, [selectedDocument, isClosing, isVisible]);

  useEffect(() => {
    const open = Boolean(selectedDocument);
    window.dispatchEvent(new CustomEvent('peppro:legal-state', { detail: { open } }));
    return () => {
      if (open) {
        window.dispatchEvent(new CustomEvent('peppro:legal-state', { detail: { open: false } }));
      }
    };
  }, [selectedDocument]);

  useEffect(() => () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
    if (contactCloseTimerRef.current) {
      clearTimeout(contactCloseTimerRef.current);
    }
  }, []);

  const handleContactOpen = useCallback(() => {
    if (contactCloseTimerRef.current) {
      clearTimeout(contactCloseTimerRef.current);
      contactCloseTimerRef.current = null;
    }
    setContactOpen(true);
    requestAnimationFrame(() => setContactVisible(true));
  }, []);

  const handleContactClose = useCallback(() => {
    if (!contactOpen) return;
    setContactVisible(false);
    if (contactCloseTimerRef.current) {
      clearTimeout(contactCloseTimerRef.current);
    }
    contactCloseTimerRef.current = setTimeout(() => {
      setContactOpen(false);
      contactCloseTimerRef.current = null;
    }, MODAL_FADE_MS);
  }, [contactOpen, MODAL_FADE_MS]);

  const handleContactSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setContactError('');
    setContactSuccess('');
    if (!contactForm.name.trim() || !contactForm.email.trim()) {
      setContactError('Name and email are required.');
      return;
    }
    setContactSubmitting(true);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: contactForm.name.trim(),
          email: contactForm.email.trim(),
          phone: contactForm.phone.trim(),
          source: contactForm.source.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Unable to send your message.');
      }
      setContactSuccess('Thanks! A representative will reach out shortly.');
      setContactForm({ name: '', email: '', phone: '', source: '' });
    } catch (error: any) {
      setContactError(error?.message || 'Unable to send your message. Please try again.');
    } finally {
      setContactSubmitting(false);
    }
  };

  const shouldBlurBackground = isVisible || isClosing || contactOpen;

  return (
    <>
      <footer className="relative z-10 mt-24 glass-strong">
        <div className="w-full px-4 sm:px-8 pt-12 pb-10">
          <div className="legal-footer-layout gap-4 items-start text-center lg:text-left lg:items-start lg:justify-items-start">
            {/* Contact CTA - top on mobile, right on desktop */}
            {showContactCTA && (
              <div className="legal-contact flex flex-col items-center justify-center lg:items-end lg:justify-center gap-2 text-center lg:text-right w-full pt-4 lg:pt-0">
                <p className="text-sm lg:pt-6 pb-2 font-medium text-slate-900">Want to join the Network?</p>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(new Event('peppro:close-dialogs'));
                    handleContactOpen();
                  }}
                  className="inline-flex items-center justify-center squircle-sm px-6 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(95,179,249,0.4)] transition duration-300 hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)]"
                  style={{ backgroundColor: 'rgb(95, 179, 249)' }}
                >
                  Contact a Representative
                </button>
              </div>
            )}

            {/* Disclaimer - left column on desktop, middle stack on mobile */}
            <div className="legal-disclaimer flex items-start justify-start w-full lg:w-auto lg:pr-10 lg:mr-auto lg:ml-0 lg:place-self-start lg:justify-self-start">
              <p className="text-xs text-slate-500 leading-relaxed pt-4 text-center lg:text-left w-full">
                PepPro peptide products are research chemicals intended for licensed physicians only. They are not intended to prevent, treat, or cure any medical condition, ailment or disease. These products have not been reviewed or approved by the US Food and Drug Administration.
              </p>
            </div>

            {/* Legal text + links - middle column on desktop, bottom on mobile */}
            <div className="legal-links flex flex-col items-center text-center gap-3 w-full lg:items-start lg:text-left">
              <div className="space-y-1 text-sm text-slate-600 w-full">
                <p>Advancing research-grade peptide access with care and compliance.</p>
                <p className="text-xs text-slate-500">© {new Date().getFullYear()} PepPro. All rights reserved.</p>
                <p className="text-xs text-slate-500"> This website design is guided by kinesiology for the highest good.</p>
              </div>
              <nav className="mt-1 mb-4 flex flex-wrap items-center justify-center lg:justify-start gap-3 text-sm font-medium text-[rgb(95,179,249)]">
                {legalLinks.map((link) => (
                  <button
                    key={link.key}
                    type="button"
                    className="cursor-pointer rounded-full px-3 py-1.5 transform transition duration-200 hover:-translate-y-0.5 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.4)] btn-hover-lighter"
                    onClick={() => handleLinkClick(link.key)}
                  >
                    {link.label}
                  </button>
                ))}
              </nav>
            </div>
          </div>
        </div>
      </footer>

      {selectedDocument && createPortal(
        <div
          className={clsx(
            'fixed inset-0 flex items-center justify-center p-6 sm:p-12 transition-opacity duration-[350ms] ease-out backdrop-blur-[16px] pointer-events-auto',
            isVisible ? 'opacity-100' : 'opacity-0',
          )}
          style={{
            zIndex: 2147483647,
            position: 'fixed',
            willChange: 'opacity',
            backdropFilter: shouldBlurBackground ? 'blur(16px)' : 'none',
            WebkitBackdropFilter: shouldBlurBackground ? 'blur(16px)' : 'none',
          }}
        >
          <div
            className={clsx(
              'absolute inset-0 bg-[rgba(4,14,21,0.55)] transition-opacity duration-[350ms] ease-out',
              isVisible ? 'opacity-100' : 'opacity-0',
            )}
            onClick={handleClose}
            aria-hidden="true"
            style={{
              willChange: 'opacity',
              backdropFilter: shouldBlurBackground ? 'blur(20px) saturate(1.55)' : 'none',
              WebkitBackdropFilter: shouldBlurBackground ? 'blur(20px) saturate(1.55)' : 'none',
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="legal-dialog-title"
            className={clsx(
              'relative w-full max-w-3xl flex flex-col transition-[opacity,transform] duration-[350ms] ease-out h-full',
              isVisible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-[0.97]',
            )}
            style={{
              willChange: 'opacity, transform',
              maxHeight: 'calc(var(--viewport-height, 100dvh) - 4rem)',
            }}
          >
            <div
              className="squircle-xl glass-card landing-glass shadow-[0_24px_60px_-25px_rgba(7,27,27,0.55)] h-full flex flex-col overflow-hidden border-[3px]"
              style={{
                backgroundColor: 'rgba(245, 251, 255, 0.94)',
                borderColor: 'rgba(95, 179, 249, 0.65)',
                backdropFilter: shouldBlurBackground ? 'blur(16px) saturate(1.45)' : 'none',
                WebkitBackdropFilter: shouldBlurBackground ? 'blur(16px) saturate(1.45)' : 'none',
              }}
            >
              <div className="flex items-center justify-between gap-4 px-6 sm:px-8 py-5 flex-shrink-0 border-b" style={{ borderColor: 'rgba(95, 179, 249, 0.2)', backgroundColor: 'rgb(255, 255, 255)' }}>
                <h2 id="legal-dialog-title" className="flex-1 text-xl sm:text-2xl font-semibold text-[rgb(95,179,249)] pr-2">
                  {selectedDocument.title}
                </h2>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClose();
                  }}
                  className="legal-modal-close-btn inline-flex items-center justify-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
                  style={{ backgroundColor: 'rgb(95, 179, 249)', width: '38px', height: '38px', borderRadius: '50%', marginTop: '6px', marginBottom: '6px' }}
                >
                  <X className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />
                  <span className="sr-only">Close</span>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-6 sm:px-8 py-8">
                <div
                  className="legal-richtext text-sm leading-relaxed text-slate-700"
                  dangerouslySetInnerHTML={{ __html: selectedDocument.html }}
                />
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
      {showContactCTA && contactOpen && createPortal(
        <div
          className={clsx(
            'fixed inset-0 flex items-center justify-center p-6 sm:p-12 transition-opacity duration-[350ms] ease-out backdrop-blur-[16px] pointer-events-auto',
            contactVisible ? 'opacity-100' : 'opacity-0',
          )}
          style={{
            zIndex: 2147483647,
            willChange: 'opacity',
            backdropFilter: shouldBlurBackground ? 'blur(16px)' : 'none',
            WebkitBackdropFilter: shouldBlurBackground ? 'blur(16px)' : 'none',
          }}
          onClick={handleContactClose}
          aria-modal="true"
          role="dialog"
        >
          <div
            className={clsx(
              'absolute inset-0 bg-[rgba(4,14,21,0.55)] transition-opacity duration-[350ms] ease-out',
              contactVisible ? 'opacity-100' : 'opacity-0',
            )}
            aria-hidden="true"
            style={{
              willChange: 'opacity',
              backdropFilter: shouldBlurBackground ? 'blur(20px) saturate(1.55)' : 'none',
              WebkitBackdropFilter: shouldBlurBackground ? 'blur(20px) saturate(1.55)' : 'none',
            }}
          />
          <div
            className={clsx(
              'relative w-full max-w-lg flex flex-col squircle-xl glass-card landing-glass shadow-[0_24px_60px_-25px_rgba(7,27,27,0.55)] overflow-hidden border-[3px] transition-[opacity,transform] duration-[350ms] ease-out',
              contactVisible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-[0.97]',
            )}
            style={{
              backgroundColor: 'rgba(245, 251, 255, 0.94)',
              borderColor: 'rgba(95, 179, 249, 0.65)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 px-6 sm:px-7 py-4 flex-shrink-0 border-b" style={{ borderColor: 'rgba(95, 179, 249, 0.2)', backgroundColor: 'rgb(255, 255, 255)' }}>
              <h2 className="flex-1 text-lg font-semibold text-[rgb(95,179,249)]">Contact Form</h2>
              <button
                type="button"
                onClick={handleContactClose}
                className="legal-modal-close-btn inline-flex items-center justify-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
                style={{ backgroundColor: 'rgb(95, 179, 249)', width: '38px', height: '38px', borderRadius: '50%' }}
              >
                <X className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />
                <span className="sr-only">Close</span>
              </button>
            </div>
            <form className="px-6 sm:px-7 py-6 pt-4 space-y-4" onSubmit={handleContactSubmit}>
              <div className="space-y-1">
                <label className="text-sm font-mediumtext-slate-700" htmlFor="contact-name">Name</label>
                <input
                  id="contact-name"
                  type="text"
                  value={contactForm.name}
                  onChange={(e) => setContactForm((prev) => ({ ...prev, name: e.target.value }))}
                  required
                  className="w-full h-10 px-3 rounded-md border border-slate-200 bg-white text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.25)]"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700" htmlFor="contact-email">Email</label>
                <input
                  id="contact-email"
                  type="email"
                  value={contactForm.email}
                  onChange={(e) => setContactForm((prev) => ({ ...prev, email: e.target.value }))}
                  required
                  className="w-full h-10 px-3 rounded-md border border-slate-200 bg-white text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.25)]"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700" htmlFor="contact-phone">Phone</label>
                <input
                  id="contact-phone"
                  type="tel"
                  value={contactForm.phone}
                  onChange={(e) => setContactForm((prev) => ({ ...prev, phone: e.target.value }))}
                  className="w-full h-10 px-3 rounded-md border border-slate-200 bg-white text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.25)]"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700" htmlFor="contact-source">How did you get introduced to PepPro?</label>
                <input
                  id="contact-source"
                  type="text"
                  value={contactForm.source}
                  onChange={(e) => setContactForm((prev) => ({ ...prev, source: e.target.value }))}
                  className="w-full h-10 px-3 rounded-md border border-slate-200 bg-white text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.25)]"
                />
              </div>
              <div className="flex w-full items-center justify-between pt-3 mb-4">
                <div className="text-sm">
                  {contactError && <p className="text-red-600" role="alert">{contactError}</p>}
                  {contactSuccess && <p className="text-emerald-600" role="status">{contactSuccess}</p>}
                </div>
                <button
                  type="submit"
                  disabled={contactSubmitting}
                  className="inline-flex items-center justify-center squircle-sm px-6 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(95,179,249,0.4)] transition duration-300 hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-60 disabled:cursor-not-allowed mb-[3px]"
                  style={{ backgroundColor: 'rgb(95, 179, 249)' }}
                >
                  {contactSubmitting ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
