pub struct AppState {
    pub manager_addr: String,
}

impl AppState {
    pub fn new(manager_addr: String) -> Self {
        Self { manager_addr }
    }
}
