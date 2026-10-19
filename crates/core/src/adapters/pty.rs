//! PTY par `portable-pty`.
//!
//! `portable-pty` lance l'enfant avec `setsid` et le PTY comme terminal de
//! contrôle : l'enfant est chef de son groupe de processus, ce qui permet au
//! démon de signaler tout le groupe (`kill(-pid, SIGHUP)`).

use std::io;
use std::sync::Mutex;

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::ports::{
    CommandLine, ExitStatus, PtyChild, PtyControl, PtySpawner, SpawnedPty, TermSize,
};

/// [`PtySpawner`] sur le PTY natif.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativePty;

fn pty_size(size: TermSize) -> PtySize {
    PtySize {
        rows: size.rows.max(1),
        cols: size.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn other(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

struct Control(Mutex<Box<dyn MasterPty + Send>>);

impl PtyControl for Control {
    fn resize(&self, size: TermSize) -> io::Result<()> {
        let master = self.0.lock().map_err(other)?;
        master.resize(pty_size(size)).map_err(other)
    }
}

struct Child(Box<dyn portable_pty::Child + Send + Sync>);

impl PtyChild for Child {
    fn pid(&self) -> Option<u32> {
        self.0.process_id()
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.0.wait()?;
        Ok(match status.signal() {
            Some(sig) => ExitStatus::Signal(sig.to_owned()),
            None => ExitStatus::Code(status.exit_code() as i32),
        })
    }
}

impl PtySpawner for NativePty {
    fn spawn(&self, command: &CommandLine, size: TermSize) -> io::Result<SpawnedPty> {
        let pair = native_pty_system().openpty(pty_size(size)).map_err(other)?;
        let mut cmd = CommandBuilder::new(&command.program);
        cmd.args(&command.args);
        cmd.cwd(&command.cwd);
        for key in &command.env_remove {
            cmd.env_remove(key);
        }
        for (key, value) in &command.env {
            cmd.env(key, value);
        }
        let child = pair.slave.spawn_command(cmd).map_err(other)?;
        // Sans ce drop, le maître ne verrait jamais la fin de flux à la sortie de l'enfant.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(other)?;
        let writer = pair.master.take_writer().map_err(other)?;
        Ok(SpawnedPty {
            reader,
            writer,
            control: Box::new(Control(Mutex::new(pair.master))),
            child: Box::new(Child(child)),
        })
    }
}
