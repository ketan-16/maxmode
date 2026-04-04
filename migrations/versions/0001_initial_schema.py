from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "accounts",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("sync_version", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("account_id", sa.String(length=36), sa.ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("email_normalized", sa.String(length=320), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("email_normalized", name="uq_users_email_normalized"),
    )
    op.create_index("ix_users_account_id", "users", ["account_id"])
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("token_hash", name="uq_auth_sessions_token_hash"),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_table(
        "account_profile",
        sa.Column("account_id", sa.String(length=36), sa.ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("display_name", sa.String(length=80), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("age", sa.Integer(), nullable=True),
        sa.Column("gender", sa.String(length=16), nullable=True),
        sa.Column("activity_level", sa.String(length=48), nullable=True),
        sa.Column("height_cm", sa.Float(), nullable=True),
        sa.Column("height_unit", sa.String(length=16), nullable=False, server_default="cm"),
        sa.Column("weight_unit", sa.String(length=16), nullable=False, server_default="kg"),
        sa.Column("protein_multiplier_g_per_kg", sa.Float(), nullable=False, server_default="1"),
        sa.Column("ai_calculation_mode", sa.String(length=16), nullable=False, server_default="balanced"),
        sa.Column("calorie_goal_objective", sa.String(length=16), nullable=True),
        sa.Column("calorie_goal_preset_key", sa.String(length=32), nullable=True),
        sa.Column("reminder_opt_in", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("last_reminder_day", sa.String(length=10), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "weight_entries",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("account_id", sa.String(length=36), sa.ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("weight_kg", sa.Float(), nullable=False),
        sa.Column("logged_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_weight_entries_account_id", "weight_entries", ["account_id"])
    op.create_index("ix_weight_entries_account_logged_at", "weight_entries", ["account_id", "logged_at"])
    op.create_index("ix_weight_entries_account_version", "weight_entries", ["account_id", "version"])
    op.create_table(
        "meal_entries",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("account_id", sa.String(length=36), sa.ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("confidence", sa.String(length=16), nullable=False),
        sa.Column("portion", sa.Float(), nullable=False),
        sa.Column("base_calories", sa.Integer(), nullable=False),
        sa.Column("base_protein", sa.Integer(), nullable=False),
        sa.Column("base_carbs", sa.Integer(), nullable=False),
        sa.Column("base_fat", sa.Integer(), nullable=False),
        sa.Column("logged_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_meal_entries_account_id", "meal_entries", ["account_id"])
    op.create_index("ix_meal_entries_account_logged_at", "meal_entries", ["account_id", "logged_at"])
    op.create_index("ix_meal_entries_account_version", "meal_entries", ["account_id", "version"])
    op.create_table(
        "applied_mutations",
        sa.Column("mutation_id", sa.String(length=64), primary_key=True),
        sa.Column("account_id", sa.String(length=36), sa.ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", sa.String(length=64), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=True),
        sa.Column("applied_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_applied_mutations_account_id", "applied_mutations", ["account_id"])


def downgrade() -> None:
    op.drop_index("ix_applied_mutations_account_id", table_name="applied_mutations")
    op.drop_table("applied_mutations")
    op.drop_index("ix_meal_entries_account_version", table_name="meal_entries")
    op.drop_index("ix_meal_entries_account_logged_at", table_name="meal_entries")
    op.drop_index("ix_meal_entries_account_id", table_name="meal_entries")
    op.drop_table("meal_entries")
    op.drop_index("ix_weight_entries_account_version", table_name="weight_entries")
    op.drop_index("ix_weight_entries_account_logged_at", table_name="weight_entries")
    op.drop_index("ix_weight_entries_account_id", table_name="weight_entries")
    op.drop_table("weight_entries")
    op.drop_table("account_profile")
    op.drop_index("ix_auth_sessions_user_id", table_name="auth_sessions")
    op.drop_table("auth_sessions")
    op.drop_index("ix_users_account_id", table_name="users")
    op.drop_table("users")
    op.drop_table("accounts")
