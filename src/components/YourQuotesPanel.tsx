import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { IdentificationIcon } from '@heroicons/react/24/outline';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ProductImageCarousel } from './ProductImageCarousel';
import { Textarea } from './ui/textarea';
import { Download, RefreshCw, Save, ShoppingCart, Trash2 } from 'lucide-react';
import type { ProspectQuoteDetail, ProspectQuoteLineItem, ProspectQuoteRevision } from '../types/quotes';

export type SelectableProspectQuoteTarget = {
  identifier: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string | null;
  updatedAt: string | null;
  salesRepId: string | null;
  doctorId: string | null;
  referralId: string | null;
  contactFormId: string | null;
};

type Props = {
  selectedProspect: SelectableProspectQuoteTarget | null;
  quoteLoading: boolean;
  quoteError: string | null;
  currentDraft: ProspectQuoteDetail | null;
  history: ProspectQuoteRevision[];
  titleDraft: string;
  notesDraft: string;
  cartItemCount: number;
  importBusy: boolean;
  saveBusy: boolean;
  exportBusy: boolean;
  importDisabled: boolean;
  saveDisabled: boolean;
  exportDisabled: boolean;
  deleteBusyId: string | null;
  resolveItemImageUrl?: (item: ProspectQuoteLineItem) => string | null;
  onTitleChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onImportCart: () => void;
  onSaveDraft: () => void;
  onExportPdf: (quoteId: string) => void;
  onDeleteQuote: (quoteId: string) => void;
};

const formatCurrency = (value: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: String(currency || 'USD').trim().toUpperCase() || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(Number(value)) ? Number(value) : 0);

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return 'Unknown';
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return 'Unknown';
  return new Date(parsed).toLocaleString();
};

