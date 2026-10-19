//! Historique borné d'une session côté Rust (mode réaliste : rejoué au changement de session).

use std::collections::VecDeque;
use std::sync::Arc;

/// Garde les derniers `cap` octets (au moins), par morceaux partagés : pousser ne copie rien.
pub struct ByteRing {
    chunks: VecDeque<Arc<Vec<u8>>>,
    size: usize,
    cap: usize,
}

impl ByteRing {
    pub fn new(cap: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            size: 0,
            cap,
        }
    }

    pub fn push(&mut self, chunk: Arc<Vec<u8>>) {
        if chunk.is_empty() {
            return;
        }
        self.size += chunk.len();
        self.chunks.push_back(chunk);
        while self.chunks.len() > 1 && self.size - self.chunks[0].len() >= self.cap {
            self.size -= self.chunks.pop_front().unwrap().len();
        }
    }

    /// Instantané bon marché (copie des pointeurs) ; `concat_tail` fait la copie hors verrou.
    pub fn chunks(&self) -> Vec<Arc<Vec<u8>>> {
        self.chunks.iter().cloned().collect()
    }
}

/// Les `cap` derniers octets des morceaux, d'un seul tenant.
pub fn concat_tail(chunks: &[Arc<Vec<u8>>], cap: usize) -> Vec<u8> {
    let all: Vec<u8> = chunks.iter().flat_map(|c| c.iter().copied()).collect();
    let skip = all.len().saturating_sub(cap);
    all[skip..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_last_cap_bytes() {
        let mut r = ByteRing::new(10);
        for i in 0..10u8 {
            r.push(Arc::new(vec![i; 4]));
        }
        let tail = concat_tail(&r.chunks(), 10);
        assert_eq!(tail.len(), 10);
        assert_eq!(&tail[tail.len() - 4..], &[9, 9, 9, 9]);
        assert!(r.chunks().len() <= 4);
        // Un morceau plus gros que la capacité est gardé seul.
        r.push(Arc::new(vec![7; 50]));
        assert_eq!(r.chunks().len(), 1);
        assert_eq!(concat_tail(&r.chunks(), 10), vec![7; 10]);
    }
}
