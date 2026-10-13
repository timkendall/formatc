//! Event-stream dumper for Bun's md parser, the oracle of the TS port (tools/md/events.ts prints the same lines).
//!
//! mdoracle [--html] [--track] [--hooks] [--read-leaves] [+opt|-opt]... FILE
//!   +tables, +footnotes, +micromark, +mdx, ... : bool options (snake_case names of `Options`)
use bun_md::root::{Options, render_to_html_with_options, render_with_extensions, render_with_renderer};
use bun_md::types::*;
use std::fmt::Write as _;

fn esc(b: &[u8]) -> String {
    let mut s = String::from("\"");
    for &c in b {
        match c {
            b'\\' => s.push_str("\\\\"),
            b'"' => s.push_str("\\\""),
            b'\n' => s.push_str("\\n"),
            0x20..=0x7e => s.push(c as char),
            _ => { let _ = write!(s, "\\x{:02x}", c); }
        }
    }
    s.push('"');
    s
}

struct Dump { out: String, track: bool, read_leaves: bool }

impl RendererImpl for Dump {
    fn enter_block(&mut self, t: BlockType, data: u32, flags: u32) -> JsResult<()> {
        let _ = writeln!(self.out, "EB {} {} {}", t as u8, data, flags); Ok(())
    }
    fn leave_block(&mut self, t: BlockType, data: u32) -> JsResult<()> {
        let _ = writeln!(self.out, "LB {} {}", t as u8, data); Ok(())
    }
    fn enter_span(&mut self, t: SpanType, d: SpanDetail<'_>) -> JsResult<()> {
        let r = match d.reference { Reference::None => 0, Reference::Full => 1, Reference::Collapsed => 2, Reference::Shortcut => 3, Reference::Footnote => 4 };
        let _ = writeln!(self.out, "ES {} href={} title={} ac={} ae={} pa={} aw={} ref={}", t as u8, esc(d.href), esc(d.title),
            d.autolink as u8, d.autolink_email as u8, d.permissive_autolink as u8, d.autolink_www as u8, r);
        Ok(())
    }
    fn leave_span(&mut self, t: SpanType) -> JsResult<()> {
        let _ = writeln!(self.out, "LS {}", t as u8); Ok(())
    }
    fn text(&mut self, t: TextType, c: &[u8]) -> JsResult<()> {
        let _ = writeln!(self.out, "TX {} {}", t as u8, esc(c)); Ok(())
    }
    fn wants_source(&self) -> bool { self.track }
    fn line_starts(&mut self, s: &[OFF]) {
        let v: Vec<String> = s.iter().map(|x| x.to_string()).collect();
        let _ = writeln!(self.out, "LN {} {}", s.len(), v.join(","));
    }
    fn container_source(&mut self, beg: OFF, end: OFF, indent: u32) {
        let _ = writeln!(self.out, "CS {} {} {}", beg, end, indent);
    }
    fn leaf_source(&mut self, t: BlockType, lines: &[VerbatimLine]) -> bool {
        let v: Vec<String> = lines.iter().map(|l| format!("{}:{}:{}", l.beg, l.end, l.indent)).collect();
        let reads = self.read_leaves && matches!(t, BlockType::Code | BlockType::Html | BlockType::Hr);
        let _ = writeln!(self.out, "LF {} {} [{}]", t as u8, reads as u8, v.join(","));
        reads
    }
    fn inline_source(&mut self, beg: OFF, end: OFF) {
        let _ = writeln!(self.out, "IS {} {}", beg, end);
    }
    fn extension_span(&mut self, tag: u32, c: &[u8]) -> JsResult<()> {
        let _ = writeln!(self.out, "XS {} {}", tag, esc(c)); Ok(())
    }
    fn definition(&mut self, d: &Definition<'_>) {
        let v: Vec<String> = d.lines.iter().map(|l| format!("{}:{}:{}", l.beg, l.end, l.indent)).collect();
        let _ = writeln!(self.out, "DF {} {} label={} dest={} title={} lines=[{}]", d.beg, d.end, esc(d.label), esc(d.dest), esc(d.title), v.join(","));
    }
}

