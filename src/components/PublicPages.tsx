import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { listProducts } from '../lib/wooClient';
import { MERCHANT_IDENTITY } from '../lib/merchantIdentity';
import { LEGAL_DOCUMENTS } from '../lib/legalDocuments';
import { LegalFooter } from './LegalFooter';
import { BrandLogoImage } from './BrandLogoImage';

type PublicPageKey =
  | 'contact'
  | 'pricing'
  | 'returns-refunds';

const PUBLIC_PATHS: Record<string, PublicPageKey> = {
  '/contact': 'contact',
  '/pricing': 'pricing',
  '/returns-refunds': 'returns-refunds',
};

export const isPublicSitePath = (pathname: string) => Boolean(PUBLIC_PATHS[pathname]);

const PageContainer = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <div className="glass-card squircle-xl border border-[var(--brand-glass-border-1)] bg-white/80 p-7 sm:p-10">
      <h1 className="text-2xl sm:text-3xl font-semibold text-slate-900">{title}</h1>
      <div className="mt-6 text-slate-800">{children}</div>
    </div>
  </div>
);

const PublicTopNav = () => (
  <header className="w-full glass-strong">
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <a href="/" className="flex items-center gap-3 min-w-0">
          <BrandLogoImage
            alt="TrufusionLabs"
            className="h-10 w-auto object-contain"
            loading="eager"
            decoding="async"
          />
          <span className="sr-only">TrufusionLabs home</span>
        </a>
        <nav className="flex flex-wrap items-center gap-2 text-sm font-medium text-[rgb(11,6,121)]">
          <a className="rounded-full px-3 py-1.5 btn-hover-lighter" href="/pricing">Pricing</a>
          <a className="rounded-full px-3 py-1.5 btn-hover-lighter" href="/contact">Contact</a>
          <a className="rounded-full px-3 py-1.5 btn-hover-lighter" href="/returns-refunds">Returns</a>
        </nav>
      </div>
    </div>
  </header>
);

const ContactPage = () => (
  <PageContainer title="Contact">
    <div className="space-y-6 text-sm leading-relaxed text-slate-800">
      <p className="text-xs text-slate-600">
        Last updated: {LEGAL_DOCUMENTS.contact.lastUpdated} | Version: {LEGAL_DOCUMENTS.contact.version}
      </p>
      <div className="space-y-2">
        <p className="font-semibold text-slate-900">Merchant identity</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
          <p><span className="font-semibold">TrufusionLabs</span></p>
          <p><span className="font-semibold">DBA:</span> {MERCHANT_IDENTITY.dba}</p>
          <p><span className="font-semibold">Legal Entity:</span> {MERCHANT_IDENTITY.legalEntity}</p>
          <p><span className="font-semibold">Address:</span> {MERCHANT_IDENTITY.address}</p>
          <p><span className="font-semibold">Phone:</span> {MERCHANT_IDENTITY.phone}</p>
          <p><span className="font-semibold">Email:</span> <a className="text-[rgb(11,6,121)] underline" href={`mailto:${MERCHANT_IDENTITY.email}`}>{MERCHANT_IDENTITY.email}</a></p>
          <p><span className="font-semibold">Business Hours:</span> {MERCHANT_IDENTITY.businessHours}</p>
        </div>
      </div>

      <div className="rounded-xl border border-[rgba(15,23,42,0.12)] bg-white/70 p-4">
        <p className="font-semibold text-slate-900">Customer service</p>
        <p className="mt-1">
          For order support, billing questions, shipping or returns help, account questions, privacy requests, or general inquiries, email <a className="text-[rgb(11,6,121)] underline" href={`mailto:${MERCHANT_IDENTITY.email}`}>{MERCHANT_IDENTITY.email}</a> or call {MERCHANT_IDENTITY.phone}.
        </p>
      </div>

      <p className="text-xs text-slate-600">
        TrufusionLabs provides research-use-only products and physician-directed research commerce workflows. Please do not submit protected health information through ordinary contact or support channels unless a separate written agreement permits it.
      </p>
    </div>
  </PageContainer>
);

