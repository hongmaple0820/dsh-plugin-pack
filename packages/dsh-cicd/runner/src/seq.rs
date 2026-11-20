/// Global, monotonically increasing log line sequence allocator.
///
/// `seq` numbers are per-task and shared across stdout and stderr: every
/// line, whichever stream it came from, takes the next value.
#[derive(Debug, Clone)]
pub struct SeqAlloc {
    next: u64,
}

impl SeqAlloc {
    pub fn new(start: u64) -> Self {
        Self { next: start }
    }

    pub fn next(&mut self) -> u64 {
        let v = self.next;
        self.next = self.next.wrapping_add(1);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleaved_allocation_is_strictly_monotonic() {
        let mut alloc = SeqAlloc::new(1);
        // Simulate two producers (stdout/stderr) interleaving through one
        // shared allocator with an occasional extra line on one side.
        let mut seqs: Vec<(char, u64)> = vec![];
        for i in 0..100 {
            if i % 2 == 0 {
                seqs.push(('a', alloc.next()));
            } else {
                seqs.push(('b', alloc.next()));
                if i % 7 == 0 {
                    seqs.push(('b', alloc.next()));
                }
            }
        }
        let values: Vec<u64> = seqs.iter().map(|(_, s)| *s).collect();
        assert_eq!(values[0], 1);
        assert!(
            values.windows(2).all(|w| w[0] + 1 == w[1]),
            "seq must increase by exactly 1 per line: {values:?}"
        );
        assert_eq!(alloc.next(), values.len() as u64 + 1);
    }

    #[test]
    fn starts_at_given_value() {
        let mut alloc = SeqAlloc::new(5);
        assert_eq!(alloc.next(), 5);
        assert_eq!(alloc.next(), 6);
    }
}
