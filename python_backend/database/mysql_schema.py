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
        downloads LONGTEXT NULL,
        referral_credits DECIMAL(12,2) NOT NULL DEFAULT 0,
        total_referrals INT NOT NULL DEFAULT 0,
        visits INT NOT NULL DEFAULT 0,
        created_at DATETIME NULL,
        last_login_at DATETIME NULL,
        must_reset_password TINYINT(1) NOT NULL DEFAULT 0,
        first_order_bonus_granted_at DATETIME NULL
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
        password VARCHAR(255) NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'sales_rep',
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        session_id VARCHAR(64) NULL,
        referral_credits DECIMAL(12,2) NOT NULL DEFAULT 0,
        total_referrals INT NOT NULL DEFAULT 0,
        visits INT NOT NULL DEFAULT 0,
        last_login_at DATETIME NULL,
        must_reset_password TINYINT(1) NOT NULL DEFAULT 0,
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
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        UNIQUE KEY uniq_sales_rep_doctor (sales_rep_id, doctor_id),
        UNIQUE KEY uniq_sales_rep_referral (sales_rep_id, referral_id),
        UNIQUE KEY uniq_sales_rep_contact_form (sales_rep_id, contact_form_id)
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
        pricing_mode VARCHAR(16) NOT NULL DEFAULT 'wholesale',
        items LONGTEXT NULL,
        total DECIMAL(12,2) NOT NULL DEFAULT 0,
        shipping_total DECIMAL(12,2) NOT NULL DEFAULT 0,
        shipping_carrier VARCHAR(64) NULL,
        shipping_service VARCHAR(128) NULL,
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
        updated_at DATETIME NULL
    ) CHARACTER SET utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS contact_forms (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(64) NULL,
        source VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
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

    # Apply lightweight schema evolutions without breaking existing tables
    migrations = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url LONGTEXT NULL",
        "ALTER TABLE users MODIFY COLUMN profile_image_url LONGTEXT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS downloads LONGTEXT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_online TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users MODIFY COLUMN is_online TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS session_id VARCHAR(64) NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_interaction_at DATETIME NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS visits INT NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS session_id VARCHAR(64) NULL",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS legacy_user_id VARCHAR(32) NULL",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS password VARCHAR(255) NULL",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS role VARCHAR(32) NOT NULL DEFAULT 'sales_rep'",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS referral_credits DECIMAL(12,2) NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS total_referrals INT NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS visits INT NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS last_login_at DATETIME NULL",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS must_reset_password TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS first_order_bonus_granted_at DATETIME NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(16) NOT NULL DEFAULT 'wholesale'",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_total DECIMAL(12,2) NOT NULL DEFAULT 0",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_carrier VARCHAR(64) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_service VARCHAR(128) NULL",
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
        if not _column_exists("sales_reps", "session_id"):
            mysql_client.execute("ALTER TABLE sales_reps ADD COLUMN session_id VARCHAR(64) NULL")
    except Exception:
        pass

    # Ensure order notes exist (may be missing on older MySQL variants without `ADD COLUMN IF NOT EXISTS`).
    try:
        if not _column_exists("orders", "notes"):
            mysql_client.execute("ALTER TABLE orders ADD COLUMN notes LONGTEXT NULL")
        mysql_client.execute("ALTER TABLE orders MODIFY COLUMN notes LONGTEXT NULL")
    except Exception:
        pass

    # Ensure sales rep visit tracking exists (used during login/account creation flows).
    try:
        if not _column_exists("sales_reps", "visits"):
            mysql_client.execute("ALTER TABLE sales_reps ADD COLUMN visits INT NOT NULL DEFAULT 0")
        mysql_client.execute("ALTER TABLE sales_reps MODIFY COLUMN visits INT NOT NULL DEFAULT 0")
    except Exception:
        pass
