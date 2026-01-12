<?php
/**
 * Plugin Name: PepPro Manual Tax Sync
 * Description: Converts PepPro tax metadata/fee lines into a WooCommerce tax line item for REST-created orders.
 * Version: 1.0.2
 * Author: PepPro
 */

defined('ABSPATH') || exit;

final class PepPro_Manual_Tax_Sync {
  private const META_TAX_TOTAL = 'peppro_tax_total';
  private const META_RATE_ID = 'peppro_manual_tax_rate_id';
  private const META_SYNCED_AT = 'peppro_tax_synced_at';
  private const META_SYNCED_HASH = 'peppro_tax_synced_hash';
  private const LOG_SOURCE = 'peppro-manual-tax';

  private const DEFAULT_TAX_LABEL = 'PepPro Manual Tax';
  private const FALLBACK_FEE_NAME = 'Estimated tax';

  private static array $inProgress = [];

  public static function init(): void {
    add_action('woocommerce_rest_insert_shop_order_object', [__CLASS__, 'handle_rest_insert'], 20, 3);
    add_action('updated_post_meta', [__CLASS__, 'handle_meta_update'], 20, 4);
    add_action('woocommerce_after_order_object_save', [__CLASS__, 'handle_order_save'], 20, 2);
  }

  public static function handle_rest_insert($order, $request, $creating): void {
    if (!$order instanceof WC_Order) {
      return;
    }
    self::log('info', 'REST insert hook fired', [
      'order_id' => $order->get_id(),
      'creating' => (bool) $creating,
    ]);
    $requestTax = self::extract_request_meta_value($request, self::META_TAX_TOTAL);
    $requestRateId = self::extract_request_meta_value($request, self::META_RATE_ID);
    if ($requestTax !== null && $requestTax > 0) {
      $order->update_meta_data(self::META_TAX_TOTAL, wc_format_decimal($requestTax, 2));
    }
    if ($requestRateId !== null && $requestRateId > 0) {
      $order->update_meta_data(self::META_RATE_ID, (int) $requestRateId);
    }
    self::apply_manual_tax($order);
  }

  public static function handle_meta_update($meta_id, $object_id, $meta_key, $meta_value): void {
    if ($meta_key !== self::META_TAX_TOTAL) {
      return;
    }
    $order = wc_get_order($object_id);
    if (!$order instanceof WC_Order) {
      return;
    }
    self::log('info', 'Meta update hook fired', [
      'order_id' => $order->get_id(),
      'meta_key' => (string) $meta_key,
      'meta_value' => (string) $meta_value,
    ]);
    self::apply_manual_tax($order);
  }

  public static function handle_order_save($order, $data_store): void {
    if (!$order instanceof WC_Order) {
      return;
    }
    $taxTotal = self::normalize_money($order->get_meta(self::META_TAX_TOTAL, true));
    if ($taxTotal <= 0) {
      return;
    }
    self::apply_manual_tax($order);
  }

  private static function log(string $level, string $message, array $context = []): void {
    $context = array_merge([
      'source' => self::LOG_SOURCE,
    ], $context);
    try {
      if (function_exists('wc_get_logger')) {
        $logger = wc_get_logger();
        if ($logger) {
          $logger->log($level, $message, $context);
          return;
        }
      }
    } catch (Throwable $e) {
      // ignore
    }
    if (function_exists('error_log')) {
      error_log('[peppro-manual-tax] ' . $message . ' ' . wp_json_encode($context));
    }
  }

  private static function normalize_money($value): float {
    if ($value === null || $value === '' || $value === false) {
      return 0.0;
    }
    $numeric = (float) $value;
    if (!is_finite($numeric) || $numeric < 0) {
      return 0.0;
    }
    return round($numeric + 1e-9, 2);
  }

