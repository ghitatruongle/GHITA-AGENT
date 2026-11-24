// Human-in-the-loop approval dialogs with glassmorphism styling.

import React from 'react';
import type {
  ToolApprovalRequest,
  FileApprovalRequest,
  ResumeApprovalRequest,
} from './useChatSocket';

interface ChatToolApprovalProps {
  t: (key: string, params?: Record<string, string | number>) => string;
  approvalRequest: ToolApprovalRequest | null;
  fileApprovalRequest: FileApprovalRequest | null;
  resumeApprovalRequest: ResumeApprovalRequest | null;
  onApproveTool: () => void;
  onRejectTool: () => void;
  onChooseOption?: (option: string) => void;
  onApproveFileWrite: () => void;
  onRejectFileWrite: () => void;
  onConfirmResume: () => void;
  onRejectResume: () => void;
}

export function ChatToolApproval({
  t,
  approvalRequest,
  fileApprovalRequest,
  resumeApprovalRequest,
  onApproveTool,
  onRejectTool,
  onChooseOption,
  onApproveFileWrite,
  onRejectFileWrite,
  onConfirmResume,
  onRejectResume,
}: ChatToolApprovalProps) {
  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    background: 'rgba(15, 23, 42, 0.85)',
    backdropFilter: 'blur(16px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
    zIndex: 9999,
    animation: 'fadeIn 0.2s ease',
  };

  return (
    <>
      {/* Tool Approval Modal */}
      {approvalRequest && (
        <div style={overlayStyle}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="tool-approval-title"
            aria-describedby="tool-approval-description"
            style={{
              width: '100%',
              maxWidth: '300px',
              background: 'rgba(30, 41, 59, 0.7)',
              border: '1px solid rgba(244, 63, 94, 0.3)',
              boxShadow: '0 8px 32px rgba(244, 63, 94, 0.2)',
              borderRadius: '16px',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '20px' }}>⚠️</span>
              <span
                id="tool-approval-title"
                style={{
                  fontWeight: 700,
                  fontSize: '13px',
                  color: '#f43f5e',
                  letterSpacing: '1px',
                }}
              >
                {t('chat.approveTool')}
              </span>
            </div>

            <div
              id="tool-approval-description"
              style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
            >
              <span style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>
                {t('chat.toolName')}
              </span>
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#f1f5f9',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {approvalRequest.name}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>
                {approvalRequest.chooseOptions ? 'Options' : t('chat.parameters')}
              </span>
              {approvalRequest.chooseOptions ? (
                // Track S3 P3: `choose` — the question rides in `arguments`
                // (the sidecar relays it as `command`); without it the user
                // would see options with nothing explaining what they answer.
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span
                    style={{
                      fontSize: '12px',
                      color: '#e2e8f0',
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {approvalRequest.arguments}
                  </span>
                  {approvalRequest.chooseOptions.map((option, index) => (
                    <button
                      key={`${index}-${option}`}
                      type="button"
                      onClick={() => onChooseOption?.(option)}
                      style={{
                        padding: '9px 10px',
                        borderRadius: '8px',
                        border: '1px solid rgba(59, 130, 246, 0.35)',
                        background: 'rgba(59, 130, 246, 0.12)',
                        color: '#e2e8f0',
                        fontSize: '12px',
                        fontWeight: 600,
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      {index + 1}. {option}
                    </button>
                  ))}
                </div>
              ) : (
                <pre
                  style={{
                    margin: 0,
                    padding: '10px',
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.05)',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#cbd5e1',
                    maxHeight: '120px',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {approvalRequest.arguments}
                </pre>
              )}
            </div>

            {approvalRequest.warningMessage && (
              <div
                style={{
                  background: 'rgba(244, 63, 94, 0.1)',
                  border: '1px solid rgba(244, 63, 94, 0.2)',
                  borderRadius: '8px',
                  padding: '10px 12px',
                  fontSize: '11px',
                  color: '#fda4af',
                  lineHeight: '1.5',
                }}
              >
                🚨 **{t('chat.warning')}** {approvalRequest.warningMessage}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button
                type="button"
                onClick={onRejectTool}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.05)',
                  background: 'rgba(15, 23, 42, 0.4)',
                  color: '#94a3b8',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
              >
                {t('chat.reject')}
              </button>
              {!approvalRequest.chooseOptions && (
                <button
                  type="button"
                  onClick={onApproveTool}
                  style={{
                    flex: 1,
                    padding: '10px 0',
                    borderRadius: '8px',
                    border: 'none',
                    background: 'linear-gradient(135deg, #f43f5e 0%, #e11d48 100%)',
                    color: '#fff',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(244, 63, 94, 0.3)',
                    transition: 'transform 0.1s',
                  }}
                >
                  {t('chat.approve')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* File Write Approval Modal */}
      {fileApprovalRequest && (
        <div style={overlayStyle}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="file-approval-title"
            aria-describedby="file-approval-description"
            style={{
              width: '100%',
              maxWidth: '300px',
              background: 'rgba(30, 41, 59, 0.7)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              boxShadow: '0 8px 32px rgba(59, 130, 246, 0.2)',
              borderRadius: '16px',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '20px' }}>
                {fileApprovalRequest.operation === 'write' ? '📝' : '✏️'}
              </span>
              <span
                id="file-approval-title"
                style={{
                  fontWeight: 700,
                  fontSize: '13px',
                  color: '#3b82f6',
                  letterSpacing: '1px',
                }}
              >
                {fileApprovalRequest.operation === 'write' ? 'TẠO FILE MỚI' : 'SỬA FILE'}
              </span>
            </div>

            <div
              id="file-approval-description"
              style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
            >
              <span style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>
                File
              </span>
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#f1f5f9',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {fileApprovalRequest.filePath}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button
                type="button"
                onClick={onRejectFileWrite}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.05)',
                  background: 'rgba(15, 23, 42, 0.4)',
                  color: '#94a3b8',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
              >
                {t('chat.reject')}
              </button>
              <button
                type="button"
                onClick={onApproveFileWrite}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                  color: '#fff',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)',
                  transition: 'transform 0.1s',
                }}
              >
                {t('chat.approve')}
              </button>
            </div>
          </div>
        </div>
      )}

      {resumeApprovalRequest && (
        <div style={overlayStyle}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="resume-agent-title"
            aria-describedby="resume-agent-description"
            style={{
              width: '100%',
              maxWidth: '340px',
              background: 'rgba(30, 41, 59, 0.95)',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              boxShadow: '0 8px 32px rgba(245, 158, 11, 0.2)',
              borderRadius: '16px',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div id="resume-agent-title" style={{ color: '#fbbf24', fontWeight: 700 }}>
              Khôi phục tác vụ agent?
            </div>
            <div
              id="resume-agent-description"
              style={{ color: '#cbd5e1', fontSize: '12px', lineHeight: 1.6 }}
            >
              Tác vụ <code>{resumeApprovalRequest.runId}</code> dừng khi còn thao tác chờ. Chỉ tiếp
              tục nếu bạn chấp nhận các tool có thể được chạy lại.
            </div>
            <div
              style={{
                background: 'rgba(15, 23, 42, 0.65)',
                borderRadius: '8px',
                padding: '10px',
                fontSize: '12px',
                color: '#f8fafc',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {resumeApprovalRequest.pendingTools.length > 0
                ? resumeApprovalRequest.pendingTools.join(', ')
                : 'Không xác định'}
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                onClick={onRejectResume}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(15, 23, 42, 0.5)',
                  color: '#cbd5e1',
                  cursor: 'pointer',
                }}
              >
                Giữ trạng thái dừng
              </button>
              <button
                type="button"
                onClick={onConfirmResume}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                  color: '#fff',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Xác nhận chạy lại
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
