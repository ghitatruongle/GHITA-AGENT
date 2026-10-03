use ghita_retrieval::incremental::IncrementalIndex;
use std::collections::HashMap;
use std::time::Instant;

fn corpus(n: usize) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for i in 0..n {
        m.insert(
            format!("src/mod{}.ts", i),
            format!("export const value{} = {}; fn compute{}() {{}}", i, i, i).repeat(80),
        );
    }
    m
}

fn main() {
    let base = corpus(400);
    let mut idx = IncrementalIndex::new();

    let t0 = Instant::now();
    let r1 = idx.reindex(&base, 1.2, 0.75);
    let cold = t0.elapsed();

    let mut one = base.clone();
    one.insert(
        "src/mod7.ts".to_string(),
        "export const changed = 1;".repeat(80),
    );
    let t1 = Instant::now();
    let r2 = idx.reindex(&one, 1.2, 0.75);
    let warm_one = t1.elapsed();

    let mut half = base.clone();
    for i in 0..200 {
        half.insert(
            format!("src/mod{}.ts", i),
            format!("// bien thai {} xin chao", i).repeat(80),
        );
    }
    let t2 = Instant::now();
    let r3 = idx.reindex(&half, 1.2, 0.75);
    let warm_half = t2.elapsed();

    println!(
        "Lan dau (lanh)         : {:>10?}  tokenize lai {} chunk",
        cold, r1.chunks_retokenized
    );
    println!(
        "Doi 1/400 file         : {:>10?}  tokenize lai {} chunk",
        warm_one, r2.chunks_retokenized
    );
    println!(
        "Doi 200/400 file       : {:>10?}  tokenize lai {} chunk",
        warm_half, r3.chunks_retokenized
    );
    println!();
    println!("chunk gop tong          : {}", r1.chunk_count);
    println!("ti le reindex 1 file   : {:.4}", r2.plan.reindex_ratio());
    println!("ti le reindex 200 file : {:.4}", r3.plan.reindex_ratio());
}
