import type { AlertSource } from "@/lib/risk";

export type AlertTransaction = {
  id: string;
  external_transaction_id: string | null;
  source_account_id?: string | null;
  destination_account_id?: string | null;
  transaction_type: string | null;
  amount: number | string | null;
  transaction_step: number | null;
  predicted_is_fraud: boolean | null;
  model_score: number | string | null;
  model_version: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

export type AlertRecord = {
  id: string;
  transaction_id: string;
  severity: string | null;
  status: string | null;
  risk_score: number | string | null;
  reason: string | null;
  created_at: string;
  transaction: AlertTransaction | null;
  alert_source: AlertSource;
};

export type AlertsResponse = {
  alerts: AlertRecord[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  summary?: { open: number; investigating: number };
  unverified?: number;
};

export type AlertUpdateResponse = { alert: { id: string; status: string } };
