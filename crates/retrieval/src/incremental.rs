//! demo2 P3.3 (Điểm 5): content-addressed incremental indexing.
//!
//! Nguồn ý tưởng: `refer_project/ai-tools/continue` (Apache-2.0) —
//! `core/indexing/CodebaseIndexer.ts` đặt `cacheKey = hash(nội dung)`, nên đổi
//! branch chỉ re-index phần thay đổi thay vì dựng lại cả kho.
//!
//! Trước demo2, `BM25Index::build()` nhận toàn bộ chunk và dựng lại từ đầu.
//! Với kho 10.000 chunk, mỗi lần đổi một file cũng phải làm lại tất cả.
//!
//! Std-only: hash dùng `DefaultHasher` của std, không thêm dependency nào,
//! để `cargo test` vẫn chạy offline như trước.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::BM25Index;

/// Hash nội dung — content-addressed key của một file.
pub fn content_hash(content: &str) -> u64 {
    let mut h = DefaultHasher::new();
    content.hash(&mut h);
    h.finish()
}

/// Số chunk mà một file sẽ sinh ra. Dùng chung để kế hoạch và cache luôn
/// khớp — nếu hai chỗ ghi khác nhau thì kế hoạch báo sai ngay.
fn chunk_count_of(content: &str) -> usize {
    content.chars().count().div_ceil(CHUNK_CHARS).max(1)
}

/// Độ dài một chunk (ký tự).
const CHUNK_CHARS: usize = 300;

/// Dấu vân tay của một file tại thời điểm index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFingerprint {
    pub hash: u64,
    pub chunk_count: usize,
}

/// Kế hoạch re-index, tính từ trạng thái cũ và trạng thái mới.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IncrementalPlan {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
    pub unchanged: Vec<String>,
    /// Tổng chunk trong kho mới.
    pub total_chunks: usize,
    /// Số chunk thực sự phải dựng lại.
    pub chunks_to_reindex: usize,
    /// Số chunk có thể tái dùng nguyên vẹn.
    pub chunks_reused: usize,
}

impl IncrementalPlan {
    /// Tỉ lệ chunk phải dựng lại — chỉ số chính của Điểm 5.
    pub fn reindex_ratio(&self) -> f64 {
        if self.total_chunks == 0 {
            return 0.0;
        }
        self.chunks_to_reindex as f64 / self.total_chunks as f64
    }

    /// Có đáng bỏ qua lần index này không (không có gì thay đổi).
    pub fn is_noop(&self) -> bool {
        self.added.is_empty() && self.modified.is_empty() && self.removed.is_empty()
    }
}

/// Theo dõi trạng thái file đã index.
#[derive(Debug, Default, Clone)]
pub struct FileTracker {
    entries: HashMap<String, FileFingerprint>,
}

impl FileTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// So sánh với trạng thái mới (`path -> nội dung`) và lập kế hoạch.
    ///
    /// Hash mỗi file ĐÚNG MỘT LẦN — trước đây vòng tính `total` hash lại toàn
    /// bộ lần nữa, tức là gấp đôi chi phí trên kho lớn.
    pub fn plan(&self, current: &HashMap<String, String>) -> IncrementalPlan {
        let mut plan = IncrementalPlan::default();
        let mut total_chunks = 0usize;

        for (path, content) in current {
            let hash = content_hash(content);
            let chunk_count = chunk_count_of(content);

            match self.entries.get(path) {
                None => {
                    plan.added.push(path.clone());
                    plan.chunks_to_reindex += chunk_count;
                    total_chunks += chunk_count;
                }
                Some(prev) if prev.hash != hash => {
                    plan.modified.push(path.clone());
                    // File đổi nội dung: số chunk cũ bị thay bằng số mới.
                    plan.chunks_to_reindex += chunk_count;
                    total_chunks += chunk_count;
                }
                Some(prev) => {
                    plan.unchanged.push(path.clone());
                    // File không đổi: dùng lại số chunk đã biết, không cắt lại.
                    plan.chunks_to_reindex += 0;
                    total_chunks += prev.chunk_count;
                }
            }
        }

        for path in self.entries.keys() {
            if !current.contains_key(path) {
                plan.removed.push(path.clone());
            }
        }

        plan.total_chunks = total_chunks;
        plan.chunks_reused = total_chunks.saturating_sub(plan.chunks_to_reindex);

        // HashMap duyệt không có thứ tự ổn định giữa các process (seed ngẫu
        // nhiên). Không sắp xếp thì log/JSON của plan đổi mỗi lần chạy, và
        // `PartialEq` trên IncrementalPlan trở nên vô nghĩa.
        plan.added.sort();
        plan.modified.sort();
        plan.unchanged.sort();
        plan.removed.sort();

        plan
    }

    /// Ghi nhận trạng thái sau khi đã index xong.
    pub fn commit(&mut self, current: &HashMap<String, String>) {
        let mut next = HashMap::with_capacity(current.len());
        for (path, content) in current {
            next.insert(
                path.clone(),
                FileFingerprint {
                    hash: content_hash(content),
                    chunk_count: chunk_count_of(content),
                },
            );
        }
        self.entries = next;
    }
}

