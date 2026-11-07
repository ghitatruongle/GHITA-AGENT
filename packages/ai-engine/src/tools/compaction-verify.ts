// (8.2) CompactionVerifier — compaction phải ĐO ĐƯỢC (OpenHands
// use-await-context-compaction pattern, MIT): HTTP/ack chỉ nghĩa "đã bắt
// đầu"; outcome là một trong 3: compacted / no_change / timeout, chụp
// baseline token TRƯỚC khi gọi.

export type CompactionOutcome = 'compacted' | 'no_change' | 'timeout';

export interface CompactionBaseline {
  /** Event id chụp TRƯỚC khi gọi compact — để đối chiếu sau. */
  eventId: string;
  perTurnTokens: number;
}

export interface CompactionVerifyInput {
  baseline: CompactionBaseline;
  afterTokens: number;
  /** elapsed >= budget → timeout. */
  elapsedMs: number;
  budgetMs: number;
}

/** Đánh giá 1 kết quả compaction: 3 outcome đo được, không đoán. */
export function verifyCompaction(input: CompactionVerifyInput): {
  outcome: CompactionOutcome;
  tokensSaved: number;
} {
  if (input.elapsedMs >= input.budgetMs && input.afterTokens >= input.baseline.perTurnTokens) {
    return { outcome: 'timeout', tokensSaved: 0 };
  }
  const tokensSaved = input.baseline.perTurnTokens - input.afterTokens;
  if (tokensSaved > 0) {
    return { outcome: 'compacted', tokensSaved };
  }
  return { outcome: 'no_change', tokensSaved: 0 };
}

/** Baseline chụp TRƯỚC khi gọi compact (eventId để đối chiếu event stream). */
export function captureCompactionBaseline(eventId: string, perTurnTokens: number): CompactionBaseline {
  return { eventId, perTurnTokens };
}
