#!/bin/sh
# Builds the oracle: Bun's md parser (vendor/bun/src/md, ansi renderer left out) + shims for bun_core & co.
# Usage: tools/md/rust-oracle/build.sh   -> tools/md/rust-oracle/target/release/mdoracle
set -e
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../../../vendor/bun/src/md"
dst="$here/build/bun_md"
rm -rf "$dst"; mkdir -p "$dst"
for f in "$src"/*.rs; do
  case "$f" in */ansi_renderer.rs) continue;; esac
  cp "$f" "$dst/"
done
cat > "$dst/Cargo.toml" <<'T'
[package]
name = "bun_md"
version = "0.0.0"
edition = "2024"
[lib]
path = "lib.rs"
[dependencies]
bun_alloc = { path = "../../shims/bun_alloc" }
bun_core = { path = "../../shims/bun_core" }
bun_collections = { path = "../../shims/bun_collections" }
T
# patches
sed -i.bak '/pub mod ansi_renderer;/d' "$dst/lib.rs"
sed -i.bak -e '/ansi_renderer as ansi/d' -e '/^pub use ansi::/d' "$dst/root.rs"
sed -i.bak -e 's/, strum::IntoStaticStr)\]/)]/' -e 's/f.write_str(<&.static str>::from(\*self))/write!(f, "{:?}", self)/' "$dst/parser.rs"
cat >> "$dst/lib.rs" <<'T'

/// Entry points of the oracle for what is crate-private (tools/md/diff-tables.ts).
pub mod __oracle {
    pub fn case_fold(cp: u32) -> ([u32; 3], u8) {
        let f = crate::unicode::case_fold(cp);
        (f.codepoints, f.n_codepoints)
    }
    pub fn punct(cp: u32) -> bool { crate::helpers::is_unicode_punctuation(cp) }
    pub fn whitespace(cp: u32) -> bool { crate::helpers::is_unicode_whitespace(cp) }
    pub fn decode_entity(s: &[u8]) -> Option<Vec<u8>> {
        let mut b = [0u8; 8];
        crate::helpers::decode_entity_to_utf8(s, &mut b).map(|x| x.to_vec())
    }
    pub fn find_entity(content: &[u8], start: usize) -> Option<usize> { crate::helpers::find_entity(content, start) }
    pub fn decode_utf8(text: &[u8], off: usize) -> (u32, u8) { let r = crate::helpers::decode_utf8(text, off); (r.codepoint, r.len) }
    pub fn decode_utf8_backward(text: &[u8], off: usize) -> (u32, u8) { let r = crate::helpers::decode_utf8_backward(text, off); (r.codepoint, r.len) }
    pub fn alnum(cp: u32) -> bool { char::from_u32(cp).is_some_and(char::is_alphanumeric) }
}
T
rm -f "$dst"/*.bak
cd "$here" && cargo build --release 2>&1 | tail -30