fn line_end_in(text: &[u8], off: usize) -> usize {
    off + text[off..].iter().position(|&b| b == b'\n').unwrap_or(text.len() - off)
}
fn find(h: &[u8], n: &[u8]) -> Option<usize> { h.windows(n.len()).position(|w| w == n) }

// Hooks used by the tests; the TS side (tools/md/events.ts) has the same ones.
fn leaf_hook(start: &LeafStart<'_>, mdx: bool) -> Option<OFF> {
    let (text, off) = (start.text, start.off as usize);
    if mdx {
        if start.is_in_container || start.indent > 0 || start.interrupts_paragraph { return None; }
        let rest = &text[off..];
        if !(rest.starts_with(b"import") || rest.starts_with(b"export")) || !rest.get(6).is_some_and(u8::is_ascii_whitespace) { return None; }
        let len = find(rest, b"\n\n").unwrap_or(rest.len());
        return Some(start.off + len as OFF);
    }
    let (closing, _kind): (&[u8], usize) = match text.get(off + 1)? { b'{' => (b"}}", 0), b'%' => (b"%}", 1), _ => return None };
    let mut line_end = line_end_in(text, off);
    let from = off + 2;
    let at = if start.is_in_container {
        from + find(text.get(from..line_end)?, closing)?
    } else {
        from + find(text.get(from..)?, closing)?
    };
    let end = at + 2;
    if !text[end..line_end_in(text, end)].iter().all(|&b| b == b' ' || b == b'\t') { return None; }
    while line_end < end {
        if (start.starts_container)(line_end as OFF + 1) { return None; }
        line_end = line_end_in(text, line_end + 1);
    }
    Some(end as OFF)
}

fn is_atext(b: u8) -> bool { b.is_ascii_alphanumeric() || b".-_+".contains(&b) }

fn span_hook(s: &SpanStart<'_>) -> Option<ExtensionSpan> {
    let (bytes, index) = (s.content, s.pos);
    match bytes[index] {
        b'$' => {
            if index > 0 && bytes[index - 1] == b'$' { return None; }
            let rest = &bytes[index + 1..];
            let at = rest.iter().position(|&b| b == b'$')?;
            if at == 0 { return None; }
            Some(ExtensionSpan { beg: index, end: index + 2 + at, tag: 2 })
        }
        b'{' => {
            if bytes.get(index + 1) != Some(&b'{') { return None; }
            let at = find(&bytes[index + 2..], b"}}")?;
            Some(ExtensionSpan { beg: index, end: index + 2 + at + 2, tag: 0 })
        }
        b'[' => {
            if bytes.get(index + 1) != Some(&b'[') { return None; }
            let at = find(&bytes[index + 2..], b"]]")?;
            Some(ExtensionSpan { beg: index, end: index + 2 + at + 2, tag: 3 })
        }
        _ if s.is_after_open_bracket => None,
        b'@' => {
            let mut beg = index;
            while beg > s.from && is_atext(bytes[beg - 1]) { beg -= 1; }
            if beg == index { return None; }
            let mut end = index + 1;
            while end < bytes.len() && is_atext(bytes[end]) { end += 1; }
            if end == index + 1 { return None; }
            Some(ExtensionSpan { beg, end, tag: 4 })
        }
        b':' => {
            if !bytes[index + 1..].starts_with(b"//") { return None; }
            let before = &bytes[s.from.min(index)..index];
            let n = before.iter().rev().take_while(|b| b.is_ascii_alphabetic()).count();
            if n == 0 { return None; }
            let mut end = index + 3;
            while end < bytes.len() && !bytes[end].is_ascii_whitespace() { end += 1; }
            Some(ExtensionSpan { beg: index - n, end, tag: 5 })
        }
        _ => None,
    }
}

