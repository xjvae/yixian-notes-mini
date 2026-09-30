use serde::Serialize;

/// 后端错误的统一形状：{code, message}。
/// 错误只分两级口径，不细分"哪一步错"——前端拿到的永远是可直接展示的一句话。
#[derive(Serialize, Clone, Debug)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("DB_SQL", e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        Self::new("APP", e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
