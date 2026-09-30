// 错误 — 后端 AppError 的前端形状与展示口径。只分"身份问题"与"失败"两级文案，
// 不细分哪一步错（与 Rust 侧错误分级同口径）。

export interface AppError {
  code: string;
  message: string;
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as AppError).code === "string" &&
    typeof (value as AppError).message === "string"
  );
}

/** 把任意抛出物折成可展示文案。未知错误不猜原因，如实透出字符串 */
export function describeError(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
