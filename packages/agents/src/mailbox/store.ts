// Persistent mailbox with per-agent inboxes, at-least-once delivery via
// explicit ack, worker_done reports, blocking asks with timeout, and

import Database from 'better-sqlite3';
import type {
  MailboxMessage,
  DeliveryRecord,
  DeliveryStatus,
  WorkerDoneReport,
  WorkerOutcome,
  MailboxAsk,
  DecisionGate,
  MailboxStoreConfig,
} from './types.js';

function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export class MailboxStore {
  /** How long a delivery may stay in_flight before it is redelivered. */
  static readonly VISIBILITY_TIMEOUT_MS = 60_000;
  /** Upper bound on how long awaitGate blocks when nobody resolves the gate. */
  static readonly GATE_TIMEOUT_MS = 600_000;

  private readonly db: Database.Database;
  private readonly maxInboxSize: number;
  private readonly defaultAskTimeoutMs: number;

  /** Per-agent sequence counters for monotonic ordering. */
  private readonly seqCounters = new Map<string, number>();

  constructor(config: MailboxStoreConfig) {
    this.maxInboxSize = config.maxInboxSize ?? 1000;
    this.defaultAskTimeoutMs = config.defaultAskTimeoutMs ?? 30_000;

    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
    this.initSeqCounters();
  }

  // Schema

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reply_to TEXT,
        seq INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_deliveries (
        message_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        delivery_count INTEGER NOT NULL DEFAULT 0,
        last_delivered_at INTEGER NOT NULL DEFAULT 0,
        acked_at INTEGER,
        PRIMARY KEY (message_id, recipient),
        FOREIGN KEY (message_id) REFERENCES mailbox_messages(id)
      );

      CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_status
        ON mailbox_deliveries(recipient, status);

      CREATE TABLE IF NOT EXISTS mailbox_worker_done (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        result TEXT,
        error TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_asks (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        question TEXT NOT NULL,
        options TEXT,
        timeout_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        answered INTEGER NOT NULL DEFAULT 0,
        answer TEXT,
        timed_out INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS mailbox_gates (
        id TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        description TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolution TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_asks_recipient_answered
        ON mailbox_asks(recipient, answered);

      CREATE INDEX IF NOT EXISTS idx_gates_resolved
        ON mailbox_gates(resolved);
    `);
  }

  // Send / Check / Ack / Reply

  /** Send a message to a recipient's inbox. Returns the message id. */
  send(from: string, to: string, payload: unknown, options?: { replyTo?: string }): string {
    const id = generateId();
    const seq = this.nextSeq(from);
    const now = Date.now();

    const insertMsg = this.db.prepare(
      `INSERT INTO mailbox_messages (id, sender, recipient, payload, timestamp, reply_to, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertDelivery = this.db.prepare(
      `INSERT INTO mailbox_deliveries (message_id, recipient, status, delivery_count, last_delivered_at)
       VALUES (?, ?, 'pending', 0, 0)`,
    );

    const txn = this.db.transaction(() => {
      insertMsg.run(id, from, to, JSON.stringify(payload), now, options?.replyTo ?? null, seq);
      insertDelivery.run(id, to);
      this.enforceInboxCap(to);
    });
    txn();

    return id;
  }

  /**
   * Check an agent's inbox for pending messages. Marks returned messages as
   * 'in_flight' and increments delivery_count. Messages are returned in
   * sequence order (oldest first). In-flight messages that are never acked
   * are automatically redelivered after VISIBILITY_TIMEOUT_MS, preserving the
   * at-least-once guarantee across consumer crashes.
   */
  check(agentId: string, limit = 50): DeliveryRecord[] {
    const now = Date.now();

    // Reclaim in-flight deliveries whose consumer died before acking.
    this.db
      .prepare(
        `UPDATE mailbox_deliveries
         SET status = 'pending'
         WHERE recipient = ? AND status = 'in_flight' AND last_delivered_at < ?`,
      )
      .run(agentId, now - MailboxStore.VISIBILITY_TIMEOUT_MS);

    const selectPending = this.db.prepare(
      `SELECT m.id, m.sender, m.recipient, m.payload, m.timestamp, m.reply_to, m.seq,
              d.delivery_count, d.last_delivered_at, d.acked_at
       FROM mailbox_deliveries d
       JOIN mailbox_messages m ON m.id = d.message_id
       WHERE d.recipient = ? AND d.status = 'pending'
       ORDER BY m.seq ASC
       LIMIT ?`,
    );

    const markDelivered = this.db.prepare(
      `UPDATE mailbox_deliveries
       SET status = 'in_flight', delivery_count = delivery_count + 1, last_delivered_at = ?
       WHERE message_id = ? AND recipient = ?`,
    );

    const rows = selectPending.all(agentId, limit) as Array<{
      id: string;
      sender: string;
      recipient: string;
      payload: string;
      timestamp: number;
      reply_to: string | null;
      seq: number;
      delivery_count: number;
      last_delivered_at: number;
      acked_at: number | null;
    }>;

    if (rows.length === 0) return [];

    const txn = this.db.transaction(() => {
      for (const row of rows) {
        markDelivered.run(now, row.id, agentId);
      }
    });
    txn();

    return rows.map((row) => ({
      message: {
        id: row.id,
        from: row.sender,
        to: row.recipient,
        payload: JSON.parse(row.payload),
        timestamp: row.timestamp,
        replyTo: row.reply_to ?? undefined,
        seq: row.seq,
      },
      status: 'delivered' as DeliveryStatus,
      deliveryCount: row.delivery_count + 1,
      lastDeliveredAt: now,
      ackedAt: null,
    }));
  }

  /**
   * Acknowledge a delivered message. Once acked, it will not be redelivered.
   * Returns true if the message was found and acked.
   */
  ack(agentId: string, messageId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE mailbox_deliveries
         SET status = 'acked', acked_at = ?
         WHERE message_id = ? AND recipient = ? AND status IN ('in_flight', 'delivered')`,
      )
      .run(now, messageId, agentId);
    return result.changes > 0;
  }

  /**
   * Convenience: check + ack all returned messages in one call. Useful when
   * the consumer processes messages synchronously and never needs redelivery.
   */
  checkAndAck(agentId: string, limit = 50): MailboxMessage[] {
    const records = this.check(agentId, limit);
    if (records.length === 0) return [];

    const now = Date.now();
    const markAcked = this.db.prepare(
      `UPDATE mailbox_deliveries
       SET status = 'acked', acked_at = ?
       WHERE message_id = ? AND recipient = ? AND status IN ('in_flight', 'delivered')`,
    );

    const txn = this.db.transaction(() => {
      for (const rec of records) {
        markAcked.run(now, rec.message.id, agentId);
      }
    });
    txn();

    return records.map((r) => r.message);
  }

  /** Reply to a specific message (sends to the original sender). */
  reply(from: string, originalMessageId: string, payload: unknown): string {
    const orig = this.db
      .prepare('SELECT sender FROM mailbox_messages WHERE id = ?')
      .get(originalMessageId) as { sender: string } | undefined;
    if (!orig) throw new Error(`Cannot reply: message ${originalMessageId} not found`);
    return this.send(from, orig.sender, payload, { replyTo: originalMessageId });
  }

  // Worker Done

  /** Record that a worker has completed its task. */
  workerDone(agentId: string, outcome: WorkerOutcome, result?: unknown, error?: string): string {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO mailbox_worker_done (id, agent_id, outcome, result, error, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        agentId,
        outcome,
        result !== undefined ? JSON.stringify(result) : null,
        error ?? null,
        Date.now(),
      );
    return id;
  }

  /** Get the latest worker_done report for an agent. */
  getWorkerDone(agentId: string): WorkerDoneReport | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM mailbox_worker_done WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 1',
      )
      .get(agentId) as
      | {
          id: string;
          agent_id: string;
          outcome: string;
          result: string | null;
          error: string | null;
          timestamp: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      agentId: row.agent_id,
      outcome: row.outcome as WorkerOutcome,
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error ?? undefined,
      timestamp: row.timestamp,
    };
  }

  // Ask (blocking question with timeout)

  /** Pose a blocking question. Returns the ask id. */
  ask(
    from: string,
    to: string,
    question: string,
    options?: { timeoutMs?: number; choices?: string[] },
  ): string {
    const id = generateId();
    const timeoutMs = options?.timeoutMs ?? this.defaultAskTimeoutMs;
    this.db
      .prepare(
        `INSERT INTO mailbox_asks (id, sender, recipient, question, options, timeout_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        from,
        to,
        question,
        options?.choices ? JSON.stringify(options.choices) : null,
        timeoutMs,
        Date.now(),
      );
    return id;
  }

  /** Answer a pending ask. Returns true if the ask was found and answered. */
  answerAsk(askId: string, answer: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE mailbox_asks
         SET answered = 1, answer = ?
         WHERE id = ? AND answered = 0 AND timed_out = 0`,
      )
      .run(answer, askId);
    return result.changes > 0;
  }

  /**
   * Wait for an ask to be answered or time out. Polls the database at the
   * given interval. Returns the final ask state.
   */
  async awaitAsk(askId: string, pollIntervalMs = 200): Promise<MailboxAsk> {
    while (true) {
      const ask = this.getAsk(askId);
      if (!ask) throw new Error(`Ask ${askId} not found`);
      if (ask.answered || ask.timedOut) return ask;

      // Check timeout
      const elapsed = Date.now() - ask.createdAt;
      if (ask.timeoutMs > 0 && elapsed >= ask.timeoutMs) {
        this.db
          .prepare('UPDATE mailbox_asks SET timed_out = 1 WHERE id = ? AND answered = 0')
          .run(askId);
        const timedOut = this.getAsk(askId);
        if (!timedOut) {
          throw new Error(`Ask ${askId} disappeared after timeout update`);
        }
        return timedOut;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /** Get an ask by id. */
  getAsk(askId: string): MailboxAsk | undefined {
    const row = this.db.prepare('SELECT * FROM mailbox_asks WHERE id = ?').get(askId) as
      | {
          id: string;
          sender: string;
          recipient: string;
          question: string;
          options: string | null;
          timeout_ms: number;
          created_at: number;
          answered: number;
          answer: string | null;
          timed_out: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      from: row.sender,
      to: row.recipient,
      question: row.question,
      options: row.options ? JSON.parse(row.options) : undefined,
      timeoutMs: row.timeout_ms,
      createdAt: row.created_at,
      answered: row.answered === 1,
      answer: row.answer,
      timedOut: row.timed_out === 1,
    };
  }

  /** Get all pending asks for a recipient. */
  getPendingAsks(recipient: string): MailboxAsk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mailbox_asks
         WHERE recipient = ? AND answered = 0 AND timed_out = 0
         ORDER BY created_at ASC`,
      )
      .all(recipient) as Array<{
      id: string;
      sender: string;
      recipient: string;
      question: string;
      options: string | null;
      timeout_ms: number;
      created_at: number;
      answered: number;
      answer: string | null;
      timed_out: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      from: row.sender,
      to: row.recipient,
      question: row.question,
      options: row.options ? JSON.parse(row.options) : undefined,
      timeoutMs: row.timeout_ms,
      createdAt: row.created_at,
      answered: false,
      answer: null,
      timedOut: false,
    }));
  }

  // Decision Gates

  /** Create a decision gate that blocks task progression. */
  createGate(createdBy: string, description: string): string {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO mailbox_gates (id, created_by, description, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, createdBy, description, Date.now());
    return id;
  }

  /** Resolve a gate with a value. Returns true if the gate was found and resolved. */
  resolveGate(gateId: string, resolution: unknown): boolean {
    const result = this.db
      .prepare(
        `UPDATE mailbox_gates
         SET resolved = 1, resolution = ?, resolved_at = ?
         WHERE id = ? AND resolved = 0`,
      )
      .run(JSON.stringify(resolution), Date.now(), gateId);
    return result.changes > 0;
  }

  /** Get a gate by id. */
  getGate(gateId: string): DecisionGate | undefined {
    const row = this.db.prepare('SELECT * FROM mailbox_gates WHERE id = ?').get(gateId) as
      | {
          id: string;
          created_by: string;
          description: string;
          resolved: number;
          resolution: string | null;
          created_at: number;
          resolved_at: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      createdBy: row.created_by,
      description: row.description,
      resolved: row.resolved === 1,
      resolution: row.resolution ? JSON.parse(row.resolution) : null,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  /** Wait for a gate to be resolved. Throws after `timeoutMs` (default 10
   * minutes) so a gate nobody resolves cannot hang the calling session. */
  async awaitGate(
    gateId: string,
    pollIntervalMs = 200,
    timeoutMs = MailboxStore.GATE_TIMEOUT_MS,
  ): Promise<DecisionGate> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const gate = this.getGate(gateId);
      if (!gate) throw new Error(`Gate ${gateId} not found`);
      if (gate.resolved) return gate;
      if (Date.now() >= deadline) {
        throw new Error(`Gate ${gateId} was not resolved within ${timeoutMs}ms`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /** Get all unresolved gates. */
  getUnresolvedGates(): DecisionGate[] {
    const rows = this.db
      .prepare('SELECT * FROM mailbox_gates WHERE resolved = 0 ORDER BY created_at ASC')
      .all() as Array<{
      id: string;
      created_by: string;
      description: string;
      resolved: number;
      resolution: string | null;
      created_at: number;
      resolved_at: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdBy: row.created_by,
      description: row.description,
      resolved: false,
      resolution: null,
      createdAt: row.created_at,
      resolvedAt: null,
    }));
  }

  // Cleanup & Utilities

  /** Remove acked messages older than maxAgeMs from a recipient's inbox. */
  purgeAcked(recipient: string, maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    // Delete delivery records first (foreign-key-like dependency), then messages.
    this.db
      .prepare(
        `DELETE FROM mailbox_deliveries
         WHERE recipient = ? AND status = 'acked'
           AND message_id IN (SELECT id FROM mailbox_messages WHERE timestamp < ?)`,
      )
      .run(recipient, cutoff);
    const result = this.db
      .prepare(
        `DELETE FROM mailbox_messages
         WHERE timestamp < ?
           AND id NOT IN (SELECT DISTINCT message_id FROM mailbox_deliveries)`,
      )
      .run(cutoff);
    return result.changes;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  // Private Helpers

  private nextSeq(sender: string): number {
    const current = this.seqCounters.get(sender) ?? 0;
    const next = current + 1;
    this.seqCounters.set(sender, next);
    return next;
  }

  /**
   * Initialize in-memory sequence counters from persisted messages so that
   * new messages after a restart continue the sequence instead of colliding
   * with (or sorting before) existing ones.
   */
  private initSeqCounters(): void {
    const rows = this.db
      .prepare('SELECT sender, MAX(seq) AS max_seq FROM mailbox_messages GROUP BY sender')
      .all() as Array<{ sender: string; max_seq: number }>;
    for (const row of rows) {
      this.seqCounters.set(row.sender, row.max_seq);
    }
  }

  private enforceInboxCap(recipient: string): void {
    if (this.maxInboxSize <= 0) return;
    // Guard: only delete when the acked count actually exceeds the cap.
    // Without this, COUNT(*) - cap goes negative and SQLite treats a
    // negative LIMIT as "no limit", deleting ALL acked messages.
    const excess = (
      this.db
        .prepare(
          `SELECT COUNT(*) - ? AS excess FROM mailbox_deliveries
           WHERE recipient = ? AND status = 'acked'`,
        )
        .get(this.maxInboxSize, recipient) as { excess: number }
    ).excess;
    if (excess <= 0) return;

    // Phải xoá `mailbox_deliveries` TRƯỚC. Schema bật `foreign_keys = ON`, nên
    // xoá message còn delivery trỏ tới sẽ ném FOREIGN KEY constraint failed —
    // làm hỏng cả `send()` chứ không chỉ ghi log. `purgeAcked` ở trên cùng file
    // đã làm đúng thứ tự này, `enforceInboxCap` thì bỏ sót.
    this.db
      .prepare(
        `DELETE FROM mailbox_deliveries
         WHERE message_id IN (
           SELECT m.id FROM mailbox_messages m
           JOIN mailbox_deliveries d ON d.message_id = m.id
           WHERE d.recipient = ? AND d.status = 'acked'
           ORDER BY m.timestamp ASC
           LIMIT ?
         )`,
      )
      .run(recipient, excess);

    this.db
      .prepare(
        `DELETE FROM mailbox_messages
         WHERE id IN (
           SELECT m.id FROM mailbox_messages m
           WHERE m.recipient = ?
             AND NOT EXISTS (SELECT 1 FROM mailbox_deliveries d WHERE d.message_id = m.id)
           ORDER BY m.timestamp ASC
           LIMIT ?
         )`,
      )
      .run(recipient, excess);
  }
}
