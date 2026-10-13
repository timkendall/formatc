use std::collections::HashMap;

pub struct IndexMap { m: HashMap<Vec<u8>, usize> }
impl IndexMap {
    pub fn get_index(&self, k: &[u8]) -> Option<usize> { self.m.get(k).copied() }
}
pub struct StringSet { pub map: IndexMap }
impl StringSet {
    pub fn new() -> StringSet { StringSet { map: IndexMap { m: HashMap::new() } } }
    pub fn contains(&self, k: &[u8]) -> bool { self.map.m.contains_key(k) }
    pub fn insert(&mut self, k: &[u8]) -> Result<(), bun_alloc::AllocError> {
        let n = self.map.m.len();
        self.map.m.entry(k.to_vec()).or_insert(n);
        Ok(())
    }
}

pub struct Gop<'a> { pub found_existing: bool, pub value_ptr: &'a mut u32 }
pub struct StringHashMap<V> { m: HashMap<Vec<u8>, V> }
impl<V> Default for StringHashMap<V> { fn default() -> Self { StringHashMap { m: HashMap::new() } } }
impl StringHashMap<u32> {
    pub fn get_or_put(&mut self, k: &[u8]) -> Result<Gop<'_>, bun_alloc::AllocError> {
        let found = self.m.contains_key(k);
        let v = self.m.entry(k.to_vec()).or_insert(0);
        Ok(Gop { found_existing: found, value_ptr: v })
    }
}

#[derive(Clone, Copy)]
pub struct ByteSet([bool; 256]);
impl ByteSet {
    pub const fn of(bytes: &[u8]) -> ByteSet {
        let mut a = [false; 256];
        let mut i = 0;
        while i < bytes.len() { a[bytes[i] as usize] = true; i += 1; }
        ByteSet(a)
    }
    pub const fn with_range(mut self, lo: u8, hi: u8) -> ByteSet {
        let mut c = lo as usize;
        while c <= hi as usize { self.0[c] = true; c += 1; }
        self
    }
    pub const fn init_empty() -> ByteSet { ByteSet([false; 256]) }
    pub fn set(&mut self, i: usize) { self.0[i] = true; }
    pub fn has(&self, b: u8) -> bool { self.0[b as usize] }
}
