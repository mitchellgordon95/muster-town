import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../clientErrors";
import { store } from "../state";

/**
 * Catches a panel's render crash: shows "This panel crashed" with a Close button, and reports it once to the town
 * (POST /api/client-errors, gr_cyqzweu6ed) with the panel's kind.
 */
export class PanelBoundary extends Component<{ children: ReactNode; panel: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  componentDidCatch(e: Error, _info: ErrorInfo) { reportClientError("panel", e, this.props.panel); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-body">
        <div className="error-line">This panel crashed: {this.state.error}</div>
        <button className="btn" onClick={() => store.open(null)}>Close</button>
      </div>
    );
  }
}

/** `#/crash-test`: a panel that throws on purpose, so a human can check that a crash is recorded (gr_cyqzweu6ed kr_jus9bzg48h). */
export function CrashTestPanel(): never {
  throw new Error("crash test: this panel throws on purpose");
}
