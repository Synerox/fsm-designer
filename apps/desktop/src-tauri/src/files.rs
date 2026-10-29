// The file handling behind the shell's commands, kept free of Tauri so its
// tests run with `cargo test`, or without the webview libraries at all with
// `rustc --edition 2021 --test src/files.rs`.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// The first command-line argument that is not a flag. Argv is taken as
/// OsString because std::env::args() panics on an argument that is not valid
/// Unicode; such a path comes back lossy and then fails to open with a message.
pub fn launch_arg(args: impl IntoIterator<Item = OsString>) -> Option<String> {
    args.into_iter()
        .map(|a| a.to_string_lossy().into_owned())
        .find(|a| !a.starts_with('-'))
}

/// Decode a file the way the browser's File.text() does, so the desktop app
/// opens what the web build opens: a leading UTF-8 BOM is dropped (JSON.parse
/// rejects it) and bytes that are not UTF-8, such as a Big5 or Shift-JIS
/// comment in a Verilog source, become U+FFFD instead of refusing the file.
pub fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Undo the encodeURIComponent the editor puts on a path it sends in a header
/// (header values must be ASCII). Anything malformed is kept as it was.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (b[i], hex) {
            (b'%', Some(v)) => {
                out.push(v);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Save `contents` to `path` so that a failed or interrupted write (disk full,
/// a network share dropping, a crash) leaves the old file as it was: write a
/// temporary file beside it, flush it to disk, then rename it over the old one,
/// which replaces it in one step (std's rename replaces an existing file on
/// Windows too). fs::write would truncate the old file first.
pub fn write_replacing(path: &Path, contents: &[u8]) -> io::Result<()> {
    // Through a symlink, replace the file it points at, not the link.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let old = fs::metadata(&target).ok();
    // A read-only file stays refused, as a plain write refuses it (a rename would not).
    if old.as_ref().is_some_and(|m| m.permissions().readonly()) {
        return fs::write(&target, contents);
    }
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return fs::write(&target, contents);
    };
    let mut tmp_name = OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".{}.tmp", std::process::id()));
    let tmp = dir.join(tmp_name);
    // A folder where only the file itself is writable gets the old in-place write.
    let Ok(mut f) = fs::File::create(&tmp) else {
        return fs::write(&target, contents);
    };
    let written = (|| {
        f.write_all(contents)?;
        // Keep the old file's permissions (a 0600 file must not become world-readable).
        if let Some(m) = &old {
            f.set_permissions(m.permissions())?;
        }
        f.sync_all()
    })();
    drop(f);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if fs::rename(&tmp, &target).is_err() {
        // Windows refuses to replace a file another program holds open without
        // delete sharing; writing into it in place still works there.
        let _ = fs::remove_file(&tmp);
        return fs::write(&target, contents);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("fsm-files-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn launch_arg_skips_flags_and_survives_non_unicode() {
        let args = ["--flag", "a.fsm.json", "b"].map(OsString::from);
        assert_eq!(launch_arg(args).as_deref(), Some("a.fsm.json"));
        assert_eq!(launch_arg([OsString::from("-x")]), None);
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let bad = OsString::from_vec(b"caf\xE9.fsm.json".to_vec());
            assert_eq!(launch_arg([bad]).as_deref(), Some("caf\u{FFFD}.fsm.json"));
        }
    }

    #[test]
    fn decode_text_drops_bom_and_replaces_invalid_bytes() {
        assert_eq!(decode_text(b"\xEF\xBB\xBF{\"a\":1}"), "{\"a\":1}");
        // "// " then Big5 for a CJK word: opens with replacement characters, as in the browser.
        assert_eq!(
            decode_text(b"// \xAA\xAC\xBA\x41\nmodule"),
            "// \u{FFFD}\u{FFFD}\u{FFFD}A\nmodule"
        );
        // Only a leading BOM is dropped.
        assert_eq!(decode_text("a\u{FEFF}".as_bytes()), "a\u{FEFF}");
    }

    #[test]
    fn percent_decode_round_trips_encode_uri_component() {
        // encodeURIComponent("C:\\Users\\王\\a b%.fsm.json")
        assert_eq!(
            percent_decode("C%3A%5CUsers%5C%E7%8E%8B%5Ca%20b%25.fsm.json"),
            "C:\\Users\\王\\a b%.fsm.json"
        );
        assert_eq!(percent_decode("/x/100%"), "/x/100%");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
    }

    #[test]
    fn write_replacing_creates_and_replaces_without_leftovers() {
        let dir = scratch("replace");
        let p = dir.join("a.fsm.json");
        write_replacing(&p, b"one").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"one");
        write_replacing(&p, b"two, longer").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"two, longer");
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            [OsString::from("a.fsm.json")],
            "no temporary file is left behind"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn write_replacing_never_truncates_the_old_file() {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = scratch("atomic");
        let p = dir.join("a.fsm.json");
        fs::write(&p, b"old contents").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
        let before = fs::metadata(&p).unwrap().ino();
        let mut held = fs::File::open(&p).unwrap();
        write_replacing(&p, b"new").unwrap();
        // The old file was replaced by another one, not emptied and rewritten:
        // a reader that had it open still sees all of it.
        let mut s = String::new();
        held.read_to_string(&mut s).unwrap();
        assert_eq!(s, "old contents");
        let after = fs::metadata(&p).unwrap();
        assert_ne!(after.ino(), before);
        assert_eq!(
            after.permissions().mode() & 0o777,
            0o600,
            "permissions are kept"
        );
        assert_eq!(fs::read(&p).unwrap(), b"new");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn write_replacing_keeps_symlinks_and_read_only_files() {
        let dir = scratch("links");
        let real = dir.join("real.fsm.json");
        let link = dir.join("link.fsm.json");
        fs::write(&real, b"old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_replacing(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"new");

        let ro = dir.join("ro.fsm.json");
        fs::write(&ro, b"keep").unwrap();
        let mut perm = fs::metadata(&ro).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&ro, perm).unwrap();
        // Root may write anyway; everyone else is refused, as by fs::write.
        if write_replacing(&ro, b"x").is_err() {
            assert_eq!(fs::read(&ro).unwrap(), b"keep");
        }
        let mut perm = fs::metadata(&ro).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(&ro, perm).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }
}