  private static function extract_request_meta_value($request, string $key): ?float {
    if (!$request) {
      return null;
    }
    $meta = null;
    if (is_object($request) && method_exists($request, 'get_param')) {
      $meta = $request->get_param('meta_data');
    } elseif (is_array($request) && isset($request['meta_data'])) {
      $meta = $request['meta_data'];
    }
    if (!is_array($meta)) {
      return null;
    }
    foreach ($meta as $entry) {
      if (!is_array($entry) || !isset($entry['key'])) {
        continue;
      }
      if ((string) $entry['key'] !== $key) {
        continue;
      }
      return self::normalize_money($entry['value'] ?? null);
    }
    return null;
  }

  private static function resolve_tax_total(WC_Order $order): float {
    $metaValue = $order->get_meta(self::META_TAX_TOTAL, true);
    $taxTotal = self::normalize_money($metaValue);
    if ($taxTotal > 0) {
      return $taxTotal;
    }

    $feeItems = $order->get_items('fee');
    foreach ($feeItems as $item) {
      if (!$item instanceof WC_Order_Item_Fee) {
        continue;
      }
      $name = (string) $item->get_name();
      if (strcasecmp(trim($name), self::FALLBACK_FEE_NAME) !== 0) {
        continue;
      }
      $feeTotal = self::normalize_money($item->get_total());
      if ($feeTotal > 0) {
        return $feeTotal;
      }
    }

    return 0.0;
  }

  private static function resolve_tax_rate_id(WC_Order $order): int {
    $raw = $order->get_meta(self::META_RATE_ID, true);
    $rateId = (int) $raw;
    return $rateId > 0 ? $rateId : 0;
  }

  private static function compute_sync_hash(WC_Order $order, float $taxTotal, int $rateId): string {
    $parts = [
      'v1',
      (string) $order->get_id(),
      number_format($taxTotal, 2, '.', ''),
      (string) $rateId,
    ];
    return hash('sha256', implode('|', $parts));
  }

  private static function remove_matching_fee_lines(WC_Order $order): void {
    $feeItems = $order->get_items('fee');
    foreach ($feeItems as $itemId => $item) {
      if (!$item instanceof WC_Order_Item_Fee) {
        continue;
      }
      $name = (string) $item->get_name();
      if (strcasecmp(trim($name), self::FALLBACK_FEE_NAME) !== 0) {
        continue;
      }
      $order->remove_item($itemId);
    }
  }

  private static function remove_existing_tax_items(WC_Order $order, int $rateId): void {
    $taxItems = $order->get_items('tax');
    foreach ($taxItems as $itemId => $item) {
      if (!$item instanceof WC_Order_Item_Tax) {
        continue;
      }
      $label = (string) $item->get_label();
      $itemRateId = (int) $item->get_rate_id();
      $labelMatch =
        strcasecmp(trim($label), self::DEFAULT_TAX_LABEL) === 0
        || strcasecmp(trim($label), self::FALLBACK_FEE_NAME) === 0;
      if ($labelMatch || ($rateId > 0 && $itemRateId === $rateId)) {
        $order->remove_item($itemId);
      }
    }
  }

  private static function allocate_line_item_taxes(WC_Order $order, float $taxTotal, int $rateId): void {
    $lineItems = $order->get_items('line_item');
    $baseTotal = 0.0;
    foreach ($lineItems as $item) {
      if (!$item instanceof WC_Order_Item_Product) {
        continue;
      }
      $baseTotal += max(0.0, (float) $item->get_total());
    }
    if ($baseTotal <= 0 || $taxTotal <= 0) {
      return;
    }

    $remaining = $taxTotal;
    $ids = array_keys($lineItems);
    $lastId = end($ids);

    foreach ($lineItems as $itemId => $item) {
      if (!$item instanceof WC_Order_Item_Product) {
        continue;
      }
      $lineTotal = max(0.0, (float) $item->get_total());
      if ($lineTotal <= 0) {
        continue;
      }
      if ($itemId === $lastId) {
        $allocated = $remaining;
      } else {
        $allocated = round(($taxTotal * ($lineTotal / $baseTotal)) + 1e-9, 2);
        $remaining = round(($remaining - $allocated) + 1e-9, 2);
      }
      $allocated = max(0.0, $allocated);

      $taxKey = $rateId > 0 ? $rateId : 0;
      $taxes = $item->get_taxes();
      if (!is_array($taxes)) {
        $taxes = [];
      }
      if (!isset($taxes['total']) || !is_array($taxes['total'])) {
        $taxes['total'] = [];
      }
      if (!isset($taxes['subtotal']) || !is_array($taxes['subtotal'])) {
        $taxes['subtotal'] = [];
      }
      $taxes['total'][(string) $taxKey] = wc_format_decimal($allocated, 2);
      $taxes['subtotal'][(string) $taxKey] = wc_format_decimal($allocated, 2);
      $item->set_taxes($taxes);
      $item->save();
    }
  }

