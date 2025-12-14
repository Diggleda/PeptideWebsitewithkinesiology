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
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190) NULL UNIQUE,
        phone VARCHAR(32) NULL,
        territory VARCHAR(120) NULL,
        initials VARCHAR(10) NULL,
        sales_code VARCHAR(8) NULL UNIQUE,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
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
    """
]


def ensure_schema() -> None:
    for statement in CREATE_TABLE_STATEMENTS:
        mysql_client.execute(statement)

    # Apply lightweight schema evolutions without breaking existing tables
    migrations = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url LONGTEXT NULL",
        "ALTER TABLE users MODIFY COLUMN profile_image_url LONGTEXT NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_total DECIMAL(12,2) NOT NULL DEFAULT 0",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_carrier VARCHAR(64) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_service VARCHAR(128) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS physician_certified TINYINT(1) NOT NULL DEFAULT 0",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_rate LONGTEXT NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS payload LONGTEXT NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at DATETIME NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS woo_order_id VARCHAR(32) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS woo_order_number VARCHAR(64) NULL",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS woo_order_key VARCHAR(64) NULL",
        "ALTER TABLE referrals ADD COLUMN IF NOT EXISTS credit_issued_at DATETIME NULL",
        "ALTER TABLE referrals ADD COLUMN IF NOT EXISTS credit_issued_amount DECIMAL(12,2) NULL",
        "ALTER TABLE referrals ADD COLUMN IF NOT EXISTS credit_issued_by VARCHAR(190) NULL",
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
    ]
    for stmt in migrations:
        try:
            mysql_client.execute(stmt)
        except Exception:
            # Best effort; if column exists or engine doesn't support IF NOT EXISTS, ignore
            continue
