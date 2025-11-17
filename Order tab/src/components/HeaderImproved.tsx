// IMPROVED ORDERS TAB LAYOUT - Copy the renderOrdersList and renderOrderDetails functions below
// into your Header.tsx file to replace the existing ones

// Replace the renderOrdersList function with this improved version:
const renderOrdersList = () => {
  const visibleOrders = Array.isArray(accountOrders)
    ? accountOrders
      .filter((order) => order.source === 'woocommerce')
      .filter((order) => {
        if (showCanceledOrders) {
          return true;
        }
        const status = order.status ? String(order.status).trim().toLowerCase() : '';
        return status !== 'canceled' && status !== 'trash';
      })
    : [];

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
                    <h4 className="font-semibold text-slate-900">
                      Order #{order.number || order.id}
                    </h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {formatOrderDate(order.createdAt)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
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
                  <Badge variant="outline" className="squircle-sm bg-[rgba(95,179,249,0.08)] text-[rgb(28,109,173)] border-[rgba(95,179,249,0.2)]">
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
                          {line.name || 'Item'} {line.quantity && <span className="text-slate-500">× {line.quantity}</span>}
                        </span>
                        <span className="font-medium text-slate-900">
                          {formatCurrency(line.total ?? line.price ?? null, order.currency || 'USD')}
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
                  <p className="text-lg font-bold text-slate-900">
                    {formatCurrency(order.total ?? null, order.currency || 'USD')}
                  </p>
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

// Replace the accountOrdersPanel section with this improved version:
const accountOrdersPanel = localUser ? (
  localUser.role !== 'sales_rep' ? (
    <div className="space-y-4">
      {/* Header Section */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Order History</h3>
            <p className="text-sm text-slate-600 mt-1">Track and manage your purchases</p>
          </div>
          <div className="flex items-center gap-2">
            {ordersLastSyncedAt && (
              <span className="text-xs text-slate-500 px-3 py-1.5 glass-card squircle-sm border border-[var(--brand-glass-border-1)]">
                Updated {formatOrderDate(ordersLastSyncedAt)}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onToggleShowCanceled?.()}
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

        {accountOrdersError && (
          <div className="glass-card squircle-md p-4 border border-red-200 bg-red-50/50">
            <p className="text-sm text-red-700 font-medium">{accountOrdersError}</p>
          </div>
        )}

        {accountOrdersLoading && (
          <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-[rgb(95,179,249)]" />
            <p className="text-sm text-slate-600">Loading your orders...</p>
          </div>
        )}
      </div>

      {/* Orders Content */}
      {!accountOrdersLoading && (
        selectedOrder ? renderOrderDetails() : renderOrdersList()
      )}
    </div>
  ) : (
    <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] text-center">
      <Package className="h-12 w-12 mx-auto mb-3 text-slate-400" />
      <p className="text-sm font-medium text-slate-700 mb-1">Sales Rep View</p>
      <p className="text-sm text-slate-600">
        Order history and tracking details for your sales rep profile will appear here soon.
      </p>
    </div>
  )
) : null;
