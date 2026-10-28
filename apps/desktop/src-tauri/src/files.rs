// The file handling behind the shell's commands, kept free of Tauri so its
// tests run with `cargo test`, or without the webview libraries at all with
// `rustc --edition 2021 --test src/files.rs`.

use std::ffi::OsString;

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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(decode_text(b"// \xAA\xAC\xBA\x41\nmodule"), "// \u{FFFD}\u{FFFD}\u{FFFD}A\nmodule");
        // Only a leading BOM is dropped.
        assert_eq!(decode_text("a\u{FEFF}".as_bytes()), "a\u{FEFF}");
    }
}
