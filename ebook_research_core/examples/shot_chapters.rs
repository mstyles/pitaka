use ebook_research_core::semantic::Embedder;
use ebook_research_core::{import_book, index_book, open_db, search_chapters};
use std::ops::ControlFlow;

fn main() {
    let embedder = Embedder::load().expect("load");
    let path = std::env::temp_dir().join("shot_chapters.db");
    let _ = std::fs::remove_file(&path);
    let mut conn = open_db(path.to_str().unwrap()).unwrap();
    import_book(&mut conn, "demo/verses-of-the-senior-nuns.epub").unwrap();
    index_book(&mut conn, 1, &embedder, &mut |_, _| {
        ControlFlow::Continue(())
    })
    .unwrap();
    let m = search_chapters(&conn, "the peace of letting go", &embedder, 10).unwrap();
    println!("{}", serde_json::to_string(&m).unwrap());
}
