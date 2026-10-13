//! Just enough of bun_core for the markdown parser (semantics guessed from Bun's Zig/Rust sources).
pub struct StackCheck;
impl StackCheck {
    pub fn init() -> StackCheck { StackCheck }
    pub fn is_safe_to_recurse(&self) -> bool { true }
}

#[macro_export]
macro_rules! oom_from_alloc {
    ($t:ty) => {
        impl From<bun_alloc::AllocError> for $t {
            fn from(_: bun_alloc::AllocError) -> Self { <$t>::OutOfMemory }
        }
    };
}

pub mod fmt {
    pub struct ItoaBuf(Vec<u8>);
    impl ItoaBuf { pub fn new() -> ItoaBuf { ItoaBuf(Vec::new()) } }
    pub fn itoa(buf: &mut ItoaBuf, v: u32) -> &[u8] {
        buf.0 = v.to_string().into_bytes();
        &buf.0
    }
    pub fn hex_digit_value(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    pub fn hex_byte_upper(b: u8) -> [u8; 2] {
        const H: &[u8; 16] = b"0123456789ABCDEF";
        [H[(b >> 4) as usize], H[(b & 15) as usize]]
    }
}

pub mod strings {
    pub fn index_of_char_usize(s: &[u8], c: u8) -> Option<usize> { s.iter().position(|&b| b == c) }
    pub fn index_of_char_pos(s: &[u8], c: u8, pos: usize) -> Option<usize> {
        if pos >= s.len() { return None; }
        s[pos..].iter().position(|&b| b == c).map(|i| i + pos)
    }
    pub fn index_of_any(s: &[u8], set: &[u8]) -> Option<usize> { s.iter().position(|b| set.contains(b)) }
    pub fn contains_char(s: &[u8], c: u8) -> bool { s.contains(&c) }
    pub fn index_of(h: &[u8], n: &[u8]) -> Option<usize> {
        if n.is_empty() { return Some(0); }
        h.windows(n.len()).position(|w| w == n)
    }
    pub fn eql_case_insensitive_ascii_check_length(a: &[u8], b: &[u8]) -> bool {
        a.len() == b.len() && a.eq_ignore_ascii_case(b)
    }
    pub fn eql_case_insensitive_ascii_ignore_length(a: &[u8], b: &[u8]) -> bool {
        a.len() == b.len() && a.eq_ignore_ascii_case(b)
    }
    pub fn utf8_byte_sequence_length(b0: u8) -> u8 {
        if b0 < 0x80 { 1 } else if b0 & 0xE0 == 0xC0 { 2 } else if b0 & 0xF0 == 0xE0 { 3 } else if b0 & 0xF8 == 0xF0 { 4 } else { 0 }
    }
    pub fn decode_wtf8_rune_t<T: From<u32> + Into<u32>>(p: [u8; 4], len: u8, zero: T) -> T where T: Copy {
        let z: u32 = zero.into();
        let r: u32 = (|| {
            if len == 0 { return z; }
            if len == 1 { return p[0] as u32; }
            let s1 = p[1];
            if s1 & 0xC0 != 0x80 { return z; }
            if len == 2 {
                let cp = ((p[0] & 0x1F) as u32) << 6 | (s1 & 0x3F) as u32;
                return if cp < 0x80 { z } else { cp };
            }
            let s2 = p[2];
            if s2 & 0xC0 != 0x80 { return z; }
            if len == 3 {
                let cp = ((p[0] & 0x0F) as u32) << 12 | ((s1 & 0x3F) as u32) << 6 | (s2 & 0x3F) as u32;
                return if cp < 0x800 { z } else { cp };
            }
            let s3 = p[3];
            if s3 & 0xC0 != 0x80 { return z; }
            let cp = ((p[0] & 0x07) as u32) << 18 | ((s1 & 0x3F) as u32) << 12 | ((s2 & 0x3F) as u32) << 6 | (s3 & 0x3F) as u32;
            if cp < 0x10000 || cp > 0x10FFFF { z } else { cp }
        })();
        T::from(r)
    }
    pub fn encode_wtf8_rune(buf: &mut [u8; 4], cp: u32) -> usize {
        if cp < 0x80 { buf[0] = cp as u8; 1 }
        else if cp < 0x800 { buf[0] = 0xC0 | (cp >> 6) as u8; buf[1] = 0x80 | (cp & 0x3F) as u8; 2 }
        else if cp < 0x10000 { buf[0] = 0xE0 | (cp >> 12) as u8; buf[1] = 0x80 | ((cp >> 6) & 0x3F) as u8; buf[2] = 0x80 | (cp & 0x3F) as u8; 3 }
        else { buf[0] = 0xF0 | (cp >> 18) as u8; buf[1] = 0x80 | ((cp >> 12) & 0x3F) as u8; buf[2] = 0x80 | ((cp >> 6) & 0x3F) as u8; buf[3] = 0x80 | (cp & 0x3F) as u8; 4 }
    }
    pub fn is_unicode_space_separator(cp: u32) -> bool {
        matches!(cp, 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x202F | 0x205F | 0x3000)
    }
    pub fn html_escape_entity(b: u8) -> Option<&'static [u8]> {
        match b {
            b'&' => Some(b"&amp;"),
            b'<' => Some(b"&lt;"),
            b'>' => Some(b"&gt;"),
            b'"' => Some(b"&quot;"),
            b'\'' => Some(b"&#x27;"),
            _ => None,
        }
    }
}