  private static function apply_manual_tax(WC_Order $order): void {
    $orderId = (int) $order->get_id();
    if ($orderId <= 0) {
      return;
    }
    if (!empty(self::$inProgress[$orderId])) {
      return;
    }
    self::$inProgress[$orderId] = true;

    try {
      $taxTotal = self::resolve_tax_total($order);
      if ($taxTotal <= 0) {
        self::log('debug', 'Skipping: no tax total found', [
          'order_id' => $orderId,
          'meta_tax_total' => (string) $order->get_meta(self::META_TAX_TOTAL, true),
        ]);
        return;
      }
      $rateId = self::resolve_tax_rate_id($order);
      $syncHash = self::compute_sync_hash($order, $taxTotal, $rateId);
      $previousHash = (string) $order->get_meta(self::META_SYNCED_HASH, true);
      if ($previousHash && hash_equals($previousHash, $syncHash)) {
        self::log('debug', 'Skipping: already synced', [
          'order_id' => $orderId,
          'sync_hash' => $syncHash,
        ]);
        return;
      }

      $targetTotal = (float) $order->get_total();
      self::log('info', 'Applying manual tax', [
        'order_id' => $orderId,
        'tax_total' => $taxTotal,
        'rate_id' => $rateId,
        'order_total' => $targetTotal,
      ]);

      self::remove_matching_fee_lines($order);
      self::remove_existing_tax_items($order, $rateId);

      $taxItem = new WC_Order_Item_Tax();
      if ($rateId > 0) {
        $taxItem->set_rate_id($rateId);
      } else {
        $taxItem->set_rate_id(0);
      }
      $taxItem->set_label(self::DEFAULT_TAX_LABEL);
      $taxItem->set_tax_total(wc_format_decimal($taxTotal, 2));
      $taxItem->set_shipping_tax_total(wc_format_decimal(0, 2));
      $order->add_item($taxItem);

      self::allocate_line_item_taxes($order, $taxTotal, $rateId);

      $order->set_cart_tax(wc_format_decimal($taxTotal, 2));
      $order->set_shipping_tax(wc_format_decimal(0, 2));
      $order->set_total_tax(wc_format_decimal($taxTotal, 2));
      $order->set_total(wc_format_decimal($targetTotal, 2));

      $order->update_meta_data(self::META_SYNCED_AT, gmdate('c'));
      $order->update_meta_data(self::META_SYNCED_HASH, $syncHash);
      $order->save();

      $order->add_order_note(
        sprintf(
          'PepPro Manual Tax Sync applied: tax=%s, rate_id=%d',
          wc_format_decimal($taxTotal, 2),
          (int) $rateId,
        ),
        false,
        true,
      );
      self::log('info', 'Applied manual tax successfully', [
        'order_id' => $orderId,
        'sync_hash' => $syncHash,
      ]);
    } catch (Throwable $e) {
      self::log('error', 'PepPro Manual Tax Sync failed', [
        'order_id' => $orderId,
        'error' => $e->getMessage(),
      ]);
    } finally {
      unset(self::$inProgress[$orderId]);
    }
  }
}

PepPro_Manual_Tax_Sync::init();
