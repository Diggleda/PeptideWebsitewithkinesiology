import { useState } from 'react';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Package, Eye, EyeOff, Loader2, Download, RotateCcw } from 'lucide-react';

// Mock order data
interface OrderLineItem {
  id: string;
  name: string;
  quantity: number;
  total: number;
  price: number;
  sku: string;
}

interface OrderSummary {
  id: string;
  number: string;
  status: string;
  currency: string;
  total: number;
  createdAt: string;
  updatedAt: string;
  source: 'local' | 'woocommerce';
  lineItems: OrderLineItem[];
  integrations?: any;
  integrationDetails?: {
    wooCommerce?: {
      status?: string;
      pepproOrderId?: string;
      billingName?: string;
      billingEmail?: string;
      invoiceUrl?: string;
    };
    shipEngine?: {
      carrier?: string;
      trackingNumber?: string;
      trackingUrl?: string;
      status?: string;
      eta?: string;
    };
  };
  paymentMethod: string;
}

const mockOrders: OrderSummary[] = [
  {
    id: '1',
    number: '12845',
    status: 'completed',
    currency: 'USD',
    total: 2847.50,
    createdAt: '2024-11-10T14:30:00Z',
    updatedAt: '2024-11-12T09:15:00Z',
    source: 'woocommerce',
    paymentMethod: 'Credit Card',
    lineItems: [
      { id: '1', name: 'Semaglutide 5mg', quantity: 10, total: 1250.00, price: 125.00, sku: 'SEM-5MG-001' },
      { id: '2', name: 'Tirzepatide 10mg', quantity: 8, total: 1520.00, price: 190.00, sku: 'TIR-10MG-002' },
      { id: '3', name: 'BPC-157 5mg', quantity: 5, total: 77.50, price: 15.50, sku: 'BPC-5MG-003' },
    ],
    integrationDetails: {
      wooCommerce: {
        status: 'completed',
        pepproOrderId: '12845',
        billingName: 'Dr. Sarah Johnson',
        billingEmail: 'sarah.johnson@healthclinic.com',
        invoiceUrl: 'https://example.com/invoice/12845.pdf',
      },
      shipEngine: {
        carrier: 'FedEx',
        trackingNumber: '784523691234',
        trackingUrl: 'https://fedex.com/track/784523691234',
        status: 'Delivered',
        eta: 'Nov 12, 2024',
      },
    },
  },
  {
    id: '2',
    number: '12832',
    status: 'processing',
    currency: 'USD',
    total: 1890.00,
    createdAt: '2024-11-15T10:20:00Z',
    updatedAt: '2024-11-15T14:45:00Z',
    source: 'woocommerce',
    paymentMethod: 'Bank Transfer',
    lineItems: [
      { id: '4', name: 'Lisinopril 10mg', quantity: 30, total: 450.00, price: 15.00, sku: 'LIS-10MG-004' },
      { id: '5', name: 'Metformin 500mg', quantity: 60, total: 720.00, price: 12.00, sku: 'MET-500MG-005' },
      { id: '6', name: 'Atorvastatin 20mg', quantity: 40, total: 720.00, price: 18.00, sku: 'ATO-20MG-006' },
    ],
    integrationDetails: {
      wooCommerce: {
        status: 'processing',
        pepproOrderId: '12832',
        billingName: 'Dr. Michael Chen',
        billingEmail: 'michael.chen@wellness.org',
      },
      shipEngine: {
        carrier: 'UPS',
        trackingNumber: '1Z9999999999999999',
        trackingUrl: 'https://ups.com/track/1Z9999999999999999',
        status: 'In Transit',
        eta: 'Nov 18, 2024',
      },
    },
  },
  {
    id: '3',
    number: '12819',
    status: 'pending',
    currency: 'USD',
    total: 425.00,
    createdAt: '2024-11-16T16:00:00Z',
    updatedAt: '2024-11-16T16:05:00Z',
    source: 'woocommerce',
    paymentMethod: 'Credit Card',
    lineItems: [
      { id: '7', name: 'TB-500 5mg', quantity: 5, total: 425.00, price: 85.00, sku: 'TB5-5MG-007' },
    ],
    integrationDetails: {
      wooCommerce: {
        status: 'pending',
        pepproOrderId: '12819',
        billingName: 'Dr. Emily Martinez',
        billingEmail: 'emily.martinez@medcenter.com',
      },
    },
  },
  {
    id: '4',
    number: '12803',
    status: 'trash',
    currency: 'USD',
    total: 890.00,
    createdAt: '2024-11-08T11:30:00Z',
    updatedAt: '2024-11-09T09:20:00Z',
    source: 'woocommerce',
    paymentMethod: 'Credit Card',
    lineItems: [
      { id: '8', name: 'NAD+ 500mg', quantity: 10, total: 890.00, price: 89.00, sku: 'NAD-500MG-008' },
    ],
    integrationDetails: {
      wooCommerce: {
        status: 'canceled',
        pepproOrderId: '12803',
        billingName: 'Dr. Robert Williams',
        billingEmail: 'robert.williams@clinic.net',
      },
    },
  },
];