/// Kết quả một lần re-index, kèm thời gian đo được.
#[derive(Debug, Clone)]
pub struct ReindexReport {
    pub plan: IncrementalPlan,
    pub elapsed_us: u128,
    /// Số TỪ KHOÁ đang có trong chỉ mục — KHÔNG phải số chunk.
    pub indexed_terms: usize,
    /// Số chunk thực sự đưa vào chỉ mục.
    pub chunk_count: usize,
    /// Số chunk phải tokenize lại (0 khi không có gì đổi).
    pub chunks_retokenized: usize,
}

/// Một chunk đã tokenize sẵn — đơn vị cache thật sự tiết kiệm công.
type TokenizedChunk = (std::collections::HashMap<String, u32>, usize);

/// BM25 index biết tự chỉ tokenize lại phần thay đổi.
///
/// Cơ chế: cache `path -> Vec<TokenizedChunk>` từ lần index trước. File không
/// đổi thì lấy lại số đếm từ đã tính — KHÔNG chạy lại `tokenize`, đây mới là
/// phần tốn thời gian thật sự. Trước đây cache chỉ giữ text thô, nên `build`
/// vẫn phải tokenize 100% và mốc "incremental" không tăng tốc được gì.
pub struct IncrementalIndex {
    tracker: FileTracker,
    index: BM25Index,
    /// path -> các chunk đã tokenize
    cache: HashMap<String, Vec<TokenizedChunk>>,
    k1: f64,
    b: f64,
}

impl Default for IncrementalIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl IncrementalIndex {
    pub fn new() -> Self {
        Self {
            tracker: FileTracker::new(),
            index: BM25Index::build(&[], 1.2, 0.75),
            cache: HashMap::new(),
            k1: 1.2,
            b: 0.75,
        }
    }

    /// Lập kế hoạch mà KHÔNG index — dùng để dự báo trước.
    pub fn preview(&self, files: &HashMap<String, String>) -> IncrementalPlan {
        self.tracker.plan(files)
    }

    /// Tokenize một file thành các chunk (số đếm từ + độ dài).
    fn tokenize_file(content: &str) -> Vec<TokenizedChunk> {
        split_demo(content)
            .into_iter()
            .map(|text| {
                let mut seen: HashMap<String, u32> = HashMap::new();
                for token in crate::tokenize(&text) {
                    *seen.entry(token).or_insert(0) += 1;
                }
                (seen, text.len())
            })
            .collect()
    }

    /// Index theo kế hoạch, chỉ tokenize lại phần thay đổi.
    pub fn reindex(&mut self, files: &HashMap<String, String>, k1: f64, b: f64) -> ReindexReport {
        let start = std::time::Instant::now();

        // NaN/Infinity phải lọc ngay từ cửa: `(NaN - x).abs() > EPSILON` là
        // false nên params_changed không thấy, nhưng lần rebuild có kèm thay
        // đổi nội dung sẽ dùng luôn NaN → mọi điểm BM25 thành NaN, và vì
        // self.k1 không được cập nhật nên độc chất dai dẳng sang các lần sau.
        let k1 = if k1.is_finite() && k1 > 0.0 { k1 } else { self.k1 };
        let b = if b.is_finite() && (0.0..=1.0).contains(&b) { b } else { self.b };

        let plan = self.tracker.plan(files);

        // Tham số BM25 đổi thì phải dựng lại, kể cả khi nội dung không đổi —
        // nếu không, người gọi sẽ tưởng đã áp tham số mới nhưng thực tế index
        // vẫn giữ tham số cũ, và không có cách nào sửa lại.
        let params_changed =
            (k1 - self.k1).abs() > f64::EPSILON || (b - self.b).abs() > f64::EPSILON;

        let mut retokenized = 0usize;
        if !plan.is_noop() || params_changed {
            if params_changed {
                self.k1 = k1;
                self.b = b;
            }

            for path in &plan.removed {
                self.cache.remove(path);
            }

            // Chỉ file thay đổi mới tokenize lại.
            let mut changed: Vec<&String> = plan.added.iter().chain(plan.modified.iter()).collect();
            changed.sort();
            changed.dedup();
            for path in changed {
                if let Some(content) = files.get(path) {
                    self.cache
                        .insert(path.clone(), Self::tokenize_file(content));
                    retokenized += chunk_count_of(content);
                }
            }

            // Gom theo đường dẫn để id chunk ổn định giữa các lần index.
            let mut paths: Vec<&String> = files.keys().collect();
            paths.sort();
            let mut tokenized: Vec<HashMap<String, u32>> = Vec::with_capacity(plan.total_chunks);
            let mut lengths: Vec<usize> = Vec::with_capacity(plan.total_chunks);
            let mut missing = 0usize;
            for path in paths {
                match self.cache.get(path) {
                    Some(parts) => {
                        for (counts, len) in parts {
                            tokenized.push(counts.clone());
                            lengths.push(*len);
                        }
                    }
                    // Cache lệch tracker: file biến mất khỏi chỉ mục mà không
                    // báo. Đếm lại thay vì nuốt im lặng.
                    None => missing += 1,
                }
            }
            debug_assert_eq!(missing, 0, "{missing} file không có trong cache");

            self.index = BM25Index::from_token_counts(&tokenized, &lengths, k1, b);
            self.tracker.commit(files);
        }

        ReindexReport {
            plan,
            elapsed_us: start.elapsed().as_micros(),
            indexed_terms: self.index.size(),
            chunk_count: self.cache.values().map(|v| v.len()).sum(),
            chunks_retokenized: retokenized,
        }
    }

