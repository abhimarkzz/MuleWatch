import { Kafka, logLevel, type Producer, type SASLOptions } from "kafkajs";

export type KafkaConfig = {
  brokers: string[];
  username: string;
  password: string;
  topic: string;
  mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
  ca?: string;
};

const MECHANISMS = ["plain", "scram-sha-256", "scram-sha-512"] as const;

/** Server-only Kafka settings, or null when any required value is missing. */
export function readKafkaConfig(): KafkaConfig | null {
  const brokers = (process.env.KAFKA_BROKERS ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  const username = process.env.KAFKA_USERNAME;
  const password = process.env.KAFKA_PASSWORD;
  const mechanism = (process.env.KAFKA_SASL_MECHANISM?.trim().toLowerCase() || "plain") as KafkaConfig["mechanism"];
  if (!brokers.length || !username || !password || !MECHANISMS.includes(mechanism)) return null;

  return {
    brokers,
    username,
    password,
    mechanism,
    topic: process.env.KAFKA_TOPIC?.trim() || "raw-transactions",
    // Aiven signs broker certificates with a per-project CA; without it the
    // TLS handshake fails verification. PEM text, \n escapes allowed.
    ca: process.env.KAFKA_CA_CERT?.replace(/\\n/g, "\n") || undefined,
  };
}

let cached: { key: string; producer: Promise<Producer> } | null = null;

/**
 * One connected producer per warm server instance. TLS + SASL handshakes
 * take hundreds of milliseconds, so reconnecting per request would slow every
 * publish. A failed connect or send drops the cache (see resetProducer).
 */
export function getProducer(config: KafkaConfig): Promise<Producer> {
  const key = `${config.brokers.join(",")}|${config.username}|${config.mechanism}`;
  if (cached?.key === key) return cached.producer;

  const kafka = new Kafka({
    clientId: "mulewatch-frontend",
    brokers: config.brokers,
    ssl: config.ca ? { ca: [config.ca], rejectUnauthorized: true } : true,
    sasl: { mechanism: config.mechanism, username: config.username, password: config.password } as SASLOptions,
    connectionTimeout: 5_000,
    requestTimeout: 10_000,
    retry: { retries: 2, initialRetryTime: 200, maxRetryTime: 2_000 },
    // KafkaJS logs broker addresses and request details; keep them out.
    logLevel: logLevel.NOTHING,
  });

  // Idempotence makes broker-side retries exactly-once per partition; it
  // requires acks=all and one in-flight request.
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false });
  const connected = producer.connect().then(() => producer);
  cached = { key, producer: connected };
  connected.catch(() => {
    if (cached?.producer === connected) cached = null;
  });
  return connected;
}

/** Disconnects and forgets the cached producer after a failure. */
export async function resetProducer(): Promise<void> {
  const current = cached;
  cached = null;
  if (!current) return;
  try {
    await (await current.producer).disconnect();
  } catch {
    // Already broken; nothing else to release.
  }
}
