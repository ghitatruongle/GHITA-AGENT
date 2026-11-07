// (7.2) DiagnosticsWritethrough — sau MỌI lần ghi file, chờ diagnostics
// (oh-my-pi lsp/writethrough pattern) và gắn vào tool result để model TỰ
// thấy lỗi ngay lượt sau. Provider do host (Monaco worker / LSP) đăng ký;
// chưa ai đăng ký thì no-op — seam không bao giờ làm chết ghi file.

export interface DiagnosticSummary {
  filePath: string;
  errors: number;
  warnings: number;
  /** Mô tả lỗi đầu tiên (nếu có) — đủ để model tự sửa. */
  first?: string;
}

export type DiagnosticsProvider = (filePath: string) => Promise<DiagnosticSummary | undefined>;

let provider: DiagnosticsProvider | undefined;

export function registerDiagnosticsProvider(p: DiagnosticsProvider | undefined): void {
  provider = p;
}

export function hasDiagnosticsProvider(): boolean {
  return provider !== undefined;
}

/** Chạy provider sau khi ghi; trả về dòng tóm tắt cho tool result. */
export async function diagnosticsAfterWrite(filePath: string): Promise<string | undefined> {
  if (!provider) return undefined;
  try {
    const summary = await provider(filePath);
    if (!summary) return undefined;
    if (summary.errors === 0 && summary.warnings === 0) return undefined;
    const parts = [`Diagnostics sau khi ghi: ${  String(summary.errors)  } error(s), ${  String(summary.warnings)  } warning(s).`];
    if (summary.first) parts.push(`Đầu tiên: ${  summary.first}`);
    return parts.join(' ');
  } catch (err) {
    // Provider hỏng không được phép làm chết ghi file.
    return `Diagnostics provider lỗi: ${  err instanceof Error ? err.message : String(err)}`;
  }
}