const formatOrderDate = (value?: string | null) => {
  if (!value) return 'Pending';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatCurrency = (amount?: number | null, currency = 'USD') => {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
};

const humanizeOrderStatus = (status?: string | null) => {
  if (!status) return 'Pending';
  const normalized = status.trim().toLowerCase();
  if (normalized === 'trash') return 'Canceled';
  return status
    .split(/[_\s]+/)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
};

export default function OrdersTabDemo() {
  const [showCanceledOrders, setShowCanceledOrders] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<OrderSummary | null>(null);
  const [accountOrdersLoading] = useState(false);
  const accountOrders = mockOrders;

  const renderOrdersList = () => {
    const visibleOrders = accountOrders
      .filter((order) => order.source === 'woocommerce')
      .filter((order) => {
        if (showCanceledOrders) return true;
        const status = order.status ? String(order.status).trim().toLowerCase() : '';
        return status !== 'canceled' && status !== 'trash';
      });

    if (!visibleOrders.length) {
      return (
        <div className="text-center py-12">
          <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] inline-block">
            <Package className="h-12 w-12 mx-auto mb-3 text-slate-400" />
            <p className="text-sm font-medium text-slate-700 mb-1">No orders found</p>
            <p className="text-xs text-slate-500">Your recent orders will appear here</p>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {visibleOrders.map((order) => {
          const status = humanizeOrderStatus(order.status);
          const statusNormalized = (order.status || '').toLowerCase();
          const isCanceled = statusNormalized.includes('cancel') || statusNormalized === 'trash';
          const isCompleted = statusNormalized.includes('complete');
          const isProcessing = statusNormalized.includes('processing');

          return (
            <div
              key={`${order.source}-${order.id}`}
              className="glass-card squircle-lg border border-[var(--brand-glass-border-2)] overflow-hidden hover:shadow-md transition-all duration-300"
            >
              {/* Order Header */}
              <div className="px-5 py-4 border-b border-[var(--brand-glass-border-1)] bg-gradient-to-r from-[rgba(95,179,249,0.04)] to-transparent">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
                        isCompleted
                          ? 'bg-green-100'
                          : isCanceled
                          ? 'bg-red-100'
                          : isProcessing
                          ? 'bg-blue-100'
                          : 'bg-slate-100'
                      }`}
                    >
                      <Package
                        className={`h-5 w-5 ${
                          isCompleted
                            ? 'text-green-600'
                            : isCanceled
                            ? 'text-red-600'
                            : isProcessing
                            ? 'text-blue-600'
                            : 'text-slate-600'
                        }`}
                      />
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-900">Order #{order.number}</h4>
                      <p className="text-xs text-slate-500 mt-0.5">{formatOrderDate(order.createdAt)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`squircle-sm ${
                        isCompleted
                          ? 'bg-green-50 text-green-700 border-green-200'
                          : isCanceled
                          ? 'bg-red-50 text-red-700 border-red-200'
                          : isProcessing
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : 'bg-slate-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      {status}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="squircle-sm bg-[rgba(95,179,249,0.08)] text-[rgb(28,109,173)] border-[rgba(95,179,249,0.2)]"
                    >
                      {order.source === 'woocommerce' ? 'Store' : 'PepPro'}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Order Body */}
              <div className="px-5 py-4">
                {/* Items Summary */}
                {order.lineItems && order.lineItems.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">Items</p>
                    <div className="space-y-1.5">
                      {order.lineItems.slice(0, 3).map((line, idx) => (
                        <div key={line.id || idx} className="flex items-center justify-between text-sm">
                          <span className="text-slate-700">
                            {line.name} <span className="text-slate-500">× {line.quantity}</span>
                          </span>
                          <span className="font-medium text-slate-900">
                            {formatCurrency(line.total, order.currency)}
                          </span>
                        </div>
                      ))}
                      {order.lineItems.length > 3 && (
                        <p className="text-xs text-slate-500 italic">
                          +{order.lineItems.length - 3} more item{order.lineItems.length - 3 !== 1 ? 's' : ''}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Total and Actions */}
                <div className="flex items-center justify-between pt-4 border-t border-[var(--brand-glass-border-1)]">
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Order Total</p>
                    <p className="text-lg font-bold text-slate-900">{formatCurrency(order.total, order.currency)}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="squircle-sm glass btn-hover-lighter"
                    onClick={() => setSelectedOrder(order)}
                  >
                    View Details
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderOrderDetails = () => {
    if (!selectedOrder) return null;

    const status = humanizeOrderStatus(selectedOrder.status);
    const statusNormalized = (selectedOrder.status || '').toLowerCase();
    const isCanceled = statusNormalized.includes('cancel') || statusNormalized === 'trash';
    const isCompleted = statusNormalized.includes('complete');
    const isProcessing = statusNormalized.includes('processing');
    const lines = selectedOrder.lineItems || [];
    const integrations = selectedOrder.integrationDetails || {};
    const wooIntegration = integrations?.wooCommerce || null;
    const shipIntegration = integrations?.shipEngine || null;
    const displayOrderId = wooIntegration?.pepproOrderId || selectedOrder.number || selectedOrder.id;

    const handleDownloadCSV = () => {
      const csvData = [
        ['Item Name', 'SKU', 'Quantity', 'Unit Price', 'Total'],
        ...lines.map((line) => [
          line.name,
          line.sku,
          line.quantity,
          line.price,
          line.total,
        ]),
        ['', '', '', 'Order Total:', selectedOrder.total],
      ];
      const csvContent = csvData.map((row) => row.join(',')).join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `order-${displayOrderId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    };

    const handleOrderAgain = () => {
      alert(`Adding items from Order #${displayOrderId} to cart...`);
    };

    return (
      <div className="space-y-5">
        {/* Header Section - Matching list view layout */}
        <div className="glass-card squircle-lg border border-[var(--brand-glass-border-2)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--brand-glass-border-1)] bg-gradient-to-r from-[rgba(95,179,249,0.04)] to-transparent">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <div
                  className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
                    isCompleted
                      ? 'bg-green-100'
                      : isCanceled
                      ? 'bg-red-100'
                      : isProcessing
                      ? 'bg-blue-100'
                      : 'bg-slate-100'
                  }`}
                >
                  <Package
                    className={`h-5 w-5 ${
                      isCompleted
                        ? 'text-green-600'
                        : isCanceled
                        ? 'text-red-600'
                        : isProcessing
                        ? 'text-blue-600'
                        : 'text-slate-600'
                    }`}
                  />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-semibold text-slate-900">Order #{displayOrderId}</h4>
                    <Badge
                      variant="outline"
                      className={`squircle-sm ${
                        isCompleted
                          ? 'bg-green-50 text-green-700 border-green-200'
                          : isCanceled
                          ? 'bg-red-50 text-red-700 border-red-200'
                          : isProcessing
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : 'bg-slate-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      {status}
                    </Badge>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">{formatOrderDate(selectedOrder.createdAt)}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedOrder(null)}
                  className="squircle-sm glass btn-hover-lighter"
                >
                  ← Back
                </Button>
              </div>
            </div>

            {/* Action Buttons Row */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={handleOrderAgain}
                className="squircle-sm mt-2 border border-[rgb(95,179,249)] text-slate-900 hover:bg-[rgba(95,179,249,0.08)]"
              >
                <RotateCcw className="h-4 w-4 mr-1.5" />
                Order Again
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDownloadCSV}
                className="squircle-sm glass btn-hover-lighter"
              >
                <Download className="h-4 w-4 mr-1.5" />
                Download CSV
              </Button>
              {wooIntegration?.invoiceUrl && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle-sm glass btn-hover-lighter"
                  onClick={() => {
                    if (wooIntegration?.invoiceUrl) {
                      window.open(wooIntegration.invoiceUrl, '_blank', 'noopener,noreferrer');
                    }
                  }}
                >
                  <Download className="h-4 w-4 mr-1.5" />
                  Invoice PDF
                </Button>
              )}
            </div>
          </div>

          {/* Order Info Row - Compact single row */}
          <div className="px-5 py-3 bg-slate-50/50">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500">Total:</span>
                <span className="font-bold text-slate-900 text-sm">
                  {formatCurrency(selectedOrder.total, selectedOrder.currency)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500">Payment:</span>
                <span className="font-medium text-slate-900">{selectedOrder.paymentMethod}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500">Updated:</span>
                <span className="font-medium text-slate-900">{formatOrderDate(selectedOrder.updatedAt)}</span>
              </div>
              {wooIntegration?.billingName && (
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">Customer:</span>
                  <span className="font-medium text-slate-900">{wooIntegration.billingName}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Status Timeline */}
        <div className="glass-card squircle-lg p-5 border border-[var(--brand-glass-border-2)]">
          <h4 className="text-sm font-semibold text-slate-800 mb-4">Order Progress</h4>
          {(() => {
            const steps = isCanceled ? ['pending', 'processing', 'canceled'] : ['pending', 'processing', 'completed'];
            const activeIndex =
              steps.findIndex((step) => statusNormalized.includes(step)) >= 0
                ? steps.findIndex((step) => statusNormalized.includes(step))
                : 0;
            const brand = 'rgb(95, 179, 249)';
            const muted = 'rgba(148,163,184,0.4)';

            return (
              <div className="relative py-2">
                {/* Progress Bar Background */}
                <div className="absolute top-1/2 left-0 right-0 h-1 bg-slate-200/60 -translate-y-1/2" style={{ zIndex: 0 }} />

                {/* Progress Bar Fill */}
                <div
                  className="absolute top-1/2 left-0 h-1 -translate-y-1/2 transition-all duration-500"
                  style={{
                    width: `${(activeIndex / (steps.length - 1)) * 100}%`,
                    background: `linear-gradient(90deg, ${brand}, ${brand})`,
                    zIndex: 1,
                    boxShadow: '0 2px 8px rgba(95,179,249,0.3)',
                  }}
                />

                {/* Steps */}
                <div className="relative flex items-center justify-between" style={{ zIndex: 2 }}>
                  {steps.map((step, idx) => {
                    const reached = idx <= activeIndex;
                    const isActive = idx === activeIndex;

                    return (
                      <div key={step} className="flex flex-col items-center gap-2 flex-1">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300"
                          style={{
                            borderColor: reached ? brand : muted,
                            borderWidth: '3px',
                            borderStyle: 'solid',
                            background: reached ? 'white' : 'rgba(248,250,252,0.8)',
                            boxShadow: isActive
                              ? `0 0 0 3px rgba(95,179,249,0.15), 0 3px 10px rgba(95,179,249,0.3)`
                              : 'none',
                            transform: isActive ? 'scale(1.1)' : 'scale(1)',
                            position: 'relative',
                            top: '0',
                            margin: '0',
                          }}
                        >
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{
                              background: reached ? brand : muted,
                              boxShadow: reached ? '0 1px 4px rgba(95,179,249,0.4)' : 'none',
                            }}
                          />
                        </div>
                        <span
                          className="text-xs font-semibold capitalize text-center mt-1"
                          style={{ color: reached ? brand : muted }}
                        >
                          {humanizeOrderStatus(step)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Order Items */}
        <div className="glass-card squircle-lg p-5 border border-[var(--brand-glass-border-2)]">
          <h4 className="text-sm font-semibold text-slate-800 mb-4">Items Ordered</h4>
          <div className="divide-y divide-[var(--brand-glass-border-1)]">
            {lines.map((line, idx) => (
              <div key={line.id || idx} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex-1">
                    <p className="font-semibold text-slate-900 mb-1">{line.name}</p>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                      <span>SKU: {line.sku}</span>
                      <span>•</span>
                      <span>Qty: {line.quantity}</span>
                      <span>•</span>
                      <span>Unit Price: {formatCurrency(line.price, selectedOrder.currency)}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-slate-600 mb-1">Line Total</p>
                    <p className="text-lg font-bold text-slate-900">
                      {formatCurrency(line.total, selectedOrder.currency)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="mt-6 pt-4 border-t-2 border-[var(--brand-glass-border-1)] space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Subtotal</span>
              <span className="font-medium text-slate-900">
                {formatCurrency(selectedOrder.total, selectedOrder.currency)}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Discounts</span>
              <span className="font-medium text-slate-900">—</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Shipping & Handling</span>
              <span className="font-medium text-slate-900">—</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Tax</span>
              <span className="font-medium text-slate-900">—</span>
            </div>
            <div className="flex items-center justify-between pt-3 border-t border-[var(--brand-glass-border-1)]">
              <span className="font-bold text-slate-900">Order Total</span>
              <span className="text-xl font-bold text-[rgb(95,179,249)]">
                {formatCurrency(selectedOrder.total, selectedOrder.currency)}
              </span>
            </div>
          </div>
        </div>

        {/* Shipping & Tracking - Compact */}
        {shipIntegration && (shipIntegration.carrier || shipIntegration.trackingNumber) && (
          <div className="glass-card squircle-lg p-5 border border-[var(--brand-glass-border-2)]">
            <h4 className="text-sm font-semibold text-slate-800 mb-3">Shipping & Tracking</h4>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              {shipIntegration.carrier && (
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">Courier:</span>
                  <span className="font-medium text-slate-900">{shipIntegration.carrier}</span>
                </div>
              )}
              {shipIntegration.status && (
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">Status:</span>
                  <span className="font-medium text-slate-900">{shipIntegration.status}</span>
                </div>
              )}
              {shipIntegration.eta && (
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">ETA:</span>
                  <span className="font-medium text-slate-900">{shipIntegration.eta}</span>
                </div>
              )}
              {shipIntegration.trackingNumber && (
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">Tracking:</span>
                  {shipIntegration.trackingUrl ? (
                    <a
                      className="font-semibold text-[rgb(28,109,173)] hover:underline inline-flex items-center gap-1"
                      href={shipIntegration.trackingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shipIntegration.trackingNumber}
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        />
                      </svg>
                    </a>
                  ) : (
                    <span className="font-medium text-slate-900">{shipIntegration.trackingNumber}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-slate-100 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Demo Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Orders Tab - Improved Layout Demo</h1>
          <p className="text-slate-600">
            Showcasing the enhanced order list and details views with liquid glass design
          </p>
        </div>

        {/* Orders Panel */}
        <div className="space-y-4">
          {/* Header Section */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Order History</h3>
                <p className="text-sm text-slate-600 mt-1">Track and manage your purchases</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 px-3 py-1.5 glass-card squircle-sm border border-[var(--brand-glass-border-1)]">
                  Updated Nov 17, 2024
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCanceledOrders(!showCanceledOrders)}
                  className="glass squircle-sm btn-hover-lighter"
                >
                  {showCanceledOrders ? (
                    <>
                      <EyeOff className="h-4 w-4 mr-2" aria-hidden="true" />
                      Hide canceled
                    </>
                  ) : (
                    <>
                      <Eye className="h-4 w-4 mr-2" aria-hidden="true" />
                      Show canceled
                    </>
                  )}
                </Button>
              </div>
            </div>

            {accountOrdersLoading && (
              <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] text-center">
                <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-[rgb(95,179,249)]" />
                <p className="text-sm text-slate-600">Loading your orders...</p>
              </div>
            )}
          </div>

          {/* Orders Content */}
          {!accountOrdersLoading && (selectedOrder ? renderOrderDetails() : renderOrdersList())}
        </div>
      </div>
    </div>
  );
}
