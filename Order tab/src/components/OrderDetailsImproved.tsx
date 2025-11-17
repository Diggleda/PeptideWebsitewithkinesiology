// IMPROVED ORDER DETAILS LAYOUT
// Replace the renderOrderDetails function in Header.tsx with this version:
// IMPORTANT: Make sure to import these icons: Package, Download, RotateCcw from 'lucide-react'

const renderOrderDetails = () => {
  if (!selectedOrder) return null;

  const status = humanizeOrderStatus(selectedOrder.status);
  const statusNormalized = (selectedOrder.status || '').toLowerCase();
  const isCanceled = statusNormalized.includes('cancel') || statusNormalized === 'trash';
  const isCompleted = statusNormalized.includes('complete');
  const isProcessing = statusNormalized.includes('processing');
  const lines = selectedOrder.lineItems || [];
  const integrations = selectedOrder.integrationDetails || selectedOrder.integrations || {};
  const wooIntegration = (integrations as any)?.wooCommerce || null;
  const shipIntegration = (integrations as any)?.shipEngine || null;
  const displayOrderId = wooIntegration?.pepproOrderId || selectedOrder.number || selectedOrder.id;

  const handleDownloadCSV = () => {
    const csvData = [
      ['Item Name', 'SKU', 'Quantity', 'Unit Price', 'Total'],
      ...lines.map((line: any) => [
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
    // TODO: Implement cart functionality
  };

  return (
    <div className="space-y-5">
      {/* Header Section - Matching list view layout */}
      <div className="glass-card squircle-lg border border-[var(--brand-glass-border-2)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--brand-glass-border-1)] bg-gradient-to-r from-[rgba(95,179,249,0.04)] to-transparent">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
                isCompleted ? 'bg-green-100' : 
                isCanceled ? 'bg-red-100' : 
                isProcessing ? 'bg-blue-100' : 'bg-slate-100'
              }`}>
                <Package className={`h-5 w-5 ${
                  isCompleted ? 'text-green-600' : 
                  isCanceled ? 'text-red-600' : 
                  isProcessing ? 'text-blue-600' : 'text-slate-600'
                }`} />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-semibold text-slate-900">
                    Order #{displayOrderId}
                  </h4>
                  <Badge 
                    variant="outline" 
                    className={`squircle-sm ${
                      isCompleted ? 'bg-green-50 text-green-700 border-green-200' : 
                      isCanceled ? 'bg-red-50 text-red-700 border-red-200' : 
                      isProcessing ? 'bg-blue-50 text-blue-700 border-blue-200' : 
                      'bg-slate-50 text-slate-700 border-slate-200'
                    }`}
                  >
                    {status}
                  </Badge>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {formatOrderDate(selectedOrder.createdAt)}
                </p>
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
              className="squircle-sm bg-[rgb(95,179,249)] hover:bg-[rgb(75,159,229)] text-white"
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
        <div className="px-5 py-3 bg-slate-50/50 border-b border-[var(--brand-glass-border-1)]">
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
          const activeIndex = steps.findIndex((step) => statusNormalized.includes(step)) >= 0
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
                  boxShadow: '0 2px 8px rgba(95,179,249,0.3)'
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
                          boxShadow: isActive ? `0 0 0 3px rgba(95,179,249,0.15), 0 3px 10px rgba(95,179,249,0.3)` : 'none',
                          transform: isActive ? 'scale(1.1)' : 'scale(1)'
                        }}
                      >
                        <div 
                          className="w-3 h-3 rounded-full"
                          style={{
                            background: reached ? brand : muted,
                            boxShadow: reached ? '0 1px 4px rgba(95,179,249,0.4)' : 'none'
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
          {lines.map((line: any, idx: number) => (
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
