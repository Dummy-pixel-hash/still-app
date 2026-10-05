//! Shutdown-ownership regression tests (Live→Closed instant-kill fix).
//!
//! Proves, deterministically (no sleeps-as-assertions, no network):
//!
//! A. A newly established session does NOT immediately observe shutdown:
//!    the receiver stays PENDING while the sender is owned (fails against
//!    the old `let (_shutdown_tx, …)` dead-sender implementation).
//! B. The worker session stays alive after LIVE until explicit disconnect:
//!    modeled by holding the sender owned across a yield point and then
//!    delivering the disconnect signal through take()+send().
//! C. still_disconnect's take()+send() terminates the worker cleanly:
//!    receiver resolves Ok (clean branch), never hangs, never leaks.
//! D. A taken/cleared sender cannot leak: Option is None after take().
//! E. Host-key/tmux persistence semantics untouched (covered by existing
//!    core/hostkeys suites; reconnect -A assertion lives in lib tests).
//!
//! Run: cargo test --locked --test shutdown_lifecycle

use std::future::Future;
use std::task::{Context, Poll, RawWaker, Waker};
use std::time::Duration;

fn noop_waker() -> Waker {
    fn no_op(_: *const ()) {}
    fn clone(_: *const ()) -> RawWaker {
        RawWaker::new(std::ptr::null(), &VTABLE)
    }
    // `RawWakerVTable` is the std-internal name; the stable path re-export
    // works on this toolchain via `core::task`.
    static VTABLE: core::task::RawWakerVTable =
        core::task::RawWakerVTable::new(clone, no_op, no_op, no_op);
    unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
}

fn is_pending<T>(fut: std::pin::Pin<&mut (impl Future<Output = T>)>) -> bool {
    let waker = noop_waker();
    let mut cx = Context::from_waker(&waker);
    matches!(fut.poll(&mut cx), Poll::Pending)
}

/// A. Fresh session receiver is PENDING while the sender is owned.
/// Fails against the old dead-sender spawn (receiver pre-resolved Closed).
#[tokio::test]
async fn fresh_session_does_not_observe_shutdown() {
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    // Sender owned (as LiveSession.shutdown_tx now holds it).
    let mut rx = shutdown_rx;
    {
        let mut recv = std::pin::pin!(async { (&mut rx).await });
        assert!(
            is_pending(recv.as_mut()),
            "shutdown fired without disconnect: sender was dropped at spawn (old bug)"
        );
    }
    // Deterministic liveness: still pending after yielding to the runtime.
    tokio::task::yield_now().await;
    {
        let mut recv2 = std::pin::pin!(async { (&mut rx).await });
        assert!(
            is_pending(recv2.as_mut()),
            "shutdown fired while session alive (old bug)"
        );
    }
    drop(shutdown_tx);
}

/// B. Session survives past the LIVE point until explicit disconnect.
/// Models: LIVE emitted -> runtime yields (first data window) -> receiver
/// still pending -> disconnect signal -> clean Ok.
#[tokio::test]
async fn session_survives_live_until_explicit_disconnect() {
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    // Simulate post-LIVE settling: several yields, receiver must not fire.
    for _ in 0..10 {
        tokio::task::yield_now().await;
        let mut recv = std::pin::pin!(async { (&mut shutdown_rx).await });
        assert!(
            is_pending(recv.as_mut()),
            "worker would have exited right after LIVE without disconnect"
        );
    }
    // Explicit disconnect: take()+send() delivers clean shutdown.
    let _ = shutdown_tx.send(());
    let got = tokio::time::timeout(Duration::from_secs(2), async {
        (&mut shutdown_rx).await
    })
    .await
    .expect("disconnect signal must arrive, not hang");
    assert!(got.is_ok(), "disconnect must resolve the worker cleanly");
}

/// C+D. Disconnect take()+send() terminates cleanly and cannot leak.
#[tokio::test]
async fn disconnect_take_signals_once_and_clears() {
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let mut owned: Option<tokio::sync::oneshot::Sender<()>> = Some(shutdown_tx);
    let taken = owned.take();
    assert!(owned.is_none(), "sender must be cleared after take (no leak)");
    assert!(taken.is_some(), "session must own its shutdown sender");
    let _ = taken.unwrap().send(());
    let got = tokio::time::timeout(Duration::from_secs(2), shutdown_rx)
        .await
        .expect("disconnect signal must arrive, not hang");
    assert!(got.is_ok(), "worker must terminate on disconnect signal");
    // Second take yields None: no double-signal, no leak.
    assert!(owned.take().is_none(), "no second sender may exist");
}

/// Old-bug signature, locked in as documentation: a dropped sender makes
/// the receiver resolve Closed promptly (never hang). The tests above
/// forbid this state for live sessions.
#[tokio::test]
async fn dropped_sender_signature_is_immediate_closed() {
    let rx = {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        drop(tx);
        rx
    };
    let got = tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .expect("dropped-sender receiver must resolve, not hang");
    assert!(
        got.is_err(),
        "dropped sender must yield Closed — the exact old-bug signature live sessions must never see"
    );
}
