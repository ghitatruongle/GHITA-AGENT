//! Sandbox lifecycle state machine với CAS (Track R2, P3).
//!
//! Mẫu AgentEnv: 8-trạng-state CAS `update_state_if_state` (deep-dive
//! `agentenv/02` — CAS Running→Pausing conflict handling). Ở đây pipeline
//! spawn dùng nó để:
//! - chống double-kill (timeout kill đua với exit tự nhiên / IO-budget kill),
//! - làm lifecycle tường minh: Created → Running → (Killing) → Killed |
//!   TimedOut | Completed | Failed.

use std::sync::atomic::{AtomicU32, Ordering};

/// Trạng thái lifecycle của một lần spawn sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub(crate) enum SandboxState {
    /// Đã tạo session, chưa spawn.
    Created = 0,
    /// Child đã spawn + được contain + resume, đang chạy.
    Running = 1,
    /// Đã thắng CAS kill — đang kill child.
    Killing = 2,
    /// Child bị kill (IO budget vượt limit).
    Killed = 3,
    /// Child bị kill do vượt timeout (wall-clock hoặc Job TTL).
    TimedOut = 4,
    /// Child exit tự nhiên, đã reap.
    Completed = 5,
    /// Spawn/contain thất bại — child không bao giờ chạy.
    Failed = 6,
}

impl SandboxState {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            SandboxState::Created => "created",
            SandboxState::Running => "running",
            SandboxState::Killing => "killing",
            SandboxState::Killed => "killed",
            SandboxState::TimedOut => "timed-out",
            SandboxState::Completed => "completed",
            SandboxState::Failed => "failed",
        }
    }
}

/// CAS lifecycle guard — một instance cho một lần spawn.
pub(crate) struct Lifecycle {
    state: AtomicU32,
}

impl Lifecycle {
    pub(crate) fn new() -> Self {
        Self {
            state: AtomicU32::new(SandboxState::Created as u32),
        }
    }

    pub(crate) fn get(&self) -> SandboxState {
        match self.state.load(Ordering::SeqCst) {
            1 => SandboxState::Running,
            2 => SandboxState::Killing,
            3 => SandboxState::Killed,
            4 => SandboxState::TimedOut,
            5 => SandboxState::Completed,
            6 => SandboxState::Failed,
            _ => SandboxState::Created,
        }
    }

    /// CAS `update_state_if_state`: chỉ chuyển `expected` → `next` khi state
    /// hiện tại đúng bằng `expected`. Trả `true` khi thắng race — thread/
    /// nhánh thua phải bỏ ý định của mình (ví dụ timeout-kill thua exit
    /// tự nhiên thì chỉ reap, không kill nữa).
    pub(crate) fn update_state_if_state(&self, expected: SandboxState, next: SandboxState) -> bool {
        self.state
            .compare_exchange(
                expected as u32,
                next as u32,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    #[test]
    fn cas_transitions_only_from_expected_state() {
        let lifecycle = Lifecycle::new();
        assert_eq!(lifecycle.get(), SandboxState::Created);

        // Sai expected: Created → Completed bị chặn (chưa Running).
        assert!(!lifecycle.update_state_if_state(SandboxState::Running, SandboxState::Completed));
        assert_eq!(lifecycle.get(), SandboxState::Created);

        assert!(lifecycle.update_state_if_state(SandboxState::Created, SandboxState::Running));
        assert_eq!(lifecycle.get(), SandboxState::Running);

        // Running → Completed đúng đường.
        assert!(lifecycle.update_state_if_state(SandboxState::Running, SandboxState::Completed));
        // Từ Completed không thể quay lại Running (terminal state).
        assert!(!lifecycle.update_state_if_state(SandboxState::Running, SandboxState::Killing));
        assert_eq!(lifecycle.get(), SandboxState::Completed);
    }

    #[test]
    fn cas_has_exactly_one_winner_under_thread_race() {
        // 16 thread đua 2 nhánh kill/complete từ Running — đúng 1 thắng,
        // tổng số lần CAS thành công = 1 (mẫu AgentEnv conflict handling).
        let lifecycle = Arc::new(Lifecycle::new());
        assert!(lifecycle.update_state_if_state(SandboxState::Created, SandboxState::Running));

        let wins = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for i in 0..16 {
            let lifecycle = Arc::clone(&lifecycle);
            let wins = Arc::clone(&wins);
            handles.push(std::thread::spawn(move || {
                let next = if i % 2 == 0 {
                    SandboxState::Killing
                } else {
                    SandboxState::Completed
                };
                if lifecycle.update_state_if_state(SandboxState::Running, next) {
                    wins.fetch_add(1, Ordering::SeqCst);
                }
            }));
        }
        for handle in handles {
            let _ = handle.join();
        }

        assert_eq!(wins.load(Ordering::SeqCst), 1, "exactly one CAS winner");
        let final_state = lifecycle.get();
        assert!(
            final_state == SandboxState::Killing || final_state == SandboxState::Completed,
            "final state must match the winner: {final_state:?}"
        );
    }
}
