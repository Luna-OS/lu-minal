//! lu-minal in a ConPTY. Four threads: the reader takes the output as it comes, the batcher
//! takes the OSC 7701 commands out and hands the rest to the window in batches (about every
//! 8 ms) while xterm.js keeps up (flow control: past a high-water mark it waits for xterm.js to
//! acknowledge what it parsed, so a flood of output slows lu-minal down instead of the window),
//! the writer types into the console, and the waiter notices the exit and closes the console
//! once the last output is through.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tao::event_loop::EventLoopProxy;

use super::UserEvent;
use crate::osc::{OscFilter, PaneCommand};

/// How long output is gathered before it goes to the page.
const BATCH: Duration = Duration::from_millis(8);
/// A batch never grows past this.
const MAX_BATCH: usize = 512 * 1024;
/// Bytes on their way to xterm.js (sent, not yet acknowledged) before the batcher waits.
const HIGH_WATER: usize = 2 * 1024 * 1024;
/// How long the page may stay silent before the batcher stops waiting for it.
const ACK_TIMEOUT: Duration = Duration::from_secs(5);
/// A partial `ESC ] 7701` at the end of the output is given back after this much silence.
const HOLD: Duration = Duration::from_millis(50);
/// After the exit: how long the output must have been quiet before the console is closed, at most.
const QUIET: Duration = Duration::from_millis(300);
const QUIET_MAX: Duration = Duration::from_secs(2);
/// After the exit: how long to wait for the end of the output before reporting the exit anyway.
const EOF_GRACE: Duration = Duration::from_secs(3);

/// What the session tells the window.
#[derive(Debug)]
pub enum PtyEvent {
    Output(Vec<u8>),
    Command(PaneCommand),
    /// lu-minal ended (its exit code, when known); all of its output has been sent before this.
    Exited(Option<u32>),
}

/// What to run.
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub set_env: Vec<(String, String)>,
    pub remove_env: Vec<&'static str>,
}

enum Msg {
    Data(Vec<u8>),
    Eof,
    Exit(Option<u32>),
}

/// Bytes sent to the page and not yet acknowledged.
struct Flow {
    state: Mutex<(usize, Instant)>,
    cv: Condvar,
}

impl Flow {
    fn new() -> Self {
        Self { state: Mutex::new((0, Instant::now())), cv: Condvar::new() }
    }

    /// Waits until there is room for more (or the page has stopped answering).
    fn wait_for_room(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.0 > HIGH_WATER {
            if state.1.elapsed() > ACK_TIMEOUT {
                state.0 = 0;
                break;
            }
            state = self.cv.wait_timeout(state, Duration::from_millis(250)).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    fn sent(&self, bytes: usize) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.0 == 0 {
            state.1 = Instant::now();
        }
        state.0 += bytes;
    }

    fn acknowledged(&self, bytes: usize) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.0 = state.0.saturating_sub(bytes);
        state.1 = Instant::now();
        self.cv.notify_all();
    }
}

pub struct Session {
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    flow: Arc<Flow>,
}

