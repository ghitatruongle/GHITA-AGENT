#![expect(dead_code)]

use napi_derive::napi;

#[napi(object)]
pub struct PatchSummary {
    pub applied: Vec<String>,
    pub skipped: Vec<String>,
    pub partial: bool,
}

#[napi]
pub fn apply_patch(patch_text: String, cwd: String) -> napi::Result<PatchSummary> {
    crate::apply(&patch_text, std::path::Path::new(&cwd))
        .map(|r| PatchSummary {
            applied: r.applied,
            skipped: r.skipped,
            partial: r.partial,
        })
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{e}")))
}

#[napi]
pub fn patch_available() -> bool {
    true
}
