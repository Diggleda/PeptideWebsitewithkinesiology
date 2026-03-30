from __future__ import annotations

from . import mysql_client


CREATE_TABLE_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(32) PRIMARY KEY,
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'doctor',
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        hand_delivered TINYINT(1) NOT NULL DEFAULT 0,
        is_online TINYINT(1) NOT NULL DEFAULT 0,
        session_id VARCHAR(64) NULL,
        last_seen_at DATETIME NULL,
        last_interaction_at DATETIME NULL,
        sales_rep_id VARCHAR(32) NULL,
        referrer_doctor_id VARCHAR(32) NULL,
        lead_type VARCHAR(32) NULL,
        lead_type_source VARCHAR(64) NULL,
        lead_type_locked_at DATETIME NULL,
        phone VARCHAR(32) NULL,
        office_address_line1 VARCHAR(190) NULL,
        office_address_line2 VARCHAR(190) NULL,
        office_city VARCHAR(120) NULL,
        office_state VARCHAR(64) NULL,
        office_postal_code VARCHAR(32) NULL,
        office_country VARCHAR(64) NULL,
        profile_image_url LONGTEXT NULL,
        profile_onboarding TINYINT(1) NOT NULL DEFAULT 0,
        reseller_permit_onboarding_presented TINYINT(1) NOT NULL DEFAULT 0,
        greater_area VARCHAR(190) NULL,
        study_focus VARCHAR(190) NULL,
        bio TEXT NULL,
        delegate_logo_url LONGTEXT NULL,
        delegate_secondary_color VARCHAR(16) NULL,
        delegate_links_enabled TINYINT(1) NOT NULL DEFAULT 0,
        research_terms_agreement TINYINT(1) NOT NULL DEFAULT 0,
        zelle_contact VARCHAR(190) NULL,
        cart JSON NULL,
        downloads LONGTEXT NULL,
        referral_credits DECIMAL(12,2) NOT NULL DEFAULT 0,
        total_referrals INT NOT NULL DEFAULT 0,
        visits INT NOT NULL DEFAULT 0,
        receive_client_order_update_emails TINYINT(1) NOT NULL DEFAULT 0,
        markup_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
        created_at DATETIME NULL,
        last_login_at DATETIME NULL,
        must_reset_password TINYINT(1) NOT NULL DEFAULT 0,
        first_order_bonus_granted_at DATETIME NULL,
        npi_number VARCHAR(20) NULL,
        npi_last_verified_at DATETIME NULL,
        npi_verification LONGTEXT NULL,
        npi_status VARCHAR(32) NULL,
        npi_check_error LONGTEXT NULL,
        is_tax_exempt TINYINT(1) NOT NULL DEFAULT 0,
        tax_exempt_source VARCHAR(64) NULL,
        tax_exempt_reason VARCHAR(255) NULL,
        reseller_permit_file_path LONGTEXT NULL,
        reseller_permit_file_name VARCHAR(190) NULL,
        reseller_permit_uploaded_at DATETIME NULL,
        KEY idx_users_role (role),
        KEY idx_users_sales_rep_id (sales_rep_id),
        KEY idx_users_lead_type (lead_type)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS sales_reps (
        id VARCHAR(32) PRIMARY KEY,
        legacy_user_id VARCHAR(32) NULL,
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190) NULL UNIQUE,
        phone VARCHAR(32) NULL,
        territory VARCHAR(120) NULL,
        initials VARCHAR(10) NULL,
        sales_code VARCHAR(8) NULL UNIQUE,
        role VARCHAR(32) NOT NULL DEFAULT 'sales_rep',
        is_partner TINYINT(1) NOT NULL DEFAULT 0,
        allowed_retail TINYINT(1) NOT NULL DEFAULT 0,
        jurisdiction VARCHAR(64) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        referral_credits DECIMAL(12,2) NOT NULL DEFAULT 0,
        total_referrals INT NOT NULL DEFAULT 0,
        first_order_bonus_granted_at DATETIME NULL,
        total_revenue_to_date DECIMAL(12,2) NOT NULL DEFAULT 0,
        total_revenue_updated_at DATETIME NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS referral_codes (
        id VARCHAR(32) PRIMARY KEY,
        sales_rep_id VARCHAR(32) NULL,
        referrer_doctor_id VARCHAR(32) NULL,
        referral_id VARCHAR(32) NULL,
        doctor_id VARCHAR(32) NULL,
        code VARCHAR(8) NOT NULL UNIQUE,
        status VARCHAR(32) NOT NULL DEFAULT 'available',
        issued_at DATETIME NULL,
        redeemed_at DATETIME NULL,
        history LONGTEXT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS referrals (
        id VARCHAR(32) PRIMARY KEY,
        referrer_doctor_id VARCHAR(32) NULL,
        sales_rep_id VARCHAR(32) NULL,
        referral_code_id VARCHAR(32) NULL,
        referred_contact_name VARCHAR(190) NOT NULL,
        referred_contact_email VARCHAR(190) NULL,
        referred_contact_phone VARCHAR(32) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        notes LONGTEXT NULL,
        sales_rep_notes LONGTEXT NULL,
        converted_doctor_id VARCHAR(32) NULL,
        converted_at DATETIME NULL,
        credit_issued_at DATETIME NULL,
        credit_issued_amount DECIMAL(12,2) NULL,
        credit_issued_by VARCHAR(190) NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS sales_prospects (
        id VARCHAR(64) PRIMARY KEY,
        sales_rep_id VARCHAR(32) NULL,
        doctor_id VARCHAR(32) NULL,
        referral_id VARCHAR(64) NULL,
        contact_form_id VARCHAR(64) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        notes LONGTEXT NULL,
        is_manual TINYINT(1) NOT NULL DEFAULT 0,
        reseller_permit_exempt TINYINT(1) NOT NULL DEFAULT 0,
        reseller_permit_file_path LONGTEXT NULL,
        reseller_permit_file_name VARCHAR(190) NULL,
        reseller_permit_uploaded_at DATETIME NULL,
        contact_name VARCHAR(190) NULL,
        contact_email VARCHAR(190) NULL,
        contact_phone VARCHAR(32) NULL,
        office_address_line1 VARCHAR(190) NULL,
        office_address_line2 VARCHAR(190) NULL,
        office_city VARCHAR(190) NULL,
        office_state VARCHAR(64) NULL,
        office_postal_code VARCHAR(32) NULL,
        office_country VARCHAR(64) NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        UNIQUE KEY uniq_sales_rep_doctor (sales_rep_id, doctor_id),
        UNIQUE KEY uniq_sales_rep_referral (sales_rep_id, referral_id),
        UNIQUE KEY uniq_sales_rep_contact_form (sales_rep_id, contact_form_id)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS sales_prospect_quotes (
        id VARCHAR(64) PRIMARY KEY,
        prospect_id VARCHAR(64) NOT NULL,
        sales_rep_id VARCHAR(32) NOT NULL,
        revision_number INT NOT NULL DEFAULT 1,
        status VARCHAR(32) NOT NULL DEFAULT 'draft',
        title VARCHAR(190) NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'USD',
        subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
        quote_payload_json LONGTEXT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        exported_at DATETIME NULL,
        UNIQUE KEY uniq_sales_prospect_quote_revision (prospect_id, revision_number),
        KEY idx_sales_prospect_quotes_prospect_id (prospect_id),
        KEY idx_sales_prospect_quotes_sales_rep_id (sales_rep_id),
        KEY idx_sales_prospect_quotes_status (status),
        KEY idx_sales_prospect_quotes_updated_at (updated_at)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS credit_ledger (
        id VARCHAR(32) PRIMARY KEY,
        doctor_id VARCHAR(32) NOT NULL,
        sales_rep_id VARCHAR(32) NULL,
        referral_id VARCHAR(32) NULL,
        order_id VARCHAR(32) NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        currency VARCHAR(8) NOT NULL DEFAULT 'USD',
        direction VARCHAR(16) NOT NULL DEFAULT 'credit',
        reason VARCHAR(64) NOT NULL DEFAULT 'referral_bonus',
        description VARCHAR(255) NULL,
        first_order_bonus TINYINT(1) NOT NULL DEFAULT 0,
        metadata LONGTEXT NULL,
        issued_at DATETIME NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(32) PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        as_delegate VARCHAR(190) NULL,
        pricing_mode VARCHAR(16) NOT NULL DEFAULT 'wholesale',
        items LONGTEXT NULL,
        items_subtotal DECIMAL(12,2) NULL,
        total DECIMAL(12,2) NOT NULL DEFAULT 0,
        shipping_total DECIMAL(12,2) NOT NULL DEFAULT 0,
        facility_pickup TINYINT(1) NOT NULL DEFAULT 0,
        fulfillment_method VARCHAR(32) NULL,
        shipping_carrier VARCHAR(64) NULL,
        shipping_service VARCHAR(128) NULL,
        tracking_number VARCHAR(64) NULL,
        shipped_at DATETIME NULL,
        physician_certified TINYINT(1) NOT NULL DEFAULT 0,
        referral_code VARCHAR(8) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        referrer_bonus LONGTEXT NULL,
        first_order_bonus LONGTEXT NULL,
        integrations LONGTEXT NULL,
        expected_shipment_window VARCHAR(64) NULL,
        notes LONGTEXT NULL,
        payload LONGTEXT NULL,
        shipping_address LONGTEXT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        KEY idx_orders_user_id (user_id),
        KEY idx_orders_created_at (created_at),
        KEY idx_orders_user_created_at (user_id, created_at)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS contact_forms (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name LONGTEXT NOT NULL,
        email LONGTEXT NOT NULL,
        phone LONGTEXT NULL,
        email_blind_index CHAR(64) NULL,
        source VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_contact_forms_email_blind (email_blind_index),
        KEY idx_contact_forms_created_at (created_at)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS bugs_reported (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(64) NULL,
        name LONGTEXT NULL,
        email LONGTEXT NULL,
        report LONGTEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS tax_tracking (
        state_code CHAR(2) PRIMARY KEY,
        state_name VARCHAR(64) NOT NULL UNIQUE,
        economic_nexus_revenue_usd DECIMAL(12,2) NULL,
        economic_nexus_transactions INT NULL,
        collect_tax_default TINYINT(1) NOT NULL DEFAULT 0,
        research_reagent_taxable TINYINT(1) NOT NULL DEFAULT 1,
        university_exemption_allowed TINYINT(1) NOT NULL DEFAULT 1,
        resale_certificate_allowed TINYINT(1) NOT NULL DEFAULT 1,
        woo_tax_class VARCHAR(32) NULL,
        notes VARCHAR(255) NULL,
        avg_combined_tax_rate DECIMAL(7,5) NULL,
        example_tax_on_100k_sales DECIMAL(12,2) NULL,
        tax_collection_required_after_nexus TINYINT(1) NOT NULL DEFAULT 0,
        buffered_tax_rate DECIMAL(7,5) NULL,
        example_tax_on_100k_sales_buffered DECIMAL(12,2) NULL,
        tax_nexus_applied TINYINT(1) NOT NULL DEFAULT 0,
        tracking_year SMALLINT NOT NULL DEFAULT 0,
        current_year_revenue_usd DECIMAL(12,2) NOT NULL DEFAULT 0,
        current_year_order_count INT NOT NULL DEFAULT 0,
        last_synced_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_tax_tracking_year (tracking_year),
        KEY idx_tax_tracking_state_name (state_name)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS state_sales_totals (
        state VARCHAR(64) NOT NULL,
        state_code CHAR(2) PRIMARY KEY,
        trailing_12mo_revenue DECIMAL(12,2) NOT NULL DEFAULT 0,
        transaction_count INT NOT NULL DEFAULT 0,
        nexus_triggered TINYINT(1) NOT NULL DEFAULT 0,
        window_start_at DATETIME NULL,
        window_end_at DATETIME NULL,
        last_synced_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_state_sales_totals_state (state),
        KEY idx_state_sales_totals_nexus (nexus_triggered),
        KEY idx_state_sales_totals_state_name (state)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS settings (
        `key` VARCHAR(64) NOT NULL PRIMARY KEY,
        value_json JSON NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS usage_tracking (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        event VARCHAR(128) NOT NULL,
        details_json LONGTEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_usage_tracking_event (event),
        KEY idx_usage_tracking_created (created_at)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS discount_codes (
        code VARCHAR(64) PRIMARY KEY,
        discount_value DECIMAL(6,2) NOT NULL DEFAULT 0,
        used_by_json LONGTEXT NULL,
        `condition` JSON NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        KEY idx_discount_codes_updated (updated_at)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS patient_links (
        token VARCHAR(128) PRIMARY KEY,
        token_version SMALLINT NOT NULL DEFAULT 1,
        token_ciphertext LONGTEXT NULL,
        token_hint VARCHAR(32) NULL,
        doctor_id VARCHAR(32) NOT NULL,
        patient_id LONGTEXT NULL,
        reference_label LONGTEXT NULL,
        subject_label LONGTEXT NULL,
        study_label LONGTEXT NULL,
        patient_reference LONGTEXT NULL,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        markup_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
        instructions LONGTEXT NULL,
        allowed_products_json JSON NULL,
        usage_limit INT NULL,
        usage_count INT NOT NULL DEFAULT 0,
        open_count INT NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        payment_method VARCHAR(32) NULL,
        payment_instructions LONGTEXT NULL,
        physician_certified TINYINT(1) NOT NULL DEFAULT 0,
        received_payment TINYINT(1) NOT NULL DEFAULT 0,
        last_used_at DATETIME NULL,
        last_opened_at DATETIME NULL,
        last_order_at DATETIME NULL,
        revoked_at DATETIME NULL,
        delegate_cart_json LONGTEXT NULL,
        delegate_shipping_json LONGTEXT NULL,
        delegate_payment_json LONGTEXT NULL,
        delegate_shared_at DATETIME NULL,
        delegate_order_id VARCHAR(32) NULL,
        delegate_review_status VARCHAR(32) NULL,
        delegate_reviewed_at DATETIME NULL,
        delegate_review_order_id VARCHAR(32) NULL,
        delegate_review_notes LONGTEXT NULL,
        KEY idx_patient_links_doctor (doctor_id),
        KEY idx_patient_links_expires (expires_at),
        KEY idx_patient_links_status (status)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS patient_link_audit_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        patient_link_token VARCHAR(128) NOT NULL,
        doctor_id VARCHAR(32) NULL,
        actor_user_id VARCHAR(32) NULL,
        actor_role VARCHAR(64) NULL,
        event_type VARCHAR(64) NOT NULL,
        resource_ref VARCHAR(128) NULL,
        purpose VARCHAR(64) NULL,
        result VARCHAR(32) NULL,
        request_ip VARCHAR(64) NULL,
        device_info VARCHAR(255) NULL,
        event_payload_json LONGTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_patient_link_audit_token (patient_link_token),
        KEY idx_patient_link_audit_doctor (doctor_id),
        KEY idx_patient_link_audit_event (event_type),
        KEY idx_patient_link_audit_resource_ref (resource_ref),
        KEY idx_patient_link_audit_created (created_at)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS peptide_forum_posts (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        date_at DATETIME NULL,
        date_raw VARCHAR(190) NULL,
        time_raw VARCHAR(64) NULL,
        description LONGTEXT NULL,
        link VARCHAR(1024) NULL,
        recording_link VARCHAR(1024) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_peptide_forum_posts_date (date_at),
        INDEX idx_peptide_forum_posts_updated (updated_at)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS product_documents (
        woo_product_id BIGINT UNSIGNED NOT NULL,
        kind VARCHAR(64) NOT NULL,
        product_name VARCHAR(255) NULL,
        product_sku VARCHAR(64) NULL,
        woo_synced_at DATETIME NULL,
        mime_type VARCHAR(64) NULL,
        filename VARCHAR(255) NULL,
        sha256 CHAR(64) NULL,
        data LONGBLOB NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        PRIMARY KEY (woo_product_id, kind)
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_sha256 CHAR(64) PRIMARY KEY,
        account_type VARCHAR(32) NOT NULL,
        account_id VARCHAR(64) NOT NULL,
        recipient_email VARCHAR(190) NOT NULL,
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        KEY idx_password_reset_tokens_email (recipient_email),
        KEY idx_password_reset_tokens_expires (expires_at),
        KEY idx_password_reset_tokens_consumed (consumed_at)
    ) CHARACTER SET utf8mb4
    """
]


def ensure_schema() -> None:
    for statement in CREATE_TABLE_STATEMENTS:
        mysql_client.execute(statement)

    def _column_exists(table: str, column: str) -> bool:
        try:
            row = mysql_client.fetch_one(
                """
                SELECT COUNT(*) AS cnt
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = %(table)s
                  AND column_name = %(column)s
                """,
                {"table": table, "column": column},
            )
            return int((row or {}).get("cnt") or 0) > 0
        except Exception:
            return False

    def _index_exists(table: str, index: str) -> bool:
        try:
            row = mysql_client.fetch_one(
                """
                SELECT COUNT(*) AS cnt
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = %(table)s
                  AND index_name = %(index)s
                """,
                {"table": table, "index": index},
            )
            return int((row or {}).get("cnt") or 0) > 0
        except Exception:
            return False

    def _primary_key_exists(table: str) -> bool:
        try:
            row = mysql_client.fetch_one(
                """
                SELECT COUNT(*) AS cnt
                FROM information_schema.table_constraints
                WHERE table_schema = DATABASE()
                  AND table_name = %(table)s
                  AND constraint_type = 'PRIMARY KEY'
                """,
                {"table": table},
            )
            return int((row or {}).get("cnt") or 0) > 0
        except Exception:
            return False

    def _table_exists(table: str) -> bool:
        try:
            row = mysql_client.fetch_one(
                """
                SELECT COUNT(*) AS cnt
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                  AND table_name = %(table)s
                """,
                {"table": table},
            )
            return int((row or {}).get("cnt") or 0) > 0
        except Exception:
            return False

    def _drop_column_if_exists(table: str, column: str) -> None:
        try:
            if _column_exists(table, column):
                mysql_client.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        except Exception:
            pass

    def _drop_index_if_exists(table: str, index: str) -> None:
        try:
            if _index_exists(table, index):
                mysql_client.execute(f"ALTER TABLE {table} DROP INDEX {index}")
        except Exception:
            pass

    def _copy_legacy_ciphertext(table: str, base_column: str, legacy_column: str, *, placeholder: Optional[str] = None) -> None:
        if not _column_exists(table, legacy_column) or not _column_exists(table, base_column):
            return
        condition = f"({base_column} IS NULL OR {base_column} = '')"
        params: Dict[str, object] = {}
        if placeholder is not None:
            condition = f"({base_column} IS NULL OR {base_column} = '' OR {base_column} = %(placeholder)s)"
            params["placeholder"] = placeholder
        try:
            mysql_client.execute(
                f"""
                UPDATE {table}
                SET {base_column} = {legacy_column}
                WHERE {legacy_column} IS NOT NULL
                  AND {condition}
                """,
                params,
            )
        except Exception:
            pass

    # Apply lightweight schema evolutions without breaking existing tables
    migrations = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS hand_delivered TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url LONGTEXT NULL",
        "ALTER TABLE users MODIFY COLUMN profile_image_url LONGTEXT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS downloads LONGTEXT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_online TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users MODIFY COLUMN is_online TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS session_id VARCHAR(64) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_interaction_at DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS visits INT NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS legacy_user_id VARCHAR(32) NULL",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS role VARCHAR(32) NOT NULL DEFAULT 'sales_rep'",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS is_partner TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS allowed_retail TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS jurisdiction VARCHAR(64) NULL",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS referral_credits DECIMAL(12,2) NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS total_referrals INT NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS first_order_bonus_granted_at DATETIME NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(16) NOT NULL DEFAULT 'wholesale'",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS as_delegate VARCHAR(190) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_subtotal DECIMAL(12,2) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_total DECIMAL(12,2) NOT NULL DEFAULT 0",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS facility_pickup TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_method VARCHAR(32) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_carrier VARCHAR(64) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_service VARCHAR(128) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(64) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at DATETIME NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS physician_certified TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_rate LONGTEXT NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS expected_shipment_window VARCHAR(64) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes LONGTEXT NULL",
        "ALTER TABLE orders MODIFY COLUMN notes LONGTEXT NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS payload LONGTEXT NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at DATETIME NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS woo_order_id VARCHAR(32) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS woo_order_number VARCHAR(64) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS woo_order_key VARCHAR(64) NULL",
        "ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS `condition` JSON NULL",
        "ALTER TABLE referrals ADD COLUMN IF NOT EXISTS credit_issued_at DATETIME NULL",
        "ALTER TABLE referrals ADD COLUMN IF NOT EXISTS credit_issued_amount DECIMAL(12,2) NULL",
        "ALTER TABLE referrals ADD COLUMN IF NOT EXISTS credit_issued_by VARCHAR(190) NULL",
        "ALTER TABLE referrals ADD COLUMN IF NOT EXISTS sales_rep_notes LONGTEXT NULL",
        "ALTER TABLE referrals MODIFY COLUMN sales_rep_notes LONGTEXT NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'pending'",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS notes LONGTEXT NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS is_manual TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS reseller_permit_exempt TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS reseller_permit_file_path LONGTEXT NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS reseller_permit_file_name VARCHAR(190) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS reseller_permit_uploaded_at DATETIME NULL",
        "ALTER TABLE sales_prospects MODIFY COLUMN sales_rep_id VARCHAR(32) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS contact_name VARCHAR(190) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS contact_email VARCHAR(190) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(32) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS office_address_line1 VARCHAR(190) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS office_address_line2 VARCHAR(190) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS office_city VARCHAR(190) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS office_state VARCHAR(64) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS office_postal_code VARCHAR(32) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS office_country VARCHAR(64) NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS updated_at DATETIME NULL",
        "ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS created_at DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS lead_type VARCHAR(32) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS lead_type_source VARCHAR(64) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS lead_type_locked_at DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS office_address_line1 VARCHAR(190) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS office_address_line2 VARCHAR(190) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS office_city VARCHAR(120) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS office_state VARCHAR(64) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS office_postal_code VARCHAR(32) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS office_country VARCHAR(64) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS delegate_logo_url LONGTEXT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_onboarding TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS reseller_permit_onboarding_presented TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS greater_area VARCHAR(190) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS study_focus VARCHAR(190) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS delegate_secondary_color VARCHAR(16) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS delegate_links_enabled TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS research_terms_agreement TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS delegate_opt_in TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS zelle_contact VARCHAR(190) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS cart JSON NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS receive_client_order_update_emails TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS markup_percent DECIMAL(6,2) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS npi_number VARCHAR(20) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS npi_last_verified_at DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS npi_verification LONGTEXT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS npi_status VARCHAR(32) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS npi_check_error LONGTEXT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_tax_exempt TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_exempt_source VARCHAR(64) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_exempt_reason VARCHAR(255) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS reseller_permit_file_path LONGTEXT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS reseller_permit_file_name VARCHAR(190) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS reseller_permit_uploaded_at DATETIME NULL",
        "ALTER TABLE tax_tracking ADD COLUMN IF NOT EXISTS avg_combined_tax_rate DECIMAL(7,5) NULL",
        "ALTER TABLE tax_tracking ADD COLUMN IF NOT EXISTS example_tax_on_100k_sales DECIMAL(12,2) NULL",
        "ALTER TABLE tax_tracking ADD COLUMN IF NOT EXISTS tax_collection_required_after_nexus TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE tax_tracking ADD COLUMN IF NOT EXISTS buffered_tax_rate DECIMAL(7,5) NULL",
        "ALTER TABLE tax_tracking ADD COLUMN IF NOT EXISTS example_tax_on_100k_sales_buffered DECIMAL(12,2) NULL",
        "ALTER TABLE tax_tracking ADD COLUMN IF NOT EXISTS tax_nexus_applied TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS physician_certified TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE contact_forms MODIFY COLUMN name LONGTEXT NOT NULL",
        "ALTER TABLE contact_forms MODIFY COLUMN email LONGTEXT NOT NULL",
        "ALTER TABLE contact_forms MODIFY COLUMN phone LONGTEXT NULL",
        "ALTER TABLE contact_forms ADD COLUMN IF NOT EXISTS email_blind_index CHAR(64) NULL",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS total_revenue_to_date DECIMAL(12,2) NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS total_revenue_updated_at DATETIME NULL",
        "ALTER TABLE peptide_forum_posts ADD COLUMN IF NOT EXISTS time_raw VARCHAR(64) NULL",
        "ALTER TABLE peptide_forum_posts ADD COLUMN IF NOT EXISTS recording_link VARCHAR(1024) NULL",
        "ALTER TABLE product_documents ADD COLUMN IF NOT EXISTS product_name VARCHAR(255) NULL",
        "ALTER TABLE product_documents ADD COLUMN IF NOT EXISTS product_sku VARCHAR(64) NULL",
        "ALTER TABLE product_documents ADD COLUMN IF NOT EXISTS woo_synced_at DATETIME NULL",
        "ALTER TABLE product_documents ADD COLUMN IF NOT EXISTS mime_type VARCHAR(64) NULL",
        "ALTER TABLE product_documents MODIFY COLUMN mime_type VARCHAR(64) NULL",
        "ALTER TABLE product_documents MODIFY COLUMN sha256 CHAR(64) NULL",
        "ALTER TABLE product_documents MODIFY COLUMN data LONGBLOB NULL",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS payment_method VARCHAR(32) NULL",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS payment_instructions LONGTEXT NULL",
        "ALTER TABLE patient_links MODIFY COLUMN patient_id LONGTEXT NULL",
        "ALTER TABLE patient_links MODIFY COLUMN reference_label LONGTEXT NULL",
        "ALTER TABLE patient_links MODIFY COLUMN subject_label LONGTEXT NULL",
        "ALTER TABLE patient_links MODIFY COLUMN study_label LONGTEXT NULL",
        "ALTER TABLE patient_links MODIFY COLUMN patient_reference LONGTEXT NULL",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS received_payment TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS patient_id LONGTEXT NULL",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS reference_label LONGTEXT NULL",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS markup_percent DECIMAL(6,2) NOT NULL DEFAULT 0",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS delegate_review_status VARCHAR(32) NULL",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS delegate_reviewed_at DATETIME NULL",
        "ALTER TABLE patient_links ADD COLUMN IF NOT EXISTS delegate_review_order_id VARCHAR(32) NULL",
        "ALTER TABLE bugs_reported ADD COLUMN IF NOT EXISTS user_id VARCHAR(64) NULL",
        "ALTER TABLE bugs_reported ADD COLUMN IF NOT EXISTS name LONGTEXT NULL",
        "ALTER TABLE bugs_reported ADD COLUMN IF NOT EXISTS email LONGTEXT NULL",
    ]
    for stmt in migrations:
        try:
            mysql_client.execute(stmt)
        except Exception:
            # Best effort; if column exists or engine doesn't support IF NOT EXISTS, ignore
            continue

    # Backward-compatible fix: MySQL/MariaDB variants may not support `ADD COLUMN IF NOT EXISTS`.
    # Ensure `users.is_online` exists so login/logout tracking can persist.
    try:
        if not _column_exists("users", "is_online"):
            mysql_client.execute(
                "ALTER TABLE users ADD COLUMN is_online TINYINT(1) NOT NULL DEFAULT 0"
            )
        mysql_client.execute(
            "ALTER TABLE users MODIFY COLUMN is_online TINYINT(1) NOT NULL DEFAULT 0"
        )
    except Exception:
        # Best effort; do not fail app startup on migration issues.
        pass

    # Ensure cross-device session invalidation support is available.
    try:
        if not _column_exists("users", "hand_delivered"):
            mysql_client.execute(
                "ALTER TABLE users ADD COLUMN hand_delivered TINYINT(1) NOT NULL DEFAULT 0"
            )
        if not _column_exists("users", "session_id"):
            mysql_client.execute("ALTER TABLE users ADD COLUMN session_id VARCHAR(64) NULL")
    except Exception:
        pass

    # Ensure presence timestamps exist so "online"/idle can be derived from activity,
    # not a sticky `is_online` flag.
    try:
        if not _column_exists("users", "last_seen_at"):
            mysql_client.execute("ALTER TABLE users ADD COLUMN last_seen_at DATETIME NULL")
        if not _column_exists("users", "last_interaction_at"):
            mysql_client.execute("ALTER TABLE users ADD COLUMN last_interaction_at DATETIME NULL")
    except Exception:
        pass

    # Ensure user visit tracking exists (used during login/account creation flows).
    try:
        if not _column_exists("users", "visits"):
            mysql_client.execute("ALTER TABLE users ADD COLUMN visits INT NOT NULL DEFAULT 0")
        mysql_client.execute("ALTER TABLE users MODIFY COLUMN visits INT NOT NULL DEFAULT 0")
    except Exception:
        pass

    try:
        if not _column_exists("sales_reps", "is_partner"):
            mysql_client.execute("ALTER TABLE sales_reps ADD COLUMN is_partner TINYINT(1) NOT NULL DEFAULT 0")
    except Exception:
        pass

    try:
        if not _column_exists("sales_reps", "allowed_retail"):
            mysql_client.execute("ALTER TABLE sales_reps ADD COLUMN allowed_retail TINYINT(1) NOT NULL DEFAULT 0")
    except Exception:
        pass

    # Ensure order notes exist (may be missing on older MySQL variants without `ADD COLUMN IF NOT EXISTS`).
    try:
        if not _column_exists("orders", "notes"):
            mysql_client.execute("ALTER TABLE orders ADD COLUMN notes LONGTEXT NULL")
        mysql_client.execute("ALTER TABLE orders MODIFY COLUMN notes LONGTEXT NULL")
    except Exception:
        pass

    # Ensure pickup fulfillment markers exist for checkout persistence/reporting.
    try:
        if not _column_exists("orders", "facility_pickup"):
            mysql_client.execute("ALTER TABLE orders ADD COLUMN facility_pickup TINYINT(1) NOT NULL DEFAULT 0")
        if not _column_exists("orders", "fulfillment_method"):
            mysql_client.execute("ALTER TABLE orders ADD COLUMN fulfillment_method VARCHAR(32) NULL")
    except Exception:
        pass

    try:
        if _column_exists("orders", "pickup_ready_notice"):
            mysql_client.execute("ALTER TABLE orders DROP COLUMN pickup_ready_notice")
        if _column_exists("orders", "pickup_location"):
            mysql_client.execute("ALTER TABLE orders DROP COLUMN pickup_location")
    except Exception:
        pass

    # Ensure sales prospects office address fields exist (used by manual prospects + contact form pipeline).
    try:
        if not _column_exists("sales_prospects", "office_address_line1"):
            mysql_client.execute("ALTER TABLE sales_prospects ADD COLUMN office_address_line1 VARCHAR(190) NULL")
        if not _column_exists("sales_prospects", "office_address_line2"):
            mysql_client.execute("ALTER TABLE sales_prospects ADD COLUMN office_address_line2 VARCHAR(190) NULL")
        if not _column_exists("sales_prospects", "office_city"):
            mysql_client.execute("ALTER TABLE sales_prospects ADD COLUMN office_city VARCHAR(190) NULL")
        if not _column_exists("sales_prospects", "office_state"):
            mysql_client.execute("ALTER TABLE sales_prospects ADD COLUMN office_state VARCHAR(64) NULL")
        if not _column_exists("sales_prospects", "office_postal_code"):
            mysql_client.execute("ALTER TABLE sales_prospects ADD COLUMN office_postal_code VARCHAR(32) NULL")
        if not _column_exists("sales_prospects", "office_country"):
            mysql_client.execute("ALTER TABLE sales_prospects ADD COLUMN office_country VARCHAR(64) NULL")
    except Exception:
        pass

    # Ensure delegation markup percent is stored on doctor records.
    try:
        if not _column_exists("users", "markup_percent"):
            mysql_client.execute("ALTER TABLE users ADD COLUMN markup_percent DECIMAL(6,2) NOT NULL DEFAULT 0")
    except Exception:
        pass

    # Ensure high-traffic sales tracking queries use indexes instead of full table scans.
    try:
        if not _index_exists("users", "idx_users_role"):
            mysql_client.execute("ALTER TABLE users ADD INDEX idx_users_role (role)")
        if not _index_exists("users", "idx_users_sales_rep_id"):
            mysql_client.execute("ALTER TABLE users ADD INDEX idx_users_sales_rep_id (sales_rep_id)")
        if not _index_exists("users", "idx_users_lead_type"):
            mysql_client.execute("ALTER TABLE users ADD INDEX idx_users_lead_type (lead_type)")
        if not _index_exists("orders", "idx_orders_user_id"):
            mysql_client.execute("ALTER TABLE orders ADD INDEX idx_orders_user_id (user_id)")
        if not _index_exists("orders", "idx_orders_created_at"):
            mysql_client.execute("ALTER TABLE orders ADD INDEX idx_orders_created_at (created_at)")
        if not _index_exists("orders", "idx_orders_user_created_at"):
            mysql_client.execute("ALTER TABLE orders ADD INDEX idx_orders_user_created_at (user_id, created_at)")
    except Exception:
        pass

    try:
        if not _column_exists("users", "delegate_logo_url"):
            mysql_client.execute("ALTER TABLE users ADD COLUMN delegate_logo_url LONGTEXT NULL")
    except Exception:
        pass

    try:
        if not _column_exists("users", "delegate_secondary_color"):
            mysql_client.execute("ALTER TABLE users ADD COLUMN delegate_secondary_color VARCHAR(16) NULL")
    except Exception:
        pass

    try:
        if not _column_exists("users", "cart"):
            mysql_client.execute("ALTER TABLE users ADD COLUMN cart JSON NULL")
    except Exception:
        pass

    # Ensure patient_links snapshot has markup column (best-effort; table may not exist yet on older installs).
    try:
        if not _column_exists("patient_links", "token_version"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN token_version SMALLINT NOT NULL DEFAULT 1")
        if not _column_exists("patient_links", "token_ciphertext"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN token_ciphertext LONGTEXT NULL")
        if not _column_exists("patient_links", "token_hint"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN token_hint VARCHAR(32) NULL")
        if not _column_exists("patient_links", "patient_id"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN patient_id LONGTEXT NULL")
        if not _column_exists("patient_links", "reference_label"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN reference_label LONGTEXT NULL")
        if not _column_exists("patient_links", "subject_label"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN subject_label LONGTEXT NULL")
        if not _column_exists("patient_links", "study_label"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN study_label LONGTEXT NULL")
        if not _column_exists("patient_links", "patient_reference"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN patient_reference LONGTEXT NULL")
        if not _column_exists("patient_links", "received_payment"):
            mysql_client.execute(
                "ALTER TABLE patient_links ADD COLUMN received_payment TINYINT(1) NOT NULL DEFAULT 0"
            )
        # Backfill from legacy `label` column, then remove that column.
        if _column_exists("patient_links", "label"):
            mysql_client.execute(
                "UPDATE patient_links SET reference_label = label WHERE reference_label IS NULL AND label IS NOT NULL"
            )
            mysql_client.execute("ALTER TABLE patient_links DROP COLUMN label")
        if not _column_exists("patient_links", "markup_percent"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN markup_percent DECIMAL(6,2) NOT NULL DEFAULT 0")
        if not _column_exists("patient_links", "instructions"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN instructions LONGTEXT NULL")
        if not _column_exists("patient_links", "allowed_products_json"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN allowed_products_json JSON NULL")
        if not _column_exists("patient_links", "usage_limit"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN usage_limit INT NULL")
        if not _column_exists("patient_links", "usage_count"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN usage_count INT NOT NULL DEFAULT 0")
        if not _column_exists("patient_links", "open_count"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN open_count INT NOT NULL DEFAULT 0")
        if not _column_exists("patient_links", "status"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'active'")
        if not _column_exists("patient_links", "last_opened_at"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN last_opened_at DATETIME NULL")
        if not _column_exists("patient_links", "last_order_at"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN last_order_at DATETIME NULL")
        mysql_client.execute("ALTER TABLE patient_links MODIFY COLUMN patient_id LONGTEXT NULL")
        mysql_client.execute("ALTER TABLE patient_links MODIFY COLUMN reference_label LONGTEXT NULL")
        mysql_client.execute("ALTER TABLE patient_links MODIFY COLUMN subject_label LONGTEXT NULL")
        mysql_client.execute("ALTER TABLE patient_links MODIFY COLUMN study_label LONGTEXT NULL")
        mysql_client.execute("ALTER TABLE patient_links MODIFY COLUMN patient_reference LONGTEXT NULL")
        _copy_legacy_ciphertext("patient_links", "patient_id", "patient_id_encrypted")
        _copy_legacy_ciphertext("patient_links", "reference_label", "reference_label_encrypted")
        _copy_legacy_ciphertext("patient_links", "subject_label", "subject_label_encrypted")
        _copy_legacy_ciphertext("patient_links", "study_label", "study_label_encrypted")
        _copy_legacy_ciphertext("patient_links", "patient_reference", "patient_reference_encrypted")
        _copy_legacy_ciphertext("patient_links", "instructions", "instructions_encrypted")
        _copy_legacy_ciphertext("patient_links", "payment_instructions", "payment_instructions_encrypted")
        _copy_legacy_ciphertext("patient_links", "delegate_cart_json", "delegate_cart_encrypted")
        _copy_legacy_ciphertext("patient_links", "delegate_shipping_json", "delegate_shipping_encrypted")
        _copy_legacy_ciphertext("patient_links", "delegate_payment_json", "delegate_payment_encrypted")
        _copy_legacy_ciphertext("patient_links", "delegate_review_notes", "delegate_review_notes_encrypted")
        _drop_column_if_exists("patient_links", "patient_id_encrypted")
        _drop_column_if_exists("patient_links", "reference_label_encrypted")
        _drop_column_if_exists("patient_links", "subject_label_encrypted")
        _drop_column_if_exists("patient_links", "study_label_encrypted")
        _drop_column_if_exists("patient_links", "patient_reference_encrypted")
        _drop_column_if_exists("patient_links", "instructions_encrypted")
        _drop_column_if_exists("patient_links", "payment_instructions_encrypted")
        _drop_column_if_exists("patient_links", "delegate_cart_encrypted")
        _drop_column_if_exists("patient_links", "delegate_shipping_encrypted")
        _drop_column_if_exists("patient_links", "delegate_payment_encrypted")
        _drop_column_if_exists("patient_links", "delegate_review_notes_encrypted")
        try:
            mysql_client.execute(
                """
                UPDATE patient_links
                SET
                    subject_label = COALESCE(subject_label, patient_id),
                    patient_reference = COALESCE(patient_reference, reference_label)
                """
            )
        except Exception:
            pass
    except Exception:
        pass

    # Ensure patient link proposal review fields exist.
    try:
        if not _column_exists("patient_links", "delegate_review_status"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN delegate_review_status VARCHAR(32) NULL")
        if not _column_exists("patient_links", "delegate_reviewed_at"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN delegate_reviewed_at DATETIME NULL")
        if not _column_exists("patient_links", "delegate_review_order_id"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN delegate_review_order_id VARCHAR(32) NULL")
        if not _column_exists("patient_links", "delegate_review_notes"):
            mysql_client.execute("ALTER TABLE patient_links ADD COLUMN delegate_review_notes LONGTEXT NULL")
    except Exception:
        pass

    try:
        if not _column_exists("contact_forms", "email_blind_index"):
            mysql_client.execute("ALTER TABLE contact_forms ADD COLUMN email_blind_index CHAR(64) NULL")
        _drop_index_if_exists("contact_forms", "idx_contact_forms_email")
        mysql_client.execute("ALTER TABLE contact_forms MODIFY COLUMN name LONGTEXT NOT NULL")
        mysql_client.execute("ALTER TABLE contact_forms MODIFY COLUMN email LONGTEXT NOT NULL")
        mysql_client.execute("ALTER TABLE contact_forms MODIFY COLUMN phone LONGTEXT NULL")
        _copy_legacy_ciphertext("contact_forms", "name", "name_encrypted", placeholder="[ENCRYPTED]")
        _copy_legacy_ciphertext("contact_forms", "email", "email_encrypted", placeholder="[ENCRYPTED]")
        _copy_legacy_ciphertext("contact_forms", "phone", "phone_encrypted")
        _drop_column_if_exists("contact_forms", "name_encrypted")
        _drop_column_if_exists("contact_forms", "email_encrypted")
        _drop_column_if_exists("contact_forms", "phone_encrypted")
        if not _index_exists("contact_forms", "idx_contact_forms_email_blind"):
            mysql_client.execute("ALTER TABLE contact_forms ADD INDEX idx_contact_forms_email_blind (email_blind_index)")
        if not _index_exists("contact_forms", "idx_contact_forms_created_at"):
            mysql_client.execute("ALTER TABLE contact_forms ADD INDEX idx_contact_forms_created_at (created_at)")
    except Exception:
        pass

    try:
        if not _column_exists("bugs_reported", "name"):
            mysql_client.execute("ALTER TABLE bugs_reported ADD COLUMN name LONGTEXT NULL")
        if not _column_exists("bugs_reported", "email"):
            mysql_client.execute("ALTER TABLE bugs_reported ADD COLUMN email LONGTEXT NULL")
        mysql_client.execute("ALTER TABLE bugs_reported MODIFY COLUMN name LONGTEXT NULL")
        mysql_client.execute("ALTER TABLE bugs_reported MODIFY COLUMN email LONGTEXT NULL")
        _copy_legacy_ciphertext("bugs_reported", "name", "name_encrypted")
        _copy_legacy_ciphertext("bugs_reported", "email", "email_encrypted")
        _copy_legacy_ciphertext("bugs_reported", "report", "report_encrypted", placeholder="[ENCRYPTED]")
        _drop_column_if_exists("bugs_reported", "name_encrypted")
        _drop_column_if_exists("bugs_reported", "email_encrypted")
        _drop_column_if_exists("bugs_reported", "report_encrypted")
    except Exception:
        pass

    try:
        if not _index_exists("patient_links", "idx_patient_links_status"):
            mysql_client.execute("ALTER TABLE patient_links ADD INDEX idx_patient_links_status (status)")
    except Exception:
        pass

    # Align usage_tracking payload storage with the rest of the schema:
    # JSON payloads are generally stored in LONGTEXT columns in this codebase.
    try:
        if _table_exists("usage_tracking"):
            if not _column_exists("usage_tracking", "id"):
                try:
                    mysql_client.execute(
                        "ALTER TABLE usage_tracking ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST"
                    )
                except Exception:
                    pass
            if not _primary_key_exists("usage_tracking") and _column_exists("usage_tracking", "id"):
                try:
                    mysql_client.execute("ALTER TABLE usage_tracking ADD PRIMARY KEY (id)")
                except Exception:
                    pass
            try:
                if _column_exists("usage_tracking", "id"):
                    mysql_client.execute(
                        "ALTER TABLE usage_tracking MODIFY COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT"
                    )
            except Exception:
                pass
            if not _column_exists("usage_tracking", "details_json"):
                mysql_client.execute("ALTER TABLE usage_tracking ADD COLUMN details_json LONGTEXT NOT NULL")
            try:
                mysql_client.execute("ALTER TABLE usage_tracking MODIFY COLUMN details_json LONGTEXT NOT NULL")
            except Exception:
                pass
            if not _column_exists("usage_tracking", "created_at"):
                try:
                    mysql_client.execute(
                        "ALTER TABLE usage_tracking ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"
                    )
                except Exception:
                    pass
            try:
                if _column_exists("usage_tracking", "created_at"):
                    mysql_client.execute(
                        "ALTER TABLE usage_tracking MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"
                    )
            except Exception:
                pass
            try:
                if not _index_exists("usage_tracking", "idx_usage_tracking_event"):
                    mysql_client.execute("ALTER TABLE usage_tracking ADD INDEX idx_usage_tracking_event (event)")
            except Exception:
                pass
            try:
                if not _index_exists("usage_tracking", "idx_usage_tracking_created"):
                    mysql_client.execute("ALTER TABLE usage_tracking ADD INDEX idx_usage_tracking_created (created_at)")
            except Exception:
                pass
    except Exception:
        pass

    try:
        if not _table_exists("patient_link_audit_events"):
            mysql_client.execute(
                """
                CREATE TABLE IF NOT EXISTS patient_link_audit_events (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    patient_link_token VARCHAR(128) NOT NULL,
                    doctor_id VARCHAR(32) NULL,
                    actor_user_id VARCHAR(32) NULL,
                    actor_role VARCHAR(64) NULL,
                    event_type VARCHAR(64) NOT NULL,
                    event_payload_json LONGTEXT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    KEY idx_patient_link_audit_token (patient_link_token),
                    KEY idx_patient_link_audit_doctor (doctor_id),
                    KEY idx_patient_link_audit_event (event_type),
                    KEY idx_patient_link_audit_created (created_at)
                ) CHARACTER SET utf8mb4
                """
            )
        if not _column_exists("patient_link_audit_events", "resource_ref"):
            mysql_client.execute("ALTER TABLE patient_link_audit_events ADD COLUMN resource_ref VARCHAR(128) NULL")
        if not _column_exists("patient_link_audit_events", "purpose"):
            mysql_client.execute("ALTER TABLE patient_link_audit_events ADD COLUMN purpose VARCHAR(64) NULL")
        if not _column_exists("patient_link_audit_events", "result"):
            mysql_client.execute("ALTER TABLE patient_link_audit_events ADD COLUMN result VARCHAR(32) NULL")
        if not _column_exists("patient_link_audit_events", "request_ip"):
            mysql_client.execute("ALTER TABLE patient_link_audit_events ADD COLUMN request_ip VARCHAR(64) NULL")
        if not _column_exists("patient_link_audit_events", "device_info"):
            mysql_client.execute("ALTER TABLE patient_link_audit_events ADD COLUMN device_info VARCHAR(255) NULL")
        if not _index_exists("patient_link_audit_events", "idx_patient_link_audit_resource_ref"):
            mysql_client.execute(
                "ALTER TABLE patient_link_audit_events ADD INDEX idx_patient_link_audit_resource_ref (resource_ref)"
            )
    except Exception:
        pass