fn now_ms(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

impl Session {
    /// Starts the program in a new console of this size.
    pub fn start(launch: &Launch, cols: u16, rows: u16, proxy: EventLoopProxy<UserEvent>) -> Result<Session, String> {
        let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(|e| format!("Could not create a console: {e}"))?;

        let mut cmd = CommandBuilder::new(&launch.program);
        cmd.args(&launch.args);
        cmd.cwd(&launch.cwd);
        for key in &launch.remove_env {
            cmd.env_remove(key);
        }
        for (key, value) in &launch.set_env {
            cmd.env(key, value);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Could not start {}: {e}", launch.program.display()))?;
        // The console stays open through the master alone.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        let master = Arc::new(Mutex::new(Some(pair.master)));
        let flow = Arc::new(Flow::new());
        let started = Instant::now();
        let last_output = Arc::new(AtomicU64::new(0));

        let (tx, rx) = mpsc::sync_channel::<Msg>(64);

        // Reader: blocks on the pipe; a full channel (the batcher waiting for the page) holds it,
        // and with it lu-minal.
        {
            let tx = tx.clone();
            let last_output = last_output.clone();
            thread::Builder::new()
                .name("pty-reader".into())
                .spawn(move || {
                    let mut buf = vec![0u8; 64 * 1024];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                last_output.store(now_ms(started), Ordering::Relaxed);
                                if tx.send(Msg::Data(buf[..n].to_vec())).is_err() {
                                    return;
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                            Err(_) => break,
                        }
                    }
                    let _ = tx.send(Msg::Eof);
                })
                .map_err(|e| e.to_string())?;
        }

        // Waiter: the exit code, then (once the output has gone quiet) the console closes, which
        // ends the reader's pipe.
        {
            let tx = tx.clone();
            let master = master.clone();
            thread::Builder::new()
                .name("pty-waiter".into())
                .spawn(move || {
                    let code = child.wait().ok().map(|status| status.exit_code());
                    let exited = Instant::now();
                    loop {
                        let quiet_for = now_ms(started).saturating_sub(last_output.load(Ordering::Relaxed));
                        if Duration::from_millis(quiet_for) >= QUIET || exited.elapsed() >= QUIET_MAX {
                            break;
                        }
                        thread::sleep(Duration::from_millis(30));
                    }
                    let console = master.lock().unwrap_or_else(|e| e.into_inner()).take();
                    drop(console);
                    let _ = tx.send(Msg::Exit(code));
                })
                .map_err(|e| e.to_string())?;
        }
        drop(tx);

        // Batcher.
        {
            let flow = flow.clone();
            thread::Builder::new().name("pty-batcher".into()).spawn(move || batch(rx, proxy, flow)).map_err(|e| e.to_string())?;
        }

        // Writer: typing never blocks the window.
        let (input, keys) = mpsc::channel::<Vec<u8>>();
        thread::Builder::new()
            .name("pty-writer".into())
            .spawn(move || {
                for bytes in keys {
                    if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Session { master, input, killer, flow })
    }

    pub fn write(&self, bytes: Vec<u8>) {
        if !bytes.is_empty() {
            let _ = self.input.send(bytes);
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(master) = self.master.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 });
        }
    }

    /// xterm.js has parsed this much.
    pub fn acknowledged(&self, bytes: usize) {
        self.flow.acknowledged(bytes);
    }

    /// Closes the console: lu-minal gets the console's close event (Node and Bun turn it into
    /// SIGHUP, on which lu-minal saves its session and exits). Closing can block, so it happens
    /// on a thread of its own.
    pub fn hang_up(&self) {
        let console = self.master.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(console) = console {
            let _ = thread::Builder::new().name("pty-close".into()).spawn(move || drop(console));
        }
    }

    /// Ends lu-minal at once.
    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

/// The batcher thread: OSC filter, batches, flow control, and the exit after the last output.
fn batch(rx: Receiver<Msg>, proxy: EventLoopProxy<UserEvent>, flow: Arc<Flow>) {
    let mut filter = OscFilter::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut commands: Vec<PaneCommand> = Vec::new();
    let mut since: Option<Instant> = None;
    let mut eof = false;
    let mut exit: Option<(Option<u32>, Instant)> = None;

    let send = |pending: &mut Vec<u8>, since: &mut Option<Instant>| {
        *since = None;
        if pending.is_empty() {
            return;
        }
        flow.wait_for_room();
        flow.sent(pending.len());
        let _ = proxy.send_event(UserEvent::Pty(PtyEvent::Output(std::mem::take(pending))));
    };

    loop {
        let timeout = if let Some(t) = since {
            BATCH.saturating_sub(t.elapsed())
        } else if filter.holding() {
            HOLD
        } else if let Some((_, at)) = exit {
            EOF_GRACE.saturating_sub(at.elapsed())
        } else {
            Duration::from_secs(3600)
        };
        match rx.recv_timeout(timeout) {
            Ok(Msg::Data(bytes)) => {
                filter.feed(&bytes, &mut pending, &mut commands);
                if !commands.is_empty() {
                    // In order: the output before a command goes first.
                    send(&mut pending, &mut since);
                    for command in commands.drain(..) {
                        let _ = proxy.send_event(UserEvent::Pty(PtyEvent::Command(command)));
                    }
                }
                if pending.len() >= MAX_BATCH {
                    send(&mut pending, &mut since);
                } else if !pending.is_empty() && since.is_none() {
                    since = Some(Instant::now());
                }
            }
            Ok(Msg::Eof) => {
                eof = true;
                filter.flush(&mut pending);
                send(&mut pending, &mut since);
            }
            Ok(Msg::Exit(code)) => exit = Some((code, Instant::now())),
            Err(RecvTimeoutError::Timeout) => {
                if since.is_none() && filter.holding() {
                    filter.flush(&mut pending);
                }
                send(&mut pending, &mut since);
                if let Some((_, at)) = exit {
                    if at.elapsed() >= EOF_GRACE {
                        eof = true;
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                filter.flush(&mut pending);
                send(&mut pending, &mut since);
                eof = true;
                if exit.is_none() {
                    exit = Some((None, Instant::now()));
                }
            }
        }
        if let (true, Some((code, _))) = (eof, exit) {
            let _ = proxy.send_event(UserEvent::Pty(PtyEvent::Exited(code)));
            return;
        }
    }
}