const ReturnsRefundsPage = () => (
  <PageContainer title="Returns & Refunds Policy">
    <div className="space-y-4 text-sm leading-relaxed text-slate-800">
      <p className="text-xs text-slate-600">
        Last updated: {LEGAL_DOCUMENTS.returns.lastUpdated} | Version: {LEGAL_DOCUMENTS.returns.version}
      </p>
      <div className="space-y-2">
        <p className="font-semibold text-slate-900">Final sale baseline</p>
        <p>
          All sales are final unless TrufusionLabs approves a return, refund, replacement, or credit in writing.
        </p>
        <p>
          We review requests involving damaged shipments, incorrect products, missing items, incomplete orders, fulfillment errors, duplicate charges, or other issues we determine are eligible.
        </p>
      </div>
      <div className="space-y-2">
        <p className="font-semibold text-slate-900">Reporting window</p>
        <p>
          Requests must be submitted within <span className="font-semibold">7 days</span> of delivery or pickup availability.
        </p>
      </div>
      <div className="space-y-2">
        <p className="font-semibold text-slate-900">Approved resolutions</p>
        <p>
          If approved, we may issue a refund to the original payment method, provide a replacement shipment, apply account credit, correct the order, or take another reasonable action.
        </p>
      </div>
      <div className="space-y-2">
        <p className="font-semibold text-slate-900">How to request a return or refund</p>
        <p>
          Email <a className="text-[rgb(11,6,121)] underline" href={`mailto:${MERCHANT_IDENTITY.email}`}>{MERCHANT_IDENTITY.email}</a> and include your order number, the reason for the request, and (if applicable) photos of damage.
        </p>
      </div>
    </div>
  </PageContainer>
);

type PricingRow = { id: string; name: string; price: string; currency: string };

const formatUsd = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

const PricingPage = () => {
  const [rows, setRows] = useState<PricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listProducts<any[]>({ per_page: 12 })
      .then((data) => {
        if (cancelled) return;
        const products = Array.isArray(data) ? data : [];
        const mapped: PricingRow[] = products
          .map((product: any) => {
            const id = product?.id != null ? String(product.id) : '';
            const name = typeof product?.name === 'string' ? product.name : '';
            const priceRaw = product?.price ?? product?.regular_price ?? product?.sale_price;
            const priceNum = Number(priceRaw);
            const price = Number.isFinite(priceNum) ? formatUsd(priceNum) : '';
            return { id, name, price, currency: 'USD' };
          })
          .filter((row) => row.name && row.price);
        setRows(mapped);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(typeof err?.message === 'string' ? err.message : 'Unable to load pricing.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const content = useMemo(() => {
    if (loading) {
      return <p className="text-sm text-slate-700">Loading pricing…</p>;
    }
    if (rows.length === 0) {
      return (
        <div className="space-y-2 text-sm text-slate-700">
          {error ? <p className="text-red-700">{error}</p> : null}
          <p>Pricing is currently unavailable.</p>
          <p className="text-xs text-slate-600">
            If you are an underwriter and cannot view pricing here, please contact <a className="text-[rgb(11,6,121)] underline" href={`mailto:${MERCHANT_IDENTITY.email}`}>{MERCHANT_IDENTITY.email}</a>.
          </p>
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-slate-700">
              <th className="py-2 pr-4 font-semibold">Product</th>
              <th className="py-2 pr-4 font-semibold">Price</th>
              <th className="py-2 font-semibold">Currency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id || row.name} className="border-t border-[rgba(15,23,42,0.10)]">
                <td className="py-2 pr-4 text-slate-900">{row.name}</td>
                <td className="py-2 pr-4 text-slate-900">{row.price}</td>
                <td className="py-2 text-slate-700">{row.currency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }, [error, loading, rows]);

  return (
    <PageContainer title="Pricing (USD)">
      <div className="space-y-5">
        <p className="text-sm text-slate-700">
          Sample product pricing is shown below in USD. Final pricing, discounts, credits, taxes, shipping, and availability may vary by account, product, quantity, location, verification status, and permitted workflow configuration.
        </p>
        {content}
        <p className="text-xs text-slate-600">
          Research use only. Pricing and catalog information are not medical advice, prescribing guidance, treatment recommendations, or claims of safety, efficacy, or suitability.
        </p>
      </div>
    </PageContainer>
  );
};

export function PublicSite({ pathname }: { pathname: string }) {
  const key = PUBLIC_PATHS[pathname];
  const content = (() => {
    switch (key) {
      case 'contact':
        return <ContactPage />;
      case 'pricing':
        return <PricingPage />;
      case 'returns-refunds':
        return <ReturnsRefundsPage />;
      default:
        return (
          <PageContainer title="Not found">
            <p className="text-sm text-slate-700">That page does not exist.</p>
            <a className="mt-4 inline-flex text-[rgb(11,6,121)] underline" href="/">Return home</a>
          </PageContainer>
        );
    }
  })();

  return (
    <div className="min-h-screen flex flex-col">
      <PublicTopNav />
      <main className="flex-1">{content}</main>
      <LegalFooter showContactCTA={false} variant="full" />
    </div>
  );
}