fn table(kind: &str, input: &[u8]) {
    use bun_md::__oracle as o;
    use std::io::Write;
    let mut out = String::new();
    match kind {
        "fold" => for cp in 0..=0x10FFFFu32 {
            let (c, n) = o::case_fold(cp);
            let _ = writeln!(out, "{cp:x} {n} {:x} {:x} {:x}", c[0], c[1], c[2]);
        },
        "punct" => for cp in 0..=0x10FFFFu32 {
            let _ = writeln!(out, "{cp:x} {} {} {}", o::punct(cp) as u8, o::whitespace(cp) as u8, o::alnum(cp) as u8);
        },
        // one line of input = one entity text; prints the decoded bytes in hex, or `-`
        "entity" => for line in input.split(|&b| b == b'\n') {
            match o::decode_entity(line) {
                Some(v) => { let _ = writeln!(out, "{}", v.iter().map(|b| format!("{b:02x}")).collect::<String>()); }
                None => out.push_str("-\n"),
            }
            let _ = match o::find_entity(line, 0) { Some(e) => writeln!(out, "{e}"), None => writeln!(out, "-") };
        },
        // [u32 len][bytes]...: for each record and each offset, decode_utf8 and decode_utf8_backward
        "utf8" => {
            let (mut at, _) = (0usize, 0);
            while at + 4 <= input.len() {
                let len = u32::from_le_bytes([input[at], input[at+1], input[at+2], input[at+3]]) as usize;
                let rec = &input[at + 4..at + 4 + len];
                at += 4 + len;
                for off in 0..=len + 1 {
                    let (a, b) = o::decode_utf8(rec, off);
                    let (c, d) = o::decode_utf8_backward(rec, off);
                    let _ = writeln!(out, "{a:x} {b} {c:x} {d}");
                }
                out.push_str("--\n");
            }
        }
        _ => panic!("table"),
    }
    std::io::stdout().write_all(out.as_bytes()).unwrap();
}

