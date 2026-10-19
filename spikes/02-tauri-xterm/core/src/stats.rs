//! Statistiques élémentaires sur des séries de durées (ms).

use serde::Serialize;

/// Percentile `p` (0–100) par interpolation linéaire ; `None` si la série est vide.
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let rank = (p / 100.0).clamp(0.0, 1.0) * (v.len() - 1) as f64;
    let (lo, hi) = (rank.floor() as usize, rank.ceil() as usize);
    Some(v[lo] + (v[hi] - v[lo]) * (rank - lo as f64))
}

pub fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Summary {
    pub n: usize,
    pub mean: Option<f64>,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
    pub max: Option<f64>,
}

impl Summary {
    pub fn of(values: &[f64]) -> Self {
        Self {
            n: values.len(),
            mean: mean(values),
            p50: percentile(values, 50.0),
            p95: percentile(values, 95.0),
            p99: percentile(values, 99.0),
            max: values.iter().copied().reduce(f64::max),
        }
    }
}

/// Médiane, minimum et maximum d'une mesure sur plusieurs répétitions.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Spread {
    pub median: f64,
    pub min: f64,
    pub max: f64,
    pub n: usize,
}

impl Spread {
    pub fn of(values: &[f64]) -> Option<Self> {
        Some(Self {
            median: percentile(values, 50.0)?,
            min: values.iter().copied().reduce(f64::min)?,
            max: values.iter().copied().reduce(f64::max)?,
            n: values.len(),
        })
    }
}

/// Part (en %) des valeurs strictement supérieures à `threshold`.
pub fn share_above(values: &[f64], threshold: f64) -> Option<f64> {
    (!values.is_empty()).then(|| {
        100.0 * values.iter().filter(|&&v| v > threshold).count() as f64 / values.len() as f64
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles() {
        let v: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&v, 0.0), Some(1.0));
        assert_eq!(percentile(&v, 100.0), Some(100.0));
        assert!((percentile(&v, 50.0).unwrap() - 50.5).abs() < 1e-9);
        assert!((percentile(&v, 95.0).unwrap() - 95.05).abs() < 1e-9);
        assert_eq!(percentile(&[], 50.0), None);
        assert_eq!(percentile(&[7.0], 99.0), Some(7.0));
        // L'ordre d'entrée n'importe pas.
        assert_eq!(percentile(&[3.0, 1.0, 2.0], 50.0), Some(2.0));
    }

    #[test]
    fn summary_and_share() {
        let frames = [16.7, 16.6, 16.8, 40.0, 16.7];
        let s = Summary::of(&frames);
        assert_eq!(s.n, 5);
        assert_eq!(s.max, Some(40.0));
        assert_eq!(share_above(&frames, 33.0), Some(20.0));
        assert_eq!(share_above(&[], 33.0), None);
        assert_eq!(Summary::of(&[]).p95, None);
        let sp = Spread::of(&[30.0, 10.0, 20.0]).unwrap();
        assert_eq!((sp.median, sp.min, sp.max, sp.n), (20.0, 10.0, 30.0, 3));
        assert_eq!(Spread::of(&[]), None);
    }
}
