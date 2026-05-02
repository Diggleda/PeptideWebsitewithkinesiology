# TruFusionLabs Manual Tax Sync (WooCommerce plugin)

This plugin converts TruFusionLabs-provided tax (`trufusion_tax_total`) into a real WooCommerce tax line item on orders created/updated via the WooCommerce REST API.

## Why this is needed

WooCommerce REST order creation does not reliably accept custom tax totals/tax line items. TruFusionLabs therefore sends the computed tax as:

- order meta: `trufusion_tax_total`
- (and) an order fee line named `Estimated tax`

This plugin removes the `Estimated tax` fee line and replaces it with a WooCommerce tax line item so the admin UI shows the tax as tax.

## Install

1. Copy the folder `trufusion-manual-tax` into your Woo site at `wp-content/plugins/`.
2. In WP Admin → Plugins, activate **TruFusionLabs Manual Tax Sync**.

## Notes

- The plugin listens for REST-created/updated orders and for updates to the `trufusion_tax_total` meta field.
- It uses `trufusion_manual_tax_rate_id` if present (created by TruFusionLabs’s integration); otherwise it uses a rate id of `0`.

