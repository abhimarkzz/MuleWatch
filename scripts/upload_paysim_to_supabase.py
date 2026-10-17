import os
import time
import hashlib
import uuid
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv


# --------------------------------------------------
# 1. Configuration
# --------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent

load_dotenv(ROOT / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SECRET_KEY", "").strip()

CSV_PATH = ROOT / "data" / "processed" / "paysim_sample_100k.csv"

BATCH_SIZE = 500
MAX_RETRIES = 5

REQUIRED_COLUMNS = [
    "step",
    "type",
    "amount",
    "nameOrig",
    "oldbalanceOrg",
    "newbalanceOrig",
    "nameDest",
    "oldbalanceDest",
    "newbalanceDest",
    "isFraud",
    "isFlaggedFraud",
]

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError(
        "Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env"
    )

if not (
    SUPABASE_KEY.startswith("sb_secret_")
    or SUPABASE_KEY.startswith("eyJ")
):
    raise ValueError(
        "Use a Supabase server-side secret key "
        "or legacy service_role key, not a publishable key."
    )

if not CSV_PATH.exists():
    raise FileNotFoundError(
        f"CSV not found: {CSV_PATH}"
    )

# New Supabase secret keys use the apikey header.
# Legacy service_role JWT keys also use Authorization.
HEADERS = {
    "apikey": SUPABASE_KEY,
    "Content-Type": "application/json",
}

if SUPABASE_KEY.startswith("eyJ"):
    HEADERS["Authorization"] = f"Bearer {SUPABASE_KEY}"

session = requests.Session()


# --------------------------------------------------
# 2. REST API helper
# --------------------------------------------------

def upsert_batch(table, rows, on_conflict, select=None,
                 return_rows=True):

    url = f"{SUPABASE_URL}/rest/v1/{table}"

    params = {"on_conflict": on_conflict}

    if select:
        params["select"] = select

    prefer = "resolution=merge-duplicates"

    if return_rows:
        prefer += ",return=representation"
    else:
        prefer += ",return=minimal"

    headers = {
        **HEADERS,
        "Prefer": prefer,
    }

    for attempt in range(MAX_RETRIES):
        try:
            response = session.post(
                url,
                params=params,
                json=rows,
                headers=headers,
                timeout=90,
            )
        except requests.RequestException:
            if attempt == MAX_RETRIES - 1:
                raise

            time.sleep(2 ** attempt)
            continue

        if response.status_code in (
            429, 500, 502, 503, 504
        ):
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue

        if not response.ok:
            raise RuntimeError(
                f"Supabase error for {table}: "
                f"HTTP {response.status_code}\n"
                f"{response.text[:1500]}"
            )

        if not response.content:
            return []

        return response.json()

    raise RuntimeError(
        f"Failed to upload batch to {table}."
    )


# --------------------------------------------------
# 3. Load and validate the CSV
# --------------------------------------------------

print("Loading PaySim CSV...")

df = pd.read_csv(
    CSV_PATH,
    dtype={
        "nameOrig": "string",
        "nameDest": "string",
    },
)

missing = set(REQUIRED_COLUMNS) - set(df.columns)

if missing:
    raise ValueError(
        f"CSV is missing required columns: {sorted(missing)}"
    )

if df.empty:
    raise ValueError("The CSV contains no transactions.")

if df[REQUIRED_COLUMNS].isnull().any().any():
    raise ValueError(
        "Missing values found in required CSV columns."
    )

print(f"Rows loaded: {len(df):,}")
print(f"Fraud-labelled rows: {int(df['isFraud'].sum()):,}")


# --------------------------------------------------
# 4. Upload unique accounts
# --------------------------------------------------

print("\nPreparing accounts...")

all_ids = pd.unique(
    pd.concat(
        [df["nameOrig"], df["nameDest"]],
        ignore_index=True,
    )
)

account_rows = []

for account_id in all_ids:
    account_id = str(account_id)

    if account_id.startswith("M"):
        account_type = "merchant"
    elif account_id.startswith("C"):
        account_type = "customer"
    else:
        account_type = "unknown"

    account_rows.append({
        "external_account_id": account_id,
        "account_type": account_type,
    })

account_map = {}

total_batches = (
    len(account_rows) + BATCH_SIZE - 1
) // BATCH_SIZE

print(f"Unique accounts: {len(account_rows):,}")

for batch_number, start in enumerate(
    range(0, len(account_rows), BATCH_SIZE), start=1
):
    batch = account_rows[start:start + BATCH_SIZE]

    response_rows = upsert_batch(
        table="accounts",
        rows=batch,
        on_conflict="external_account_id",
        select="id,external_account_id",
    )

    for item in response_rows:
        account_map[item["external_account_id"]] = item["id"]

    if batch_number % 20 == 0 or batch_number == total_batches:
        print(
            f"Accounts: batch {batch_number}/{total_batches}"
        )

if any(
    str(account_id) not in account_map
    for account_id in all_ids
):
    raise RuntimeError(
        "Some account IDs were not returned by Supabase."
    )

print(f"Account mapping ready: {len(account_map):,}")


# --------------------------------------------------
# 5. Generate stable transaction IDs
# --------------------------------------------------

def make_transaction_id(row):
    """Generate the same external ID for the same CSV row."""

    values = [
        str(int(row["step"])),
        str(row["type"]),
        f"{float(row['amount']):.2f}",
        str(row["nameOrig"]),
        f"{float(row['oldbalanceOrg']):.2f}",
        f"{float(row['newbalanceOrig']):.2f}",
        str(row["nameDest"]),
        f"{float(row['oldbalanceDest']):.2f}",
        f"{float(row['newbalanceDest']):.2f}",
        str(int(row["isFraud"])),
        str(int(row["isFlaggedFraud"])),
    ]

    identity = "\x1f".join(values)

    digest = hashlib.sha256(
        identity.encode("utf-8")
    ).hexdigest()

    return f"paysim-{digest}"


# --------------------------------------------------
# 6. Upload transactions
# --------------------------------------------------

print("\nUploading transactions...")

transaction_map = {}

total_batches = (
    len(df) + BATCH_SIZE - 1
) // BATCH_SIZE

for batch_number, start in enumerate(
    range(0, len(df), BATCH_SIZE), start=1
):
    chunk = df.iloc[start:start + BATCH_SIZE]

    payload = []

    for row in chunk.to_dict(orient="records"):
        source_id = str(row["nameOrig"])
        destination_id = str(row["nameDest"])

        record = {
            "external_transaction_id":
                make_transaction_id(row),

            "source_account_id":
                account_map[source_id],

            "destination_account_id":
                account_map[destination_id],

            "transaction_type": str(row["type"]),

            "amount": round(float(row["amount"]), 2),

            "transaction_step": int(row["step"]),

            # This is the dataset's ground-truth label,
            # NOT a prediction made by the ML model.
            "metadata": {
                "dataset": "PaySim",
                "ground_truth_is_fraud":
                    int(row["isFraud"]),
                "is_flagged_fraud":
                    int(row["isFlaggedFraud"]),
                "old_balance_org":
                    float(row["oldbalanceOrg"]),
                "new_balance_orig":
                    float(row["newbalanceOrig"]),
                "old_balance_dest":
                    float(row["oldbalanceDest"]),
                "new_balance_dest":
                    float(row["newbalanceDest"]),
            },
        }

        payload.append(record)

    response_rows = upsert_batch(
        table="transactions",
        rows=payload,
        on_conflict="external_transaction_id",
        select="id,external_transaction_id",
    )

    for item in response_rows:
        transaction_map[item["external_transaction_id"]] = (
            item["id"]
        )

    if batch_number % 20 == 0 or batch_number == total_batches:
        print(
            f"Transactions: batch "
            f"{batch_number}/{total_batches}"
        )

if len(transaction_map) != len(df):
    raise RuntimeError(
        "Some transaction IDs are missing from the API response."
    )

print(f"Transactions uploaded: {len(transaction_map):,}")


# --------------------------------------------------
# 7. Create demonstration alerts for labelled fraud
# --------------------------------------------------

print("\nCreating demonstration fraud alerts...")

fraud_rows = df[df["isFraud"].astype(int) == 1]

alert_payload = []

for row in fraud_rows.to_dict(orient="records"):
    external_id = make_transaction_id(row)
    transaction_id = transaction_map[external_id]

    # Deterministic alert ID prevents duplicates on reruns.
    alert_id = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"paysim-alert:{external_id}",
        )
    )

    alert_payload.append({
        "id": alert_id,
        "transaction_id": transaction_id,
        "severity": "high",
        "status": "open",
        "reason": (
            "Demonstration alert from PaySim ground-truth "
            "label isFraud=1; this is not a live ML prediction."
        ),
    })

if alert_payload:
    for start in range(0, len(alert_payload), BATCH_SIZE):
        batch = alert_payload[start:start + BATCH_SIZE]

        upsert_batch(
            table="alerts",
            rows=batch,
            on_conflict="id",
            return_rows=False,
        )

print(f"Demonstration alerts uploaded: {len(alert_payload):,}")


# --------------------------------------------------
# 8. Final summary
# --------------------------------------------------

print("\n" + "=" * 45)
print("PAYSim IMPORT COMPLETE")
print("=" * 45)
print(f"CSV transactions: {len(df):,}")
print(f"Unique accounts: {len(account_map):,}")
print(f"Transactions upserted: {len(transaction_map):,}")
print(f"Fraud-labelled demonstration alerts: {len(alert_payload):,}")
print("Ground-truth labels stored in metadata.")
print("Model predictions remain unset.")
print("The script can be rerun without duplicating these rows.")