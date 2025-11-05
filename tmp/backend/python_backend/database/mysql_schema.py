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
        phone VARCHAR(32) NULL,
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
        referral_code VARCHAR(8) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        referrer_bonus LONGTEXT NULL,
        first_order_bonus LONGTEXT NULL,
        integrations LONGTEXT NULL,
        shipping_address LONGTEXT NULL,
        created_at DATETIME NULL
    ) CHARACTER SET utf8mb4
    """
]


def ensure_schema() -> None:
    for statement in CREATE_TABLE_STATEMENTS:
        mysql_client.execute(statement)