const formatQuoteStatus = (value: string | null | undefined) => {
  const normalized = String(value || '').trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

export function YourQuotesPanel({
  selectedProspect,
  quoteLoading,
  quoteError,
  currentDraft,
  history,
  titleDraft,
  notesDraft,
  cartItemCount,
  importBusy,
  saveBusy,
  exportBusy,
  importDisabled,
  saveDisabled,
  exportDisabled,
  deleteBusyId,
  resolveItemImageUrl,
  onTitleChange,
  onNotesChange,
  onImportCart,
  onSaveDraft,
  onExportPdf,
  onDeleteQuote,
}: Props) {
  const draftItems = Array.isArray(currentDraft?.quotePayloadJson?.items)
    ? currentDraft.quotePayloadJson.items
    : [];
  const draftCurrency = currentDraft?.currency || currentDraft?.quotePayloadJson?.currency || 'USD';
  const previousQuotesLabel = `${history.length} Previous ${history.length === 1 ? 'quote' : 'quotes'}`;
  const shouldShowSaveDraft = saveBusy || !saveDisabled;
  const [renderSaveDraftControl, setRenderSaveDraftControl] = useState(shouldShowSaveDraft);
  const [saveDraftVisible, setSaveDraftVisible] = useState(shouldShowSaveDraft);
  const saveDraftMountedRef = useRef(false);
  const saveDraftFadeTimerRef = useRef<number | null>(null);
  const saveDraftFadeFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (saveDraftFadeTimerRef.current !== null) {
      window.clearTimeout(saveDraftFadeTimerRef.current);
      saveDraftFadeTimerRef.current = null;
    }
    if (saveDraftFadeFrameRef.current !== null) {
      window.cancelAnimationFrame(saveDraftFadeFrameRef.current);
      saveDraftFadeFrameRef.current = null;
    }

    if (!saveDraftMountedRef.current) {
      saveDraftMountedRef.current = true;
      return;
    }

    if (shouldShowSaveDraft) {
      setSaveDraftVisible(false);
      setRenderSaveDraftControl(true);
      let innerFrame: number | null = null;
      saveDraftFadeFrameRef.current = window.requestAnimationFrame(() => {
        innerFrame = window.requestAnimationFrame(() => {
          setSaveDraftVisible(true);
          saveDraftFadeFrameRef.current = null;
        });
      });
      return () => {
        if (saveDraftFadeFrameRef.current !== null) {
          window.cancelAnimationFrame(saveDraftFadeFrameRef.current);
          saveDraftFadeFrameRef.current = null;
        }
        if (innerFrame !== null) {
          window.cancelAnimationFrame(innerFrame);
        }
      };
    }

    setSaveDraftVisible(false);
    saveDraftFadeTimerRef.current = window.setTimeout(() => {
      setRenderSaveDraftControl(false);
      saveDraftFadeTimerRef.current = null;
    }, 180);

    return () => {
      if (saveDraftFadeTimerRef.current !== null) {
        window.clearTimeout(saveDraftFadeTimerRef.current);
        saveDraftFadeTimerRef.current = null;
      }
      if (saveDraftFadeFrameRef.current !== null) {
        window.cancelAnimationFrame(saveDraftFadeFrameRef.current);
        saveDraftFadeFrameRef.current = null;
      }
    };
  }, [shouldShowSaveDraft]);

  return (
    <section className="lead-panel sales-rep-leads-card sales-rep-combined-card w-full min-w-0">
      {!selectedProspect ? (
        <>
          <div className="lead-panel-header">
            <div className="sales-rep-leads-title min-w-0">
              <p>Pick a lead, import the current cart, and export a polished PDF.</p>
            </div>
          </div>
          <div className="lead-list-scroll">
            <p className="lead-panel-empty px-1 py-2 text-sm text-slate-500">
              Begin a new quote by clicking &quot;Manage their quotes&quot; on a prospect in the Your Leads tab.
            </p>
          </div>
        </>
      ) : (
        <div className="space-y-5">
          <div className="quote-selected-header pb-4">
            <div className="quote-selected-summary">
              <div className="flex min-w-0 items-center gap-2">
                <IdentificationIcon className="h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
                <h4 className="min-w-0 flex-1 truncate text-xl font-semibold text-slate-900">
                  {selectedProspect.name}
                </h4>
              </div>
              <div className="mb-2 min-w-0 space-y-1 text-sm text-slate-600">
                {selectedProspect.email ? <div className="truncate">{selectedProspect.email}</div> : null}
              </div>
            </div>
          </div>

          {quoteLoading ? (
            <div className="lead-panel-empty rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-8">
              Loading quote history…
            </div>
          ) : quoteError ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-700">
              {quoteError}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="lead-panel bg-slate-50/80">
                <div className="quote-compose-header pb-3">
                  <h3 className="quote-compose-title text-lg font-semibold text-slate-900 sm:text-xl">Make a quote</h3>
                  <div className="quote-compose-actions">
                    {renderSaveDraftControl ? (
                      <div className={`quote-save-draft-shell ${saveDraftVisible ? 'is-visible' : 'is-hidden'}`}>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={onSaveDraft}
                          disabled={saveDisabled}
                          className="header-home-button squircle-sm bg-white text-slate-900"
                        >
                          {saveBusy ? (
                            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Save className="h-4 w-4" aria-hidden="true" />
                          )}
                          Save Draft
                        </Button>
                      </div>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onImportCart}
                      disabled={importDisabled}
                      className="header-home-button squircle-sm bg-white text-slate-900"
                    >
                      {importBusy ? (
                        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                      )}
                      Import Cart
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => currentDraft?.id && onExportPdf(currentDraft.id)}
                      disabled={exportDisabled}
                      className="header-home-button squircle-sm"
                    >
                      {exportBusy ? (
                        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Download className="h-4 w-4" aria-hidden="true" />
                      )}
                      Download PDF
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Quote Title
                  </label>
                  <Input
                    value={titleDraft}
                    onChange={(event) => onTitleChange(event.target.value)}
                    placeholder="Quote title"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Notes
                  </label>
                  <Textarea
                    value={notesDraft}
                    onChange={(event) => onNotesChange(event.target.value)}
                    placeholder="Optional notes for this quote revision"
                    className="min-h-[120px]"
                  />
                </div>

                <div className="mt-2 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Line items
                    </div>
                    <div className="text-right text-xs font-medium text-slate-500">
                      Cart items ready: {cartItemCount}
                    </div>
                  </div>
                  {draftItems.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-5 text-sm text-slate-500">
                      Nothing yet! Click &quot;Import Cart&quot; to create a draft for this prospect.
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-2xl bg-white">
                      {draftItems.map((item, index) => {
                        const itemImageUrl = resolveItemImageUrl?.(item) || item.imageUrl || undefined;
                        return (
                          <div key={`${item.productId || item.name}-${item.position}`} className="px-4 py-3">
                            {index > 0 ? <div className="mb-3 border-t border-slate-200" /> : null}
                            <div className="flex items-start mb-2 justify-between gap-3">
                              <div className="flex min-w-0 items-start gap-3">
                                <div className="quote-line-item-image self-start">
                                  <ProductImageCarousel
                                    images={itemImageUrl ? [itemImageUrl] : []}
                                    alt={item.name}
                                    className="flex h-full w-full items-center justify-center rounded-lg bg-white/80 p-2"
                                    imageClassName="h-full w-full object-contain"
                                    style={{ '--product-image-frame-padding': 'clamp(0.2rem, 0.4vw, 0.45rem)' } as CSSProperties}
                                    showDots={false}
                                    showArrows={false}
                                  />
                                </div>
                                <div className="min-w-0">
                                  <div className="font-semibold text-slate-900">{item.name}</div>
                                  {item.note ? (
                                    <div className="mt-1 text-xs text-slate-500">{item.note}</div>
                                  ) : null}
                                </div>
                              </div>
                              <div className="text-right text-sm text-slate-700">
                                <div>Qty {item.quantity}</div>
                                <div>{formatCurrency(item.lineTotal, draftCurrency)}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="lead-panel bg-slate-50/80">
                <div className="border-b border-slate-200/80 pb-3">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900 sm:text-xl">{previousQuotesLabel}</h3>
                    <div className="mb-2 text-xs text-slate-500">Drafts stay editable until they are exported.</div>
                  </div>
                </div>
                <div className="mt-3 max-h-[470px] space-y-2 overflow-y-auto pr-1">
                  {history.length === 0 ? (
                    <div className="lead-panel-empty rounded-2xl bg-white px-4 py-6">
                      No saved revisions yet.
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-2xl bg-white">
                      {history.map((quote, index) => {
                        const isDeleting = deleteBusyId === quote.id;
                        return (
                          <div key={quote.id} className="px-4 py-3">
                            {index > 0 ? <div className="mb-3 border-t border-slate-200" /> : null}
                            <div className="quote-history-row">
                              <div className="quote-history-copy">
                                <div className="truncate text-sm font-semibold text-slate-900">{quote.title}</div>
                                <div className="mt-1 text-xs text-slate-500">
                                  Revision R{quote.revisionNumber} • {formatQuoteStatus(quote.status)}
                                </div>
                                <div className="mt-1 text-xs text-slate-500">
                                  Updated {formatDateTime(quote.updatedAt)}
                                </div>
                              </div>
                              <div className="quote-history-actions">
                                <div className="quote-history-total text-sm font-semibold text-slate-900">
                                  {formatCurrency(quote.subtotal, quote.currency)}
                                </div>
                                <div className="quote-history-action-row mb-2">
                                  {quote.status === 'exported' ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      onClick={() => onExportPdf(quote.id)}
                                      disabled={exportBusy || deleteBusyId !== null}
                                      className="quote-history-download header-home-button squircle-sm h-9"
                                    >
                                      <Download className="h-4 w-4" aria-hidden="true" />
                                      Download PDF
                                    </Button>
                                  ) : (
                                    <span className="quote-history-action-spacer" aria-hidden="true" />
                                  )}
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    onClick={() => onDeleteQuote(quote.id)}
                                    disabled={isDeleting || exportBusy || deleteBusyId !== null}
                                    className="quote-history-delete header-home-button squircle-sm h-9 w-9 shrink-0"
                                    aria-label={`Delete ${quote.title}`}
                                    title="Delete quote"
                                  >
                                    {isDeleting ? (
                                      <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                                    ) : (
                                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                                    )}
                                  </Button>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
