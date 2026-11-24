// Wires together extracted hooks and sub-components.

import { useState, useRef } from 'react';
import { useTranslation } from '../i18n';
import { useAppStore } from '../stores/appStore';
import { useChatSessions } from '../hooks/useChatSessions';

// Extracted hooks
import { useChatSocket } from './chat/useChatSocket';
import { useChatModelSelector } from './chat/useChatModelSelector';
import { useChatSend } from './chat/useChatSend';

// Extracted components
import { ChatHeader } from './chat/ChatHeader';
import { ChatMessages } from './chat/ChatMessages';
import { ChatHistory } from './chat/ChatHistory';
import { ChatInput } from './chat/ChatInput';
import { ChatToolApproval } from './chat/ChatToolApproval';
import { ChatAgentControls } from './chat/ChatAgentControls';

export function ChatPanel() {
  const { t, lang } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;

  const {
    sessions,
    activeSessionId,
    currentView,
    setCurrentView,
    messages,
    setMessages,
    selectSession: handleSelectSession,
    createSession: handleCreateSession,
    deleteSession: handleDeleteSession,
  } = useChatSessions();

  const [reconnectTrigger, setReconnectTrigger] = useState(0);

  // Context usage from store
  const contextUsage = useAppStore((s) => s.contextUsage);

  // Socket connection & event handling
  const {
    socketRef,
    connectionStatus,
    agentEvents,
    setAgentEvents,
    approvalRequest,
    fileApprovalRequest,
    resumeApprovalRequest,
    agentRuns,
    ralphProgress,
    isSending,
    setIsSending,
    setActiveFlow,
    handleReconnect,
    handleApproveTool,
    handleRejectTool,
    handleChooseOption,
    handleApproveFileWrite,
    handleRejectFileWrite,
    handleConfirmResume,
    handleRejectResume,
    refreshAgentRuns,
    handleResumeRun,
  } = useChatSocket({ setMessages, tRef, reconnectTrigger });

  // Model selector
  const {
    modelOptions,
    provider,
    setProvider,
    modelDropdownOpen,
    setModelDropdownOpen,
    modelSearch,
    setModelSearch,
  } = useChatModelSelector();

  // Send logic, modes, and input
  const {
    input,
    setInput,
    attachedImage,
    setAttachedImage,
    showSlashMenu,
    setShowSlashMenu,
    slashCommands,
    filteredSlashCmds,
    agentRole,
    setAgentRole,
    ralphMode,
    setRalphMode,
    agentMode,
    setAgentMode,
    reviewMode,
    setReviewMode,
    featureMode,
    setFeatureMode,
    activeFlowLocal,
    permissionMode,
    setPermissionMode,
    showAdvanced,
    setShowAdvanced,
    handleInputChange,
    handlePaste,
    handleDrop,
    handleSend,
  } = useChatSend({
    socketRef,
    messages,
    setMessages,
    connectionStatus,
    modelOptions,
    provider,

    isSending,
    setIsSending,
    setActiveFlow,
    t,
  });

  const onReconnect = async () => {
    await handleReconnect();
    setReconnectTrigger((prev) => prev + 1);
  };

  const onResumeAgentRun = (runId: string) => {
    setCurrentView('chat');
    handleResumeRun(runId);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(20px)',
        borderLeft: '1px solid rgba(255, 255, 255, 0.05)',
        color: '#f8fafc',
        position: 'relative',
      }}
    >
      {/* Header */}
      <ChatHeader
        t={t}
        connectionStatus={connectionStatus}
        currentView={currentView}
        setCurrentView={setCurrentView}
        handleCreateSession={handleCreateSession}
        handleReconnect={onReconnect}
        messages={messages}
        modelOptions={modelOptions}
        provider={provider}
        setProvider={setProvider}
        modelDropdownOpen={modelDropdownOpen}
        setModelDropdownOpen={setModelDropdownOpen}
        modelSearch={modelSearch}
        setModelSearch={setModelSearch}
      />

      {currentView === 'history' ? (
        /* History View */
        <ChatHistory
          sessions={sessions}
          activeSessionId={activeSessionId}
          lang={lang}
          t={t}
          handleSelectSession={handleSelectSession}
          handleCreateSession={handleCreateSession}
          handleDeleteSession={handleDeleteSession}
          agentRuns={agentRuns}
          onRefreshAgentRuns={refreshAgentRuns}
          onResumeAgentRun={onResumeAgentRun}
        />
      ) : (
        /* Chat View */
        <>
          {/* Messages Window */}
          <ChatMessages messages={messages} lang={lang} />

          {/* Agent Controls: events, status bar, advanced toggles, Ralph progress */}
          <ChatAgentControls
            t={t}
            contextUsage={contextUsage}
            ralphMode={ralphMode}
            agentEvents={agentEvents}
            setAgentEvents={setAgentEvents}
            showAdvanced={showAdvanced}
            setShowAdvanced={setShowAdvanced}
            agentRole={agentRole}
            setAgentRole={setAgentRole}
            agentMode={agentMode}
            setAgentMode={setAgentMode}
            reviewMode={reviewMode}
            setReviewMode={setReviewMode}
            featureMode={featureMode}
            setFeatureMode={setFeatureMode}
            setRalphMode={setRalphMode}
            activeFlowLocal={activeFlowLocal}
            permissionMode={permissionMode}
            setPermissionMode={setPermissionMode}
            setActiveFlow={setActiveFlow}
            ralphProgress={ralphProgress}
          />

          {/* Input Area */}
          <ChatInput
            t={t}
            input={input}
            onInputChange={handleInputChange}
            onSend={handleSend}
            isSending={isSending}
            connectionStatus={connectionStatus}
            hasModelOptions={modelOptions.length > 0}
            showSlashMenu={showSlashMenu}
            slashCommands={slashCommands}
            filteredSlashCmds={filteredSlashCmds}
            setShowSlashMenu={setShowSlashMenu}
            setInput={setInput}
            attachedImage={attachedImage}
            setAttachedImage={setAttachedImage}
            onPaste={handlePaste}
            onDrop={handleDrop}
          />
        </>
      )}

      {/* Tool & File Approval Modals */}
      <ChatToolApproval
        t={t}
        approvalRequest={approvalRequest}
        fileApprovalRequest={fileApprovalRequest}
        resumeApprovalRequest={resumeApprovalRequest}
        onApproveTool={handleApproveTool}
        onRejectTool={handleRejectTool}
        onChooseOption={handleChooseOption}
        onApproveFileWrite={handleApproveFileWrite}
        onRejectFileWrite={handleRejectFileWrite}
        onConfirmResume={handleConfirmResume}
        onRejectResume={handleRejectResume}
      />
    </div>
  );
}
