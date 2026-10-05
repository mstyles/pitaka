//! The order books are indexed for chapter search in: one worker takes
//! books first in, first out, so a queue of them can be stopped. Plain
//! `std`, with no SQL or Tauri, so its rules are tested without either.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

#[derive(Default)]
struct QueueState {
    waiting: VecDeque<i64>,
    /// The book the worker is indexing.
    current: Option<i64>,
    /// Set to ask the current run to end; a fresh one per run.
    cancel: Arc<AtomicBool>,
    /// Set by [`IndexQueue::stop`]: new imports aren't queued until
    /// indexing is asked for again. Only kept in memory, so restarting the
    /// app ends it.
    paused: bool,
}

#[derive(Default)]
pub struct IndexQueue {
    state: Mutex<QueueState>,
    wake: Condvar,
}

impl IndexQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// The state holds no invariant a panic could break halfway, so a
    /// poisoned lock is used as it is.
    fn lock(&self) -> MutexGuard<'_, QueueState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Queues the ids that aren't already waiting or being indexed, and
    /// returns how many it added. Ends a pause, since it's only called when
    /// indexing is asked for. A current book whose run was cancelled can be
    /// queued again: its run is ending.
    pub fn push(&self, ids: &[i64]) -> usize {
        let mut state = self.lock();
        state.paused = false;
        let mut added = 0;
        for &id in ids {
            let running = state.current == Some(id) && !state.cancel.load(Ordering::SeqCst);
            if !running && !state.waiting.contains(&id) {
                state.waiting.push_back(id);
                added += 1;
            }
        }
        if added > 0 {
            self.wake.notify_all();
        }
        added
    }

    /// Queues a newly imported book, unless indexing is paused. Returns
    /// whether it was queued.
    pub fn push_import(&self, book_id: i64) -> bool {
        if self.lock().paused {
            return false;
        }
        self.push(&[book_id]) > 0
    }

    /// Waits for a book, makes it the current one and returns it with the
    /// flag that asks its run to end.
    pub fn next(&self) -> (i64, Arc<AtomicBool>) {
        let mut state = self.lock();
        loop {
            if let Some(id) = state.waiting.pop_front() {
                state.current = Some(id);
                state.cancel = Arc::new(AtomicBool::new(false));
                return (id, Arc::clone(&state.cancel));
            }
            state = self.wake.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Ends `book_id`'s run, and returns whether it was cancelled.
    pub fn finish(&self, book_id: i64) -> bool {
        let mut state = self.lock();
        if state.current == Some(book_id) {
            state.current = None;
        }
        state.cancel.load(Ordering::SeqCst)
    }

    /// Empties the queue, asks the current run to end, and pauses the
    /// indexing of new imports. Without the pause, a folder import still
    /// running would queue each book it imports next.
    pub fn stop(&self) {
        let mut state = self.lock();
        state.waiting.clear();
        if state.current.is_some() {
            state.cancel.store(true, Ordering::SeqCst);
        }
        state.paused = true;
    }

    /// Drops a book that's being removed from the library: out of the
    /// queue, and its run cancelled if it's the current one.
    pub fn forget(&self, book_id: i64) {
        let mut state = self.lock();
        state.waiting.retain(|&id| id != book_id);
        if state.current == Some(book_id) {
            state.cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Books waiting behind the current one.
    pub fn waiting_count(&self) -> usize {
        self.lock().waiting.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn push_skips_books_already_waiting_or_current() {
        let queue = IndexQueue::new();
        assert_eq!(queue.push(&[1, 2]), 2);
        assert_eq!(queue.next().0, 1);
        assert_eq!(queue.push(&[1, 2, 3, 3]), 1);
        assert_eq!(queue.waiting_count(), 2);
    }

    #[test]
    fn next_hands_books_out_in_push_order() {
        let queue = IndexQueue::new();
        queue.push(&[3, 1]);
        queue.push(&[2]);
        let order: Vec<i64> = (0..3)
            .map(|_| {
                let (id, _) = queue.next();
                assert!(!queue.finish(id));
                id
            })
            .collect();
        assert_eq!(order, vec![3, 1, 2]);
    }

    #[test]
    fn stop_empties_the_queue_and_cancels_the_current_run() {
        let queue = IndexQueue::new();
        queue.push(&[1, 2, 3]);
        let (id, cancel) = queue.next();
        queue.stop();
        assert!(cancel.load(Ordering::SeqCst));
        assert_eq!(queue.waiting_count(), 0);
        assert!(queue.finish(id));
        // A cancelled book can be queued again while its run ends.
        queue.push(&[id]);
        let (again, cancel) = queue.next();
        assert_eq!(again, id);
        assert!(!cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn forget_drops_a_waiting_book_and_cancels_the_current_one() {
        let queue = IndexQueue::new();
        queue.push(&[1, 2, 3]);
        let (current, cancel) = queue.next();
        queue.forget(2);
        assert_eq!(queue.waiting_count(), 1);
        assert!(!cancel.load(Ordering::SeqCst));
        queue.forget(current);
        assert!(cancel.load(Ordering::SeqCst));
        assert!(queue.finish(current));
        assert_eq!(queue.next().0, 3);
    }

    #[test]
    fn stop_pauses_imports_until_indexing_is_asked_for() {
        let queue = IndexQueue::new();
        assert!(queue.push_import(1));
        queue.stop();
        assert!(!queue.push_import(2));
        assert_eq!(queue.waiting_count(), 0);

        assert_eq!(queue.push(&[3]), 1);
        assert!(queue.push_import(4));
        assert_eq!(queue.next().0, 3);
        assert_eq!(queue.next().0, 4);
    }

    #[test]
    fn next_waits_for_a_push_from_another_thread() {
        let queue = Arc::new(IndexQueue::new());
        let (tx, rx) = mpsc::channel();
        let worker = {
            let queue = Arc::clone(&queue);
            std::thread::spawn(move || tx.send(queue.next().0).unwrap())
        };
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        queue.push(&[7]);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok(7));
        worker.join().unwrap();
    }
}