    pub fn index(&self) -> &BM25Index {
        &self.index
    }
}

/// Cắt nội dung thành chunk để tokenize (kích thước khớp `chunk_count_of`).
fn split_demo(content: &str) -> Vec<String> {
    let chars: Vec<char> = content.chars().collect();
    if chars.is_empty() {
        return vec![String::new()];
    }
    chars
        .chunks(CHUNK_CHARS)
        .map(|c| c.iter().collect::<String>())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus() -> HashMap<String, String> {
        let mut m = HashMap::new();
        for i in 0..200 {
            m.insert(
                format!("src/mod{}.ts", i),
                format!("export const value{} = {}; fn compute{}() {{}}", i, i, i).repeat(20),
            );
        }
        m
    }

    #[test]
    fn hash_stable_across_calls() {
        assert_eq!(content_hash("abc"), content_hash("abc"));
        assert_ne!(content_hash("abc"), content_hash("abd"));
    }

    #[test]
    fn first_pass_indexes_everything() {
        let tracker = FileTracker::new();
        let plan = tracker.plan(&corpus());
        assert_eq!(plan.added.len(), 200);
        assert_eq!(plan.reindex_ratio(), 1.0);
    }

    #[test]
    fn no_change_is_a_noop() {
        let files = corpus();
        let mut tracker = FileTracker::new();
        tracker.commit(&files);
        let plan = tracker.plan(&files);
        assert!(plan.is_noop());
        assert_eq!(plan.unchanged.len(), 200);
        assert_eq!(plan.chunks_to_reindex, 0);
    }

    #[test]
    fn one_changed_file_reindexes_only_that_file() {
        let mut files = corpus();
        let mut tracker = FileTracker::new();
        tracker.commit(&files);

        files.insert(
            "src/mod7.ts".to_string(),
            "export const changed = 1;".repeat(400),
        );

        let plan = tracker.plan(&files);
        assert_eq!(plan.modified.len(), 1);
        assert_eq!(plan.unchanged.len(), 199);
        assert!(plan.chunks_to_reindex < plan.total_chunks / 10);
    }

    #[test]
    fn unchanged_files_are_not_retokenized() {
        // Đây là bằng chứng "incremental có thật": số chunk bị tokenize lại
        // phải bằng 0 khi không có gì đổi. Trước khi sửa, chỉ số này không
        // tồn tại vì `build` luôn tokenize lại 100%.
        let files = corpus();
        let mut idx = IncrementalIndex::new();
        idx.reindex(&files, 1.2, 0.75);

        let again = idx.reindex(&files, 1.2, 0.75);
        assert_eq!(again.chunks_retokenized, 0);
        assert_eq!(again.plan.chunks_to_reindex, 0);
    }

    #[test]
    fn one_changed_file_retokenizes_only_its_chunks() {
        let mut files = corpus();
        let mut idx = IncrementalIndex::new();
        idx.reindex(&files, 1.2, 0.75);

        files.insert(
            "src/mod7.ts".to_string(),
            "export const changed = 1;".repeat(50),
        );
        let r = idx.reindex(&files, 1.2, 0.75);

        // 1 file đổi trong 200 → chỉ chunk của file đó được tokenize lại.
        assert_eq!(r.plan.modified.len(), 1);
        let all_chunks: usize = files.values().map(|c| chunk_count_of(c)).sum();
        assert!(
            r.chunks_retokenized * 20 < all_chunks,
            "tokenize lại {} / {} chunk — quá nhiều",
            r.chunks_retokenized,
            all_chunks
        );
    }

    #[test]
    fn changing_bm25_params_rebuilds_even_when_nothing_changed() {
        // Trước đây k1/b chỉ dùng khi có thay đổi nội dung, nên gọi lại với
        // tham số khác mà file không đổi thì tham số bị bỏ qua vĩnh viễn.
        let files = corpus();
        let mut idx = IncrementalIndex::new();
        idx.reindex(&files, 1.2, 0.0);

        let base: f64 = idx
            .index()
            .query("value5")
            .first()
            .map(|x| x.1)
            .unwrap_or(0.0);
        let with_b075 = idx.reindex(&files, 1.2, 0.75);
        let after: f64 = idx
            .index()
            .query("value5")
            .first()
            .map(|x| x.1)
            .unwrap_or(0.0);

        assert!(
            (base - after).abs() > 1e-9,
            "đổi b từ 0.0 sang 0.75 phải đổi kết quả, nhưng không — tham số bị bỏ qua"
        );
        assert!(with_b075.plan.is_noop());
    }

    #[test]
    fn plan_order_is_stable_across_calls() {
        // HashMap seed đổi mỗi process; nếu không sort, hai lần gọi plan trên
        // cùng trạng thái có thể cho vector khác nhau.
        let files = corpus();
        let tracker = FileTracker::new();
        let a = tracker.plan(&files);
        let b = tracker.plan(&files);
        assert_eq!(a, b);
    }

    #[test]
    fn deleted_file_is_removed() {
        let mut files = corpus();
        let mut tracker = FileTracker::new();
        tracker.commit(&files);

        files.remove("src/mod3.ts");
        let plan = tracker.plan(&files);
        assert_eq!(plan.removed, vec!["src/mod3.ts".to_string()]);
    }

    #[test]
    fn branch_switch_reindexes_only_the_difference() {
        // Mô phỏng đổi branch: 95/200 file khác nhau, kích thước tương đương
        // (đổi nội dung chứ không phình ra). Tỉ lệ chunk khi đó mới phản ánh
        // đúng công việc bỏ qua, chứ không bị méo bởi việc file to lên.
        let base = corpus();
        let mut tracker = FileTracker::new();
        tracker.commit(&base);

        let mut branch = HashMap::new();
        for (path, content) in &base {
            let i: usize = path
                .trim_start_matches("src/mod")
                .trim_end_matches(".ts")
                .parse()
                .unwrap();
            if i < 95 {
                // Cùng độ dài, khác nội dung → cùng số chunk.
                branch.insert(
                    path.clone(),
                    format!("export const renamed{} = {}; fn renamed{}() {{}}", i, i, i).repeat(20),
                );
            } else {
                branch.insert(path.clone(), content.clone());
            }
        }

        let plan = tracker.plan(&branch);
        assert_eq!(plan.modified.len(), 95);
        assert_eq!(plan.unchanged.len(), 105);
        assert!(
            plan.reindex_ratio() < 0.55,
            "95/200 file đổi mà phải reindex cả kho thì vô nghĩa — ratio = {}",
            plan.reindex_ratio()
        );
    }

    #[test]
    fn reindex_updates_index_and_reports_size() {
        let mut idx = IncrementalIndex::new();
        let files = corpus();
        let r1 = idx.reindex(&files, 1.2, 0.75);
        assert!(r1.indexed_terms > 0);
        assert!(r1.chunk_count > 0);
        assert_eq!(r1.plan.added.len(), 200);

        // Lần hai không có gì đổi → không reindex, index giữ nguyên.
        let r2 = idx.reindex(&files, 1.2, 0.75);
        assert!(r2.plan.is_noop());
        assert_eq!(r2.indexed_terms, r1.indexed_terms);
        assert_eq!(r2.chunks_retokenized, 0);
    }

    #[test]
    fn dedup_same_content_at_two_paths_both_kept() {
        // Hai đường dẫn khác nhau là hai tài liệu khác — không được gộp.
        let mut files = HashMap::new();
        files.insert("a.ts".to_string(), "x".repeat(600));
        files.insert("b.ts".to_string(), "x".repeat(600));
        let tracker = FileTracker::new();
        let plan = tracker.plan(&files);
        assert_eq!(plan.added.len(), 2);
    }
}
