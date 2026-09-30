// ErrorBoundary — 每个入口都挂在最外层。渲染期崩溃给一句可读的话 + 保留现场
// （错误摘要），绝不让用户面对一块白屏。

import { Component, type ErrorInfo, type ReactNode } from "react";
import { logger } from "@/platform/logger";
import { describeError } from "@/platform/errors";

interface Props {
  /** 窗口名，出现在「XX窗口出错了」文案里 */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error("boundary", `${this.props.label}渲染崩溃：${error.message}`);
    logger.error("boundary", `组件栈：${info.componentStack ?? "（无）"}`);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-red-50 p-6 text-center text-sm text-red-800">
        <div className="font-semibold">{this.props.label}窗口出错了</div>
        <div className="max-w-full text-xs opacity-80">{describeError(error)}</div>
        <div className="text-xs opacity-60">关闭这扇窗重试；反复出现请把日志发给我</div>
      </div>
    );
  }
}