struct Counter { events: u64, bytes: u64, track: bool }
impl RendererImpl for Counter {
    fn enter_block(&mut self, _: BlockType, _: u32, _: u32) -> JsResult<()> { self.events += 1; Ok(()) }
    fn leave_block(&mut self, _: BlockType, _: u32) -> JsResult<()> { self.events += 1; Ok(()) }
    fn enter_span(&mut self, _: SpanType, _: SpanDetail<'_>) -> JsResult<()> { self.events += 1; Ok(()) }
    fn leave_span(&mut self, _: SpanType) -> JsResult<()> { self.events += 1; Ok(()) }
    fn text(&mut self, _: TextType, c: &[u8]) -> JsResult<()> { self.events += 1; self.bytes += c.len() as u64; Ok(()) }
    fn wants_source(&self) -> bool { self.track }
    fn inline_source(&mut self, _: OFF, _: OFF) { self.events += 1; }
}

fn bench(list: &str, root: &str, reps: usize) {
    let files: Vec<Vec<u8>> = std::fs::read_to_string(list).unwrap().lines().filter(|l| l.ends_with(".md"))
        .map(|l| std::fs::read(format!("{root}/{l}")).unwrap()).collect();
    let total: usize = files.iter().map(|f| f.len()).sum();
    let (mut best_html, mut best_ev) = (f64::MAX, f64::MAX);
    let mut sink = 0usize;
    let mut fopts = Options::default();
    fopts.footnotes = true; fopts.math_blocks = true; fopts.no_single_tilde = true; fopts.micromark = true; fopts.micromark_to_the_letter = true; fopts.tasklists = false;
    for _ in 0..reps {
        let t = std::time::Instant::now();
        for f in &files { sink += render_to_html_with_options(f, Options::default()).unwrap().len(); }
        best_html = best_html.min(t.elapsed().as_secs_f64());
        let t = std::time::Instant::now();
        let mut c = Counter { events: 0, bytes: 0, track: true };
        for f in &files { let _ = render_with_renderer(f, fopts, Renderer { ptr: &mut c }); }
        best_ev = best_ev.min(t.elapsed().as_secs_f64());
        sink += c.events as usize;
    }
    println!("files {} bytes {total}", files.len());
    println!("rust html   {:.1} ms {:.1} MB/s (sink {sink})", best_html * 1e3, total as f64 / 1e6 / best_html);
    println!("rust events {:.1} ms {:.1} MB/s", best_ev * 1e3, total as f64 / 1e6 / best_ev);
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--bench") {
        let a: Vec<String> = std::env::args().collect();
        return bench(&a[2], &a[3], a[4].parse().unwrap());
    }
    if let Some(kind) = std::env::args().nth(1).and_then(|a| a.strip_prefix("--table=").map(str::to_string)) {
        let mut input = Vec::new();
        use std::io::Read;
        std::io::stdin().read_to_end(&mut input).unwrap();
        return table(&kind, &input);
    }
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let file = args.pop().expect("file");
    let mut options = Options::default();
    let (mut html, mut track, mut hooks, mut read_leaves, mut pack) = (false, false, false, false, false);
    for a in &args {
        match a.as_str() {
            "--html" => html = true,
            "--pack" => pack = true,
            "--track" => track = true,
            "--hooks" => hooks = true,
            "--read-leaves" => read_leaves = true,
            "--bare" => {
                for (name, _, set) in Options::BOOL_FIELD_SETTERS { let _ = name; set(&mut options, false); }
                options.footnotes = false; options.math_blocks = false; options.directives = false; options.no_single_tilde = false;
                options.micromark = false; options.micromark_to_the_letter = false; options.mdx = false;
            }
            s if s.starts_with('+') || s.starts_with('-') => {
                let on = s.starts_with('+');
                let name = &s[1..];
                match name {
                    "footnotes" => options.footnotes = on,
                    "math_blocks" => options.math_blocks = on,
                    "directives" => options.directives = on,
                    "no_single_tilde" => options.no_single_tilde = on,
                    "micromark" => options.micromark = on,
                    "micromark_to_the_letter" => options.micromark_to_the_letter = on,
                    "mdx" => options.mdx = on,
                    _ => {
                        let setter = Options::BOOL_FIELD_SETTERS.iter().find(|(n, _, _)| *n == name).unwrap_or_else(|| panic!("unknown option {name}"));
                        (setter.2)(&mut options, on);
                    }
                }
            }
            _ => panic!("bad arg {a}"),
        }
    }
    let text = std::fs::read(&file).expect("read");
    use std::io::Write;
    if pack {
        // [u32 length][bytes]... : one output per record, `#### i` before each
        std::panic::set_hook(Box::new(|_| {}));
        let mut out = String::new();
        let (mut at, mut i) = (0usize, 0usize);
        while at + 4 <= text.len() {
            let len = u32::from_le_bytes([text[at], text[at + 1], text[at + 2], text[at + 3]]) as usize;
            let rec = &text[at + 4..at + 4 + len];
            at += 4 + len;
            let _ = writeln!(out, "#### {i}");
            i += 1;
            let r = std::panic::catch_unwind(|| run_events(rec, options, track, hooks, read_leaves));
            match r {
                Ok(s) => out.push_str(&s),
                Err(_) => out.push_str("PANIC\n"),
            }
        }
        std::io::stdout().write_all(out.as_bytes()).unwrap();
        return;
    }
    if html {
        let out = render_to_html_with_options(&text, options).expect("render");
        std::io::stdout().write_all(&out).unwrap();
        return;
    }
    let out = run_events(&text, options, track, hooks, read_leaves);
    std::io::stdout().write_all(out.as_bytes()).unwrap();
}

fn run_events(text: &[u8], options: Options, track: bool, hooks: bool, read_leaves: bool) -> String {
    let mut d = Dump { out: String::new(), track, read_leaves };
    let res = if hooks {
        let mdx = options.mdx;
        let leaf = move |s: &LeafStart<'_>| leaf_hook(s, mdx);
        let span = |s: &SpanStart<'_>| span_hook(s);
        let ext = Extensions { leaf_bytes: if mdx { b"ie" } else { b"{" }, leaf: &leaf, span_bytes: b"$[{@:", span: &span };
        render_with_extensions(text, options, Renderer { ptr: &mut d }, ext)
    } else {
        render_with_renderer(text, options, Renderer { ptr: &mut d })
    };
    if res.is_err() { d.out.push_str("ERROR\n"); }
    d.out
}
